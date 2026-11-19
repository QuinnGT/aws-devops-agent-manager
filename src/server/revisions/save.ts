import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { TRAILERS } from "@/lib/assets/types";
import { recordAuditEvent } from "@/server/audit-log";
import { listLinkableFindings } from "@/server/audits/linkable";
import { db } from "@/server/db/client";
import { revisionChanges, revisions } from "@/server/db/schema";
import { BranchMovedError } from "@/server/git/history-repo";
import type { JobContext } from "@/server/jobs/registry";
import type { PackageContents } from "@/server/packages/types";
import type { Policy } from "@/server/policy";
import type { Space } from "@/server/spaces/queries";
import { runRevisionBuild, toRevisionBuild } from "./build";
import { renderChangelogSection, upsertChangelog, type ChangelogChange, type ChangelogFinding } from "./changelog";
import { layoutOf, liveRefs, workerContext } from "./context";
import { applyEdits, changedPackagePaths, checkEdits, packageFileChanges, readRevisionPackage } from "./package-files";
import { findingsForChangelog, getRevision, getRevisionById, listChanges, type RevisionRow } from "./queries";
import { takeOffList } from "./to-address";
import { RevisionError, type RevisionActor, type RevisionFileEdit } from "./types";

/**
 * Saving a revision: one revisions.save job per save, one at a time per
 * revision (pg-boss singleton policy keyed by revision). The job writes the
 * edited, added and deleted files, regenerates the change record, runs the
 * build and validation (their file changes go into the same commit), and
 * commits on the revision branch with trailers: Revision-Id, one Finding-Id
 * per linked finding, Unlinked-Reason when none is linked, and
 * Revision-Change-Id, which lets a retried job find its own commit. A save
 * whose build fails is still committed (it is the person's work); the
 * stored build result blocks the plan and the download until a save passes.
 *
 * Linking: every finding must be accepted, linkable (its extractor is marked
 * linkable in the audit's profile) and of the same space. A save that links
 * none follows revisions.yaml save.unlinked (default: it needs a written
 * reason, which goes into the change record and a trailer).
 */

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

const editSchema = z.object({
  path: z.string().min(1).max(4096),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  content: z.string().nullable(),
});

export const saveRevisionRequest = z.object({
  /** The commit subject: one line */
  message: z
    .string()
    .transform((s) => s.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1, "Describe the change.")),
  edits: z.array(editSchema).min(1, "Change at least one file."),
  findingIds: z.array(z.string().uuid()).default([]),
  unlinkedReason: z.preprocess(blankToNull, z.string().trim().nullable().default(null)),
  /** The branch head the editor started from; the save is refused when the branch has moved since */
  expectedHead: z.preprocess(blankToNull, z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/).nullable().default(null)),
});

export type SaveRevisionRequest = z.input<typeof saveRevisionRequest>;

export const saveRevisionInput = saveRevisionRequest.extend({
  revisionId: z.string().uuid(),
  /** revision_changes.id, assigned before the job runs */
  changeId: z.string().uuid(),
  authorName: z.string().nullable().default(null),
});

export type SaveRevisionInput = z.output<typeof saveRevisionInput>;

export interface SaveRevisionResult {
  revisionId: string;
  changeId: string;
  commit: string;
  build: "passed" | "failed";
  errors: number;
  changedPaths: string[];
  buildPaths: string[];
  resumed: boolean;
}

/** Check the linked findings and the unlinked rule. Returns the deduplicated IDs. */
async function checkLinks(policy: Pick<Policy, "revisions">, spaceId: string, findingIds: readonly string[], unlinkedReason: string | null): Promise<string[]> {
  const caps = policy.revisions.save;
  const ids = [...new Set(findingIds)];
  if (ids.length > caps.maxFindings) throw new RevisionError("bad-request", `A save can link at most ${caps.maxFindings} findings.`, { findingIds: "Too many findings." });
  if (ids.length) {
    const linkable = new Set((await listLinkableFindings(spaceId, { ids })).map((f) => f.id));
    const missing = ids.filter((id) => !linkable.has(id));
    if (missing.length) {
      throw new RevisionError(
        "finding-not-linkable",
        missing.length === 1 ? "One of the findings can't be linked: it isn't an accepted finding of this space that a revision can link." : `${missing.length} of the findings can't be linked: they aren't accepted findings of this space that a revision can link.`,
        { findingIds: "Link only accepted findings of this space." },
      );
    }
    return ids;
  }
  if (caps.unlinked === "refuse") throw new RevisionError("finding-not-linkable", "Link at least one accepted finding to this change.", { findingIds: "Link a finding." });
  if (caps.unlinked === "reason") {
    const len = unlinkedReason?.length ?? 0;
    if (len < Math.max(1, caps.reasonMinChars)) {
      throw new RevisionError("reason-required", "This change links no finding, so say why it is needed.", { unlinkedReason: `Write at least ${Math.max(1, caps.reasonMinChars)} characters.` });
    }
  }
  if (unlinkedReason && unlinkedReason.length > caps.reasonMaxChars) {
    throw new RevisionError("bad-request", `Keep the reason to ${caps.reasonMaxChars} characters or fewer.`, { unlinkedReason: "The reason is too long." });
  }
  return [];
}

