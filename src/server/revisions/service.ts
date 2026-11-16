import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { recordAuditEvent } from "@/server/audit-log";
import { db } from "@/server/db/client";
import { revisions } from "@/server/db/schema";
import { enqueue } from "@/server/jobs/enqueue";
import { analyzeImport } from "@/server/package-io/analyze";
import { zipPackage } from "@/server/packages/build";
import { fill } from "@/server/packages/paths";
import { createPlan as defaultCreatePlan, type CreatePlan } from "@/server/plans";
import type { Permission } from "@/server/policy";
import type { Space } from "@/server/spaces/queries";
import { sha256Hex } from "@/server/sync/content";
import { errorsOf, type ValidationResult } from "@/server/validation/types";
import { layoutOf, liveRefs, readContext } from "./context";
import { prepareCreateRevision, type CreateRevisionRequest } from "./create";
import { createRevisionJob, saveRevisionJob } from "./jobs";
import { readRevisionPackage } from "./package-files";
import { revisionPlanInput } from "./plan-input";
import { loadRevisionScope } from "./scope";
import { findingsForChangelog, getRevision, listChanges, planStates, updateRevision } from "./queries";
import { prepareSaveRevision, type SaveRevisionRequest } from "./save";
import { exportBlocker, OPEN_PLAN_STATES, planBlocker } from "./states";
import { RevisionError, type RevisionActor } from "./types";

/**
 * Service functions behind the revision Server Actions and Route Handlers
 * Each caller checks REVISION_PERMISSIONS with the DAL for the
 * space first, parses its input, then calls one of these with the actor.
 */

/** A claim on a revision while its plan is created; older claims are treated as abandoned. */
const PLAN_CLAIM_STALE_MS = 5 * 60 * 1000;

export const REVISION_PERMISSIONS = {
  /** Revision list and detail, linkable findings */
  read: "audits.read",
  /** Create, save and abandon */
  build: "revisions.build",
  /** Download the revision as a package zip: a read, like exporting a release as a package */
  export: "audits.read",
  /** Create a plan from a revision */
  plan: "plans.create",
} as const satisfies Record<string, Permission>;

/** Validate and enqueue the create job. Returns the revision ID and the job_runs ID for progress polling. */
export async function requestCreateRevision(space: Space, request: CreateRevisionRequest, actor: RevisionActor): Promise<{ revisionId: string; runId: string; branch: string }> {
  const row = await prepareCreateRevision(space, request, actor);
  try {
    const runId = await enqueue(createRevisionJob, { revisionId: row.id }, { actor: { email: actor.email }, spaceId: space.id });
    await updateRevision(row.id, { createRunId: runId });
    return { revisionId: row.id, runId, branch: row.branch };
  } catch (err) {
    await db().delete(revisions).where(and(eq(revisions.id, row.id), eq(revisions.state, "creating")));
    throw err;
  }
}

/** Validate and enqueue a save. Returns the job_runs ID and the change ID the save will have. */
export async function requestSaveRevision(space: Space, revisionId: string, request: SaveRevisionRequest, actor: RevisionActor): Promise<{ runId: string; changeId: string }> {
  const { policy } = await readContext(space);
  const { row, input } = await prepareSaveRevision(space, policy, revisionId, request, actor);
  const runId = await enqueue(saveRevisionJob, input, { actor: { email: actor.email }, spaceId: space.id });
  await updateRevision(row.id, { lastSaveRunId: runId });
  return { runId, changeId: input.changeId };
}

export interface CreateRevisionPlanResult {
  planId: string;
  checkRunId: string;
  items: number;
  /** Validation warnings of the mapping against the live space */
  warnings: ValidationResult[];
}

/**
 * Create a plan from a revision: refused unless the latest build passed at
 * the branch head and no plan from it is open or applied. The package at the
 * head is mapped against the live space with the package import mapping; the
 * plan holds the assets the revision changed against its base (scope.ts),
 * each with its base version, and its notes name the assets that changed
 * only in the live space. It goes to createPlan with origin
 * { kind: "revision" }. The caller holds `plans.create` on the space.
 */
