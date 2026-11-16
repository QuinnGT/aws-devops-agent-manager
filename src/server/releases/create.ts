import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TRAILERS } from "@/lib/assets/types";
import { recordAuditEvent } from "@/server/audit-log";
import { openSpaceHistoryRepo } from "@/server/assets/repo";
import { HistoryRepo } from "@/server/git/history-repo";
import { fillTemplate, releaseManifestPath, releaseTagName } from "@/server/history/layout";
import type { JobContext } from "@/server/jobs/registry";
import { getPolicyForRepo, type Policy } from "@/server/policy";
import { getHistoryRepoForSpace, getSpaceById, toHistoryRepoConfig } from "@/server/spaces/queries";
import { COMMIT_INPUT, RELEASE_TRAILERS, shortCommit } from "./config";
import { ReleaseError } from "./errors";
import { buildManifest, parseManifest, scanSpaceAssets, serializeManifest, type ReleaseManifest } from "./manifest";
import { checkReleaseName, isDuplicateName } from "./names";
import { getReleaseById, insertRelease, releaseNames, type ReleaseRow } from "./queries";
import { resolveCommit } from "./source";
import { syncBeforeRelease, type SyncSpaceFn } from "./sync-first";

/**
 * Creating a release:
 * the web process validates and enqueues; the worker syncs the space first
 * when the release is of HEAD (sync-first.ts), then builds the manifest from
 * the history repository at the chosen commit (HEAD by default, or the commit
 * of an apply for "tag after apply", which skips the sync), commits it as
 * releases/<alias>/<name>.json, creates the annotated tag, indexes the release
 * and records the audit event. The release ID is assigned before the job runs
 * and written into the commit as Release-Id, so a retried job finishes the
 * same release instead of making a second one.
 */

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

export const createReleaseRequest = z.object({
  spaceId: z.string().uuid(),
  name: z.string().trim(),
  note: z.preprocess(blankToNull, z.string().trim().nullable().default(null)),
  /** Tag this commit instead of HEAD (for example the commit an apply made) */
  commit: z.preprocess(blankToNull, z.string().trim().toLowerCase().regex(COMMIT_INPUT, "Enter a commit hash").nullable().default(null)),
  /** The plan whose apply made `commit` */
  planId: z.preprocess(blankToNull, z.string().trim().min(1).max(200).nullable().default(null)),
});

export const createReleaseInput = createReleaseRequest.extend({
  releaseId: z.string().uuid(),
  /** Full hash, resolved when the job was requested; null means HEAD when the job runs */
  commit: z.string().regex(COMMIT_INPUT).nullable(),
});

export type CreateReleaseRequest = z.input<typeof createReleaseRequest>;
export type CreateReleaseInput = z.output<typeof createReleaseInput>;

export interface CreateReleaseResult {
  releaseId: string;
  name: string;
  tag: string;
  commit: string;
  sourceCommit: string;
  manifestPath: string;
  assetCount: number;
  pushed: boolean;
  pushError?: string;
  /** True when an earlier attempt of the same job had already done part of the work */
  resumed: boolean;
}

function nameProblems(policy: Policy, name: string, existing: { names: string[]; tags: string[]; tag: string }): Record<string, string> {
  const check = checkReleaseName(policy.releases, name);
  if (!check.ok) return { name: check.message };
  if (isDuplicateName(policy.releases, name, existing.names) || isDuplicateName(policy.releases, existing.tag, existing.tags)) {
    return { name: `A release named ${name} already exists in this space.` };
  }
  return {};
}

/**
 * Validate a release request and assign its ID. The caller (a Server Action)
 * has checked `releases.create` for the space, and enqueues the returned input.
 */
