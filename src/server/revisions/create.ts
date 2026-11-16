import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { TRAILERS } from "@/lib/assets/types";
import { recordAuditEvent } from "@/server/audit-log";
import { db } from "@/server/db/client";
import { revisions } from "@/server/db/schema";
import type { HistoryRepo } from "@/server/git/history-repo";
import { fillTemplate, releaseTagName } from "@/server/history/layout";
import type { JobContext } from "@/server/jobs/registry";
import { readSnapshotsAtCommit } from "@/server/package-io/history";
import { exportPackageZip } from "@/server/packages/export";
import { snapshotsToDesiredAssets } from "@/server/packages/live";
import type { PackageContents } from "@/server/packages/types";
import { getRelease, releaseNames } from "@/server/releases/queries";
import type { SyncSpaceFn } from "@/server/releases/sync-first";
import type { Space } from "@/server/spaces/queries";
import { buildPassedAtHead, runRevisionBuild, toRevisionBuild } from "./build";
import { layoutOf, liveRefs, readContext, syncBeforeRevision, workerContext } from "./context";
import { checkRevisionName, isDuplicateRevisionName, releaseNameFor, releaseNameTaken, revisionBranch, revisionNameKey, revisionPackageDir, revisionPackageName } from "./names";
import { packageFileChanges, readRevisionPackage } from "./package-files";
import { getRevisionById, updateRevision, type RevisionRow } from "./queries";
import { RevisionError, type RevisionActor, type RevisionBase } from "./types";

/**
 * Creating a revision: the web process checks the
 * request and inserts the row in state "creating"; the revisions.create job
 * (worker) reads the base, turns its assets into package files with the
 * space's package layout, runs the build, creates the branch at the base
 * commit and commits the package under the package folder.
 *
 * Base "live": the space's assets at the history repository's HEAD after a
 * reconcile sync (as a release of HEAD does). Base "release": the assets at
 * the release commit, never synced. When the release was tagged after a plan
 * made from an earlier revision, that revision's package is the export base,
 * so its non-asset files (README, evaluation/, reference/, shared sections)
 * carry over.
 */

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

export const createRevisionRequest = z.object({
  name: z.string().trim(),
  base: z.discriminatedUnion("kind", [z.object({ kind: z.literal("live") }), z.object({ kind: z.literal("release"), releaseId: z.string().uuid("Choose a release.") })]),
  /** Layout from package-layouts.yaml; default: the policy's defaultLayout */
  layout: z.preprocess(blankToNull, z.string().trim().nullable().default(null)),
  note: z.preprocess(blankToNull, z.string().trim().nullable().default(null)),
});

export type CreateRevisionRequest = z.input<typeof createRevisionRequest>;

export const createRevisionInput = z.object({ revisionId: z.string().uuid() });

export interface CreateRevisionResult {
  revisionId: string;
  branch: string;
  createdCommit: string;
  build: "passed" | "failed";
  /** An earlier attempt had already created the branch */
  resumed: boolean;
}

/**
 * Check a create request and insert the revision (state "creating"). The
 * caller has checked `revisions.build` for the space, and enqueues the
 * revisions.create job with the returned ID.
 */