export async function createPlanFromRevision(
  space: Space,
  revisionId: string,
  actor: RevisionActor,
  opts: { reason?: string | null; title?: string | null } = {},
  deps: { createPlan?: CreatePlan } = {},
): Promise<CreateRevisionPlanResult> {
  const row = await getRevision(space.id, revisionId);
  if (!row) throw new RevisionError("not-found", "There is no such revision in this space.");
  const plan = row.planId ? ((await planStates([row.planId])).get(row.planId) ?? null) : null;
  const blocked = planBlocker(row, plan);
  if (blocked) {
    const code = plan && (OPEN_PLAN_STATES as readonly string[]).includes(plan.state) ? "plan-open" : row.state === "open" ? "build-failed" : "not-open";
    throw new RevisionError(code, blocked, {}, row.latestBuild ? errorsOf(row.latestBuild.results) : []);
  }
  const { repo, policy } = await readContext(space);
  const layout = layoutOf(policy, row.layout);
  const head = row.headCommit!;
  const contents = await readRevisionPackage(repo, head, row.packageDir, row.packageName);
  const { index } = await liveRefs(space, policy);
  const analysis = analyzeImport({ contents, layout, policy, live: index.entries, historyCommit: index.historyCommit });
  if (!analysis.summary.ok) {
    const errors = analysis.results.validation.filter((r) => r.level === "error");
    throw new RevisionError("build-failed", `The package has ${errors.length} validation ${errors.length === 1 ? "error" : "errors"} against the live space. Fix ${errors.length === 1 ? "it" : "them"} and save again.`, {}, errors);
  }
  const changes = await listChanges(row.id);
  const findings = new Map((await findingsForChangelog(space.id, changes.flatMap((c) => c.findingIds))).map((f) => [f.id, f]));
  const scope = await loadRevisionScope({ repo, policy, layout, spaceAlias: space.alias, row, head: contents, analysis, live: index.entries });
  const base = { kind: row.base.kind, name: row.base.kind === "release" ? row.base.name : null };
  const input = revisionPlanInput({ policy, spaceId: space.id, spaceAlias: space.alias, revision: row, analysis, changes, findings, scope, base });
  if (opts.title?.trim()) input.title = opts.title.trim();
  if (opts.reason?.trim()) input.reason = opts.reason.trim();
  if (!input.items.length) {
    if (scope && scope.changed.length === 0) throw new RevisionError("nothing-to-plan", `No asset in the revision changed against ${row.base.label}, so there is nothing to plan.`);
    throw new RevisionError("nothing-to-plan", "Every asset the revision changed already matches the live space, so there is nothing to plan.");
  }

  // Claim the revision so a double submit creates one plan; an old claim counts as abandoned.
  const claimedAt = new Date();
  const claimed = await db()
    .update(revisions)
    .set({ planClaimedAt: claimedAt })
    .where(
      and(
        eq(revisions.id, row.id),
        row.planId ? eq(revisions.planId, row.planId) : isNull(revisions.planId),
        or(isNull(revisions.planClaimedAt), lt(revisions.planClaimedAt, new Date(claimedAt.getTime() - PLAN_CLAIM_STALE_MS))),
      ),
    )
    .returning({ id: revisions.id });
  if (!claimed.length) throw new RevisionError("plan-open", "A plan is already being created from this revision.");

  let created: Awaited<ReturnType<CreatePlan>>;
  try {
    created = await (deps.createPlan ?? defaultCreatePlan)(input, actor);
  } catch (err) {
    await updateRevision(row.id, { planClaimedAt: null });
    throw err;
  }
  await updateRevision(row.id, { planId: created.planId, plannedCommit: head, planClaimedAt: null });
  await recordAuditEvent({
    actor,
    action: "revision.plan",
    spaceId: space.id,
    targetType: "revision",
    targetId: row.id,
    details: {
      name: row.name,
      planId: created.planId,
      checkRunId: created.checkRunId,
      commit: head,
      items: input.items.length,
      counts: analysis.summary.counts,
      ...(scope ? { leftAlone: scope.leftAlone.map((a) => a.assetKey), conflicts: scope.planned.filter((p) => p.conflict).map((p) => p.assetKey) } : {}),
    },
  });
  return { planId: created.planId, checkRunId: created.checkRunId, items: input.items.length, warnings: analysis.results.validation.filter((r) => r.level === "warning") };
}