export async function prepareCreateRelease(request: CreateReleaseRequest): Promise<CreateReleaseInput> {
  const parsed = createReleaseRequest.parse(request);
  const space = await getSpaceById(parsed.spaceId);
  if (!space) throw new ReleaseError("Space not found.");
  const opened = await openSpaceHistoryRepo(space);
  if (!opened.ok) throw new ReleaseError(opened.message);
  const policy = getPolicyForRepo(opened.repo.dir).policy;
  const fieldErrors: Record<string, string> = {};
  if (parsed.note && parsed.note.length > policy.releases.noteMaxChars) fieldErrors.note = `Keep the note to ${policy.releases.noteMaxChars} characters or fewer.`;
  const tag = releaseTagName(policy.historyLayout, space.alias, parsed.name);
  Object.assign(fieldErrors, nameProblems(policy, parsed.name, { names: await releaseNames(space.id), tags: await opened.repo.tags(), tag }));
  let commit: string | null = null;
  if (parsed.commit) {
    commit = await resolveCommit(opened.repo, parsed.commit);
    if (!commit) fieldErrors.commit = `The history repository has no commit ${parsed.commit}.`;
  } else if (!(await opened.repo.head())) {
    throw new ReleaseError("The history repository has no commits yet. Run a sync first.");
  }
  if (Object.keys(fieldErrors).length) throw new ReleaseError(Object.values(fieldErrors)[0]!, fieldErrors);
  return { ...parsed, commit, releaseId: randomUUID() };
}

function resultOf(row: ReleaseRow, extra: Pick<CreateReleaseResult, "pushed" | "pushError" | "resumed">): CreateReleaseResult {
  return {
    releaseId: row.id,
    name: row.name,
    tag: row.tag,
    commit: row.commit,
    sourceCommit: row.sourceCommit,
    manifestPath: row.manifestPath,
    assetCount: row.assetCount,
    ...extra,
  };
}

export interface CreateReleaseDeps {
  /** Defaults to the sync module's syncSpace (tests pass a mock) */
  sync?: SyncSpaceFn;
}

/** Worker handler for releases.create. */
export async function createReleaseHandler(input: CreateReleaseInput, ctx: JobContext, deps: CreateReleaseDeps = {}): Promise<CreateReleaseResult> {
  try {
    return await createRelease(input, ctx, deps);
  } catch (err) {
    if (err instanceof ReleaseError) {
      await recordAuditEvent({
        actor: ctx.actor,
        action: "release.create",
        spaceId: input.spaceId,
        targetType: "release",
        targetId: input.releaseId,
        result: "error",
        details: { name: input.name, commit: input.commit, planId: input.planId, error: err.message },
      });
    }
    throw err;
  }
}