export async function prepareCreateRevision(space: Space, request: CreateRevisionRequest, actor: RevisionActor): Promise<RevisionRow> {
  const parsed = createRevisionRequest.safeParse(request);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RevisionError("bad-request", issue?.message ?? "The request is not valid.", issue?.path.length ? { [issue.path.join(".")]: issue.message } : {});
  }
  const req = parsed.data;
  const { repo, policy } = await readContext(space);
  const layout = layoutOf(policy, req.layout);
  if (req.note && req.note.length > policy.revisions.create.noteMaxChars) {
    throw new RevisionError("bad-request", `Keep the note to ${policy.revisions.create.noteMaxChars} characters or fewer.`, { note: "The note is too long." });
  }
  const check = checkRevisionName(policy, req.name, space.alias);
  if (!check.ok) throw new RevisionError("name-invalid", check.message, { name: check.message });
  const nameKey = revisionNameKey(policy, req.name);
  const branch = revisionBranch(policy, space.alias, req.name);

  const existing = await db().select({ id: revisions.id, name: revisions.name, state: revisions.state, branch: revisions.branch }).from(revisions).where(eq(revisions.spaceId, space.id));
  const same = existing.filter((r) => isDuplicateRevisionName(policy, req.name, [r.name]));
  // A revision whose create job failed before making its branch gives its name back.
  for (const r of same) {
    if (r.state === "failed" && !(await repo.branchHead(r.branch))) await db().delete(revisions).where(and(eq(revisions.id, r.id), eq(revisions.state, "failed")));
    else throw new RevisionError("name-taken", `A revision named ${r.name} already exists in this space.`, { name: "This name is taken." });
  }
  if (await repo.branchHead(branch)) throw new RevisionError("name-taken", `The history repository already has a branch ${branch}.`, { name: "This name is taken." });

  const release = releaseNameFor(policy, req.name, space.alias);
  const tag = releaseTagName(policy.historyLayout, space.alias, release);
  if (releaseNameTaken(policy, release, { names: await releaseNames(space.id), tags: await repo.tags(), tag })) {
    throw new RevisionError("name-taken", `Applying this revision tags a release named ${release}, and a release with that name already exists. Choose another name.`, { name: "A release has this name." });
  }

  let base: RevisionBase;
  let baseRef: string;
  if (req.base.kind === "release") {
    const rel = await getRelease(space.id, req.base.releaseId);
    if (!rel) throw new RevisionError("unknown-release", "There is no such release in this space.", { base: "Choose a release of this space." });
    base = { kind: "release", releaseId: rel.id, name: rel.name, tag: rel.tag, commit: rel.commit, label: fillTemplate(policy.revisions.create.baseLabels.release, { release: rel.name }) };
    baseRef = rel.id;
  } else {
    if (!(await repo.head())) throw new RevisionError("no-history", "The history repository has no commits yet. Run a sync first.");
    base = { kind: "live", label: policy.revisions.create.baseLabels.live };
    baseRef = "HEAD";
  }

  const packageName = revisionPackageName(policy, space.alias, req.name);
  const [row] = await db()
    .insert(revisions)
    .values({
      id: randomUUID(),
      spaceId: space.id,
      name: req.name,
      nameKey,
      branch,
      packageDir: revisionPackageDir(policy, space.alias, packageName),
      packageName,
      layout: layout.name,
      baseKind: req.base.kind,
      baseRef,
      base,
      note: req.note,
      state: "creating",
      createdBy: actor.email,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new RevisionError("name-taken", `A revision named ${req.name} already exists in this space.`, { name: "This name is taken." });
  return row;
}

export interface CreateRevisionDeps {
  /** Defaults to the sync module's syncSpace (tests pass a mock) */
  sync?: SyncSpaceFn;
}

/** The package of the revision whose plan produced a release (release.planId), for carrying its non-asset files. */
async function carriedPackage(repo: HistoryRepo, spaceId: string, planId: string | null): Promise<{ contents: PackageContents; revisionId: string } | null> {
  if (!planId) return null;
  const [prior] = await db()
    .select()
    .from(revisions)
    .where(and(eq(revisions.spaceId, spaceId), eq(revisions.planId, planId)));
  const commit = prior?.plannedCommit ?? prior?.headCommit;
  if (!prior || !commit) return null;
  const contents = await readRevisionPackage(repo, commit, prior.packageDir, prior.packageName);
  return contents.files.size ? { contents, revisionId: prior.id } : null;
}

/** Worker handler for revisions.create. */
export async function createRevisionHandler(input: z.output<typeof createRevisionInput>, ctx: JobContext, deps: CreateRevisionDeps = {}): Promise<CreateRevisionResult> {
  const row = await getRevisionById(input.revisionId);
  if (!row) throw new RevisionError("not-found", "The revision no longer exists.");
  if (row.state !== "creating") {
    if (row.createdCommit) return { revisionId: row.id, branch: row.branch, createdCommit: row.createdCommit, build: buildPassedAtHead(row.latestBuild, row.headCommit) ? "passed" : "failed", resumed: true };
    throw new RevisionError("not-open", `The revision is ${row.state}.`);
  }
  try {
    const result = await createRevision(row, ctx, deps);
    await recordAuditEvent({
      actor: ctx.actor,
      action: "revision.create",
      spaceId: row.spaceId,
      targetType: "revision",
      targetId: row.id,
      details: { name: row.name, branch: row.branch, base: row.base.label, baseKind: row.baseKind, layout: row.layout, commit: result.createdCommit, build: result.build, resumed: result.resumed },
    });
    return result;
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await updateRevision(row.id, { state: "failed", stateReason: message });
    await recordAuditEvent({
      actor: ctx.actor,
      action: "revision.create",
      spaceId: row.spaceId,
      targetType: "revision",
      targetId: row.id,
      result: "error",
      details: { name: row.name, base: row.base.label, error: message },
    });
    throw err;
  }
}

async function createRevision(row: RevisionRow, ctx: JobContext, deps: CreateRevisionDeps): Promise<CreateRevisionResult> {
  const { space, repo, policy } = await workerContext(row.spaceId);
  const layout = layoutOf(policy, row.layout);
  const trailerKeys = policy.revisions.trailers;
  const { refs } = await liveRefs(space, policy);

  // An earlier attempt may have made the branch already: finish from what it committed.
  const existingHead = await repo.branchHead(row.branch);
  if (existingHead) {
    const [first] = await repo.log({ ref: existingHead, maxCount: 1 });
    if (first?.trailers[trailerKeys.revisionId] !== row.id) throw new RevisionError("name-taken", `The history repository already has a branch ${row.branch}.`);
    const parent = await repo.resolveCommit(`${existingHead}^`);
    const contents = await readRevisionPackage(repo, existingHead, row.packageDir, row.packageName);
    const check = runRevisionBuild(contents, { policy, layout, live: refs });
    const build = toRevisionBuild(check, existingHead, { maxResults: policy.revisions.pages.maxResults, extra: row.base.exportResults ?? [] });
    await updateRevision(row.id, { state: "open", stateReason: null, baseCommit: parent, createdCommit: existingHead, headCommit: existingHead, latestBuild: build });
    await ctx.progress(1, "Revision created");
    return { revisionId: row.id, branch: row.branch, createdCommit: existingHead, build: build.status, resumed: true };
  }

  let commit: string;
  let base: RevisionBase = row.base;
  let carried: Awaited<ReturnType<typeof carriedPackage>> = null;
  if (row.baseKind === "release") {
    const rel = await getRelease(space.id, row.baseRef);
    if (!rel) throw new RevisionError("unknown-release", "The release this revision starts from no longer exists.");
    commit = rel.commit;
    carried = await carriedPackage(repo, space.id, rel.planId);
    if (base.kind === "release") base = { ...base, fromRevisionId: carried?.revisionId ?? null };
  } else {
    await syncBeforeRevision(space.id, ctx, policy, deps.sync);
    const head = await repo.head();
    if (!head) throw new RevisionError("no-history", "The history repository has no commits yet. Run a sync first.");
    commit = head;
  }

  await ctx.progress(0.5, "Reading the assets");
  const snapshots = await readSnapshotsAtCommit(repo, policy.historyLayout, space.alias, commit, policy.packageIo.export.gitReadConcurrency);
  const desired = snapshotsToDesiredAssets(snapshots, policy);
  const exported = exportPackageZip(desired.assets, layout, { policy, packageName: row.packageName, base: carried?.contents });
  const exportResults = [...desired.results, ...exported.results.filter((r) => r.code.startsWith("export."))];

  await ctx.progress(0.65, "Building the package");
  const check = runRevisionBuild(exported.contents, { policy, layout, live: refs });
  const files = check.build.contents;

  await ctx.progress(0.8, "Committing the package");
  await repo.createBranch(row.branch, commit);
  const createdCommit = await repo.commitToBranch(row.branch, packageFileChanges(null, files, row.packageDir), {
    message: fillTemplate(policy.revisions.create.commitMessage, { name: row.name, spaceAlias: space.alias, base: row.base.label }),
    author: { name: row.createdBy, email: row.createdBy },
    committer: policy.revisions.committer,
    date: new Date(),
    trailers: [
      [trailerKeys.revisionId, row.id],
      [TRAILERS.spaceAlias, space.alias],
    ],
    allowEmpty: true,
    expectedHead: commit,
  });
  if (!createdCommit) throw new Error("The first revision commit was not created.");

  const build = toRevisionBuild(check, createdCommit, { maxResults: policy.revisions.pages.maxResults, extra: exportResults });
  // The export already ran the build once; report what it wrote too.
  build.buildPaths = [...new Set([...exported.build.changes.map((c) => c.path), ...build.buildPaths])].sort();
  await updateRevision(row.id, {
    state: "open",
    stateReason: null,
    base: { ...base, exportResults },
    baseCommit: commit,
    createdCommit,
    headCommit: createdCommit,
    latestBuild: build,
  });

  if (policy.revisions.pushBranches) {
    try {
      await repo.pushBranch(row.branch);
    } catch (err) {
      ctx.log("pushing the revision branch failed", { error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
    }
  }
  await ctx.progress(1, build.status === "passed" ? "Revision created" : "Revision created; the build has errors");
  return { revisionId: row.id, branch: row.branch, createdCommit, build: build.status, resumed: false };
}