/**
 * Check a save request and return the job input. The caller has checked
 * `revisions.build` for the space and enqueues revisions.save with it.
 */
export async function prepareSaveRevision(space: Space, policy: Policy, revisionId: string, request: SaveRevisionRequest, actor: RevisionActor): Promise<{ row: RevisionRow; input: SaveRevisionInput }> {
  const parsed = saveRevisionRequest.safeParse(request);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RevisionError("bad-request", issue?.message ?? "The save is not valid.", issue?.path.length ? { [String(issue.path[0])]: issue.message } : {});
  }
  const req = parsed.data;
  const row = await getRevision(space.id, revisionId);
  if (!row) throw new RevisionError("not-found", "There is no such revision in this space.");
  if (row.state !== "open") throw new RevisionError("not-open", `The revision is ${row.state}, so it can't be saved.`);
  if (req.message.length > policy.revisions.save.messageMaxChars) throw new RevisionError("bad-request", `Keep the message to ${policy.revisions.save.messageMaxChars} characters or fewer.`, { message: "The message is too long." });
  if (req.expectedHead && row.headCommit && req.expectedHead !== row.headCommit) throw movedError();
  checkEdits(req.edits, policy);
  const findingIds = await checkLinks(policy, space.id, req.findingIds, req.unlinkedReason);
  return {
    row,
    input: { ...req, findingIds, unlinkedReason: findingIds.length ? null : req.unlinkedReason, revisionId: row.id, changeId: randomUUID(), authorName: actor.name ?? null },
  };
}

function movedError(): RevisionError {
  return new RevisionError("moved", "The revision was saved by someone else since you opened it. Reload it and make your change again.");
}

/** The change record with this save's entry, written into the package (revisions.yaml changelog). */
export function withChangelog(
  contents: PackageContents,
  cfg: Policy["revisions"]["changelog"],
  input: { name: string; baseLabel: string; changes: ChangelogChange[]; findings: ReadonlyMap<string, ChangelogFinding> },
): PackageContents {
  if (!cfg.path) return contents;
  const existing = contents.files.get(cfg.path)?.toString("utf8") ?? null;
  const section = renderChangelogSection(cfg, input);
  const files = new Map(contents.files);
  files.set(cfg.path, Buffer.from(upsertChangelog(existing, section, cfg, input.name), "utf8"));
  return { name: contents.name, files };
}

/** Worker handler for revisions.save. */
export async function saveRevisionHandler(input: SaveRevisionInput, ctx: JobContext): Promise<SaveRevisionResult> {
  const row = await getRevisionById(input.revisionId);
  if (!row) throw new RevisionError("not-found", "The revision no longer exists.");
  const audit = (result: "ok" | "error", details: Record<string, unknown>) =>
    recordAuditEvent({ actor: ctx.actor, action: "revision.save", spaceId: row.spaceId, targetType: "revision", targetId: row.id, result, details: { name: row.name, changeId: input.changeId, ...details } });
  try {
    const result = await saveRevision(row, input, ctx);
    await audit("ok", { commit: result.commit, build: result.build, errors: result.errors, findingIds: input.findingIds, changedPaths: result.changedPaths.slice(0, 50), resumed: result.resumed });
    return result;
  } catch (err) {
    await audit("error", { error: (err instanceof Error ? err.message : String(err)).slice(0, 500), findingIds: input.findingIds });
    throw err;
  }
}