export interface ExportRevisionResult {
  zip: Buffer;
  fileName: string;
  sha256: string;
  commit: string;
  files: number;
}

/**
 * The revision's package at its branch head as a zip in its layout (one top
 * folder, deterministic entries), for a space the app can't write to.
 * Refused while the build fails (revisions.yaml export.requirePassingBuild).
 * Needs `audits.read` (REVISION_PERMISSIONS.export): a download is a read.
 */
export async function exportRevision(space: Space, revisionId: string, actor: RevisionActor): Promise<ExportRevisionResult> {
  const row = await getRevision(space.id, revisionId);
  if (!row) throw new RevisionError("not-found", "There is no such revision in this space.");
  const { repo, policy } = await readContext(space);
  const blocked = exportBlocker(row, policy.revisions);
  if (blocked) {
    await recordAuditEvent({ actor, action: "revision.export", spaceId: space.id, targetType: "revision", targetId: row.id, result: "error", details: { name: row.name, commit: row.headCommit, error: blocked } });
    throw new RevisionError("export-blocked", blocked, {}, row.latestBuild ? errorsOf(row.latestBuild.results) : []);
  }
  const layout = layoutOf(policy, row.layout);
  const commit = row.headCommit!;
  const contents = await readRevisionPackage(repo, commit, row.packageDir, row.packageName);
  const zip = zipPackage(contents, row.packageName);
  const fileName = layout.build.packageZip ? fill(layout.build.packageZip, { package: row.packageName }) : `${row.packageName}.zip`;
  const sha256 = sha256Hex(zip);
  await recordAuditEvent({
    actor,
    action: "revision.export",
    spaceId: space.id,
    targetType: "revision",
    targetId: row.id,
    details: { name: row.name, commit, fileName, sha256, sizeBytes: zip.length, files: contents.files.size, build: row.latestBuild?.status ?? null },
  });
  return { zip, fileName, sha256, commit, files: contents.files.size };
}

/** Response headers for the download Route Handler. */
export function revisionDownloadHeaders(result: Pick<ExportRevisionResult, "fileName" | "zip" | "sha256">): Record<string, string> {
  const ascii = result.fileName.replace(/[^\w.@+-]/g, "_") || "package.zip";
  return {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${ascii}"`,
    "Content-Length": String(result.zip.length),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Package-Sha256": result.sha256,
  };
}

/**
 * Abandon a revision: state only, the branch stays (its history and name are
 * kept). Refused while a plan from it is applying. Needs `revisions.build`.
 */
export async function abandonRevision(space: Space, revisionId: string, actor: RevisionActor, opts: { note?: string | null } = {}): Promise<void> {
  const row = await getRevision(space.id, revisionId);
  if (!row) throw new RevisionError("not-found", "There is no such revision in this space.");
  if (row.state !== "open" && row.state !== "failed") throw new RevisionError("not-open", `The revision is ${row.state}, so it can't be abandoned.`);
  const plan = row.planId ? ((await planStates([row.planId])).get(row.planId) ?? null) : null;
  if (plan?.state === "applying") throw new RevisionError("plan-open", `The plan "${plan.title}" from this revision is applying. Wait for it to finish.`);
  const note = opts.note?.trim() || null;
  const changed = await db()
    .update(revisions)
    .set({ state: "abandoned", abandonedBy: actor.email, abandonedAt: new Date(), stateReason: note, updatedAt: new Date() })
    .where(and(eq(revisions.id, row.id), inArray(revisions.state, ["open", "failed"])))
    .returning({ id: revisions.id });
  if (!changed.length) throw new RevisionError("not-open", "The revision changed state. Reload it.");
  await recordAuditEvent({ actor, action: "revision.abandon", spaceId: space.id, targetType: "revision", targetId: row.id, details: { name: row.name, branch: row.branch, headCommit: row.headCommit, note } });
}