async function createRelease(input: CreateReleaseInput, ctx: JobContext, deps: CreateReleaseDeps): Promise<CreateReleaseResult> {
  const done = await getReleaseById(input.releaseId);
  if (done) return resultOf(done, { pushed: false, resumed: true });

  const space = await getSpaceById(input.spaceId);
  if (!space) throw new ReleaseError("Space not found.");
  const repoRow = await getHistoryRepoForSpace(space);
  if (!repoRow) throw new ReleaseError("This space has no history repository.");
  const repo = await HistoryRepo.open(toHistoryRepoConfig(repoRow));
  const policy = getPolicyForRepo(repo.dir).policy;
  const layout = policy.historyLayout;
  const tag = releaseTagName(layout, space.alias, input.name);
  const manifestPath = releaseManifestPath(layout, space.alias, input.name);
  await ctx.progress(0.02, "Checking the name");

  const tags = await repo.tags();
  const names = await releaseNames(space.id, input.releaseId);
  let resumed = false;
  let commit: string | null = null;
  const existingTag = tags.find((t) => isDuplicateName(policy.releases, tag, [t]));
  if (existingTag) {
    // Our own tag from an earlier attempt, or a real duplicate
    const [tagged] = await repo.log({ ref: `refs/tags/${existingTag}`, maxCount: 1 });
    if (tagged?.trailers[RELEASE_TRAILERS.releaseId] !== input.releaseId) {
      throw new ReleaseError(`A release named ${input.name} already exists in the history repository (tag ${existingTag}).`, { name: "This name is taken." });
    }
    commit = tagged.hash;
    resumed = true;
  }
  const problems = nameProblems(policy, input.name, { names, tags: existingTag ? tags.filter((t) => t !== existingTag) : tags, tag });
  if (problems.name) throw new ReleaseError(problems.name, problems);

  if (!commit) {
    // A manifest commit from an earlier attempt that failed before tagging
    const prior = (await repo.log({ path: manifestPath, maxCount: 20 })).find((c) => c.trailers[RELEASE_TRAILERS.releaseId] === input.releaseId);
    if (prior) {
      commit = prior.hash;
      resumed = true;
    }
  }

  let manifest: ReleaseManifest;
  const now = new Date();
  if (commit) {
    const parsed = parseManifest(await repo.show(commit, manifestPath));
    if (!parsed) throw new ReleaseError(`The manifest ${manifestPath} at commit ${shortCommit(commit)} can't be read.`);
    manifest = parsed;
  } else {
    // A release of HEAD syncs first (policy releases.syncBeforeCreate); a given commit is pinned as it is.
    await syncBeforeRelease({ spaceId: space.id, commit: input.commit }, ctx, policy.releases, deps.sync);
    const wanted = input.commit ?? (await repo.head());
    const sourceCommit = wanted ? await resolveCommit(repo, wanted) : null;
    if (!sourceCommit) throw new ReleaseError(wanted ? `The history repository has no commit ${wanted}.` : "The history repository has no commits yet. Run a sync first.");
    await ctx.progress(0.5, "Reading the assets");
    const scanned = await scanSpaceAssets(repo, layout, space.alias, sourceCommit);
    for (const p of scanned.problems) ctx.log(p.message);
    if (!scanned.assets.length) throw new ReleaseError(`No assets of ${space.alias} are recorded at commit ${shortCommit(sourceCommit)}. Run a sync first.`);
    manifest = buildManifest({
      scanned: scanned.assets,
      policy,
      space,
      sourceCommit,
      release: { id: input.releaseId, name: input.name, tag, createdBy: ctx.actor.email, createdAt: now.toISOString(), note: input.note, planId: input.planId },
    });
    await ctx.progress(0.7, "Committing the manifest");
    const vars = { release: input.name, spaceAlias: space.alias, shortCommit: shortCommit(sourceCommit) };
    commit = await repo.writeAndCommit([{ path: manifestPath, content: serializeManifest(manifest) }], {
      message: fillTemplate(policy.releases.commitMessage, vars),
      author: { name: ctx.actor.email, email: ctx.actor.email },
      committer: policy.releases.committer,
      date: now,
      trailers: {
        [RELEASE_TRAILERS.releaseId]: input.releaseId,
        [RELEASE_TRAILERS.release]: input.name,
        [RELEASE_TRAILERS.sourceCommit]: sourceCommit,
        [TRAILERS.spaceAlias]: space.alias,
        [TRAILERS.planId]: input.planId,
      },
      allowEmpty: true,
    });
    if (!commit) throw new Error("The manifest commit was not created.");
  }

  if (!existingTag) {
    await ctx.progress(0.8, "Creating the tag");
    const vars = { release: input.name, spaceAlias: space.alias, shortCommit: shortCommit(manifest.sourceCommit) };
    const message = `${fillTemplate(policy.releases.tagMessage, vars)}\n\n${RELEASE_TRAILERS.releaseId}: ${input.releaseId}\n`;
    await repo.tag(tag, message, commit, { name: ctx.actor.email, email: ctx.actor.email, date: now });
  }

  await ctx.progress(0.9, "Pushing");
  let pushed = false;
  let pushError: string | undefined;
  try {
    pushed = await repo.push();
  } catch (err) {
    // The release is committed and tagged locally; the next push carries it.
    pushError = err instanceof Error ? err.message.slice(0, 300) : String(err);
    ctx.log("push failed after creating a release", { error: pushError });
  }

  const row: ReleaseRow = {
    id: input.releaseId,
    spaceId: space.id,
    name: input.name,
    tag,
    commit,
    sourceCommit: manifest.sourceCommit,
    manifestPath,
    manifest,
    assetCount: manifest.assets.length,
    note: manifest.release.note,
    planId: manifest.release.planId,
    createdBy: manifest.release.createdBy,
    jobRunId: /^[0-9a-f-]{36}$/i.test(ctx.runId) ? ctx.runId : null,
    createdAt: new Date(manifest.release.createdAt),
  };
  await insertRelease(row);
  await recordAuditEvent({
    actor: ctx.actor,
    action: "release.create",
    spaceId: space.id,
    targetType: "release",
    targetId: input.releaseId,
    details: { name: input.name, tag, commit, sourceCommit: manifest.sourceCommit, assetCount: row.assetCount, planId: row.planId, pushed, ...(pushError ? { pushError } : {}) },
  });
  await ctx.progress(1, "Release created");
  return resultOf(row, { pushed, ...(pushError ? { pushError } : {}), resumed });
}