async function saveRevision(row: RevisionRow, input: SaveRevisionInput, ctx: JobContext): Promise<SaveRevisionResult> {
  const [done] = await db().select().from(revisionChanges).where(eq(revisionChanges.id, input.changeId));
  if (done) {
    return { revisionId: row.id, changeId: done.id, commit: done.commit, build: done.buildStatus, errors: row.latestBuild?.commit === done.commit ? row.latestBuild.errors : 0, changedPaths: done.changedPaths, buildPaths: done.buildPaths, resumed: true };
  }
  if (row.state !== "open") throw new RevisionError("not-open", `The revision is ${row.state}, so it can't be saved.`);
  const { space, repo, policy } = await workerContext(row.spaceId);
  const layout = layoutOf(policy, row.layout);
  const keys = policy.revisions.trailers;

  const head = await repo.branchHead(row.branch);
  if (!head) throw new RevisionError("not-found", `The branch ${row.branch} is missing from the history repository.`);
  const [headEntry] = await repo.log({ ref: head, maxCount: 1 });
  // A retried job whose commit landed before the row was written.
  const resumed = headEntry?.trailers[keys.changeId] === input.changeId;
  const parent = resumed ? await repo.resolveCommit(`${head}^`) : head;
  if (!parent) throw new Error("The parent of the revision commit can't be read.");
  if (!resumed && input.expectedHead && input.expectedHead !== head) throw movedError();

  // A resumed save was checked when it was committed; a finding rejected since then doesn't undo the commit.
  const findingIds = resumed ? [...new Set(input.findingIds)] : await checkLinks(policy, space.id, input.findingIds, input.unlinkedReason);
  await ctx.progress(0.1, "Reading the package");
  const before = await readRevisionPackage(repo, parent, row.packageDir, row.packageName);
  const edited = applyEdits(before, input.edits as RevisionFileEdit[]);
  if (!edited.changedPaths.length) throw new RevisionError("nothing-changed", "The save changes nothing: every file already has that content.");

  const now = new Date();
  const prior = await listChanges(row.id);
  const changes: ChangelogChange[] = [
    ...prior.map((c) => ({ message: c.message, changedPaths: c.changedPaths, findingIds: c.findingIds, unlinkedReason: c.unlinkedReason, createdAt: c.createdAt })),
    { message: input.message, changedPaths: edited.changedPaths, findingIds, unlinkedReason: input.unlinkedReason, createdAt: now },
  ];
  const findings = new Map((await findingsForChangelog(space.id, changes.flatMap((c) => c.findingIds))).map((f) => [f.id, f]));
  const recorded = withChangelog(edited.contents, policy.revisions.changelog, { name: row.name, baseLabel: row.base.label, changes, findings });

  await ctx.progress(0.3, "Building and validating");
  const { refs } = await liveRefs(space, policy);
  const check = runRevisionBuild(recorded, { policy, layout, live: refs });
  const final = check.build.contents;
  const changedSet = new Set(edited.changedPaths);
  const buildPaths = changedPackagePaths(before, final).filter((p) => !changedSet.has(p));

  let commit: string;
  if (resumed) commit = head;
  else {
    await ctx.progress(0.7, "Committing");
    try {
      const made = await repo.commitToBranch(row.branch, packageFileChanges(before, final, row.packageDir), {
        message: input.message,
        author: { name: input.authorName || ctx.actor.email, email: ctx.actor.email },
        committer: policy.revisions.committer,
        date: now,
        trailers: [
          [keys.revisionId, row.id],
          ...findingIds.map((id) => [keys.findingId, id] as const),
          [keys.unlinkedReason, findingIds.length ? null : input.unlinkedReason],
          [keys.changeId, input.changeId],
          [TRAILERS.spaceAlias, space.alias],
        ],
        expectedHead: parent,
      });
      if (!made) throw new RevisionError("nothing-changed", "The save changes nothing: every file already has that content.");
      commit = made;
    } catch (err) {
      if (err instanceof BranchMovedError) throw movedError();
      throw err;
    }
  }

  const build = toRevisionBuild(check, commit, { maxResults: policy.revisions.pages.maxResults, now });
  // One transaction: the change row, the new head and the findings it takes off the to-address list land together.
  await db().transaction(async (tx) => {
    await tx
      .insert(revisionChanges)
      .values({
        id: input.changeId,
        revisionId: row.id,
        spaceId: row.spaceId,
        commit,
        parentCommit: parent,
        changedPaths: edited.changedPaths,
        buildPaths,
        message: input.message,
        findingIds,
        unlinkedReason: findingIds.length ? null : input.unlinkedReason,
        buildStatus: build.status,
        author: ctx.actor.email,
        authorName: input.authorName,
        jobRunId: /^[0-9a-f-]{36}$/i.test(ctx.runId) ? ctx.runId : null,
        createdAt: now,
      })
      .onConflictDoNothing();
    const [cur] = await tx.select({ toAddress: revisions.toAddressFindingIds }).from(revisions).where(eq(revisions.id, row.id)).for("update");
    await tx
      .update(revisions)
      .set({ headCommit: commit, latestBuild: build, toAddressFindingIds: takeOffList(cur?.toAddress ?? [], findingIds), updatedAt: new Date() })
      .where(eq(revisions.id, row.id));
  });

  if (policy.revisions.pushBranches) {
    try {
      await repo.pushBranch(row.branch);
    } catch (err) {
      ctx.log("pushing the revision branch failed", { error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
    }
  }
  await ctx.progress(1, build.status === "passed" ? "Saved; the build passed" : `Saved; the build has ${build.errors} ${build.errors === 1 ? "error" : "errors"}`);
  return { revisionId: row.id, changeId: input.changeId, commit, build: build.status, errors: build.errors, changedPaths: edited.changedPaths, buildPaths, resumed };
}
