import type { DevOpsAgentClient } from "@aws-sdk/client-devops-agent";
import { z } from "zod";
import { TRAILERS, type AssetFileSnapshot, type AssetSnapshot } from "@/lib/assets/types";
import { recordAuditEvent } from "@/server/audit-log";
import { URL_ASSET_ID } from "@/server/assets/config";
import { getIndexedAsset, listIndexedAssets, type IndexedAsset } from "@/server/assets/queries";
import { listAssetCommits, openSpaceHistoryRepo } from "@/server/assets/repo";
import { type Actor } from "@/server/aws/clients";
import { mapLimit } from "@/server/aws/paginate";
import type { HistoryRepo } from "@/server/git/history-repo";
import { assetContentHash } from "@/server/history/content-hash";
import { assetLabel } from "@/server/history/display-name";
import { fillTemplate } from "@/server/history/layout";
import { snapshotsToLiveRefs } from "@/server/packages/live";
import { createPlan as plansCreatePlan } from "@/server/plans";
import type { CreatePlan, PlanItemInput, RollbackTarget } from "@/server/plans/contract";
import { getAppPolicy, getPolicyForRepo, type Policy } from "@/server/policy";
import { getSpaceById, type SpaceRow } from "@/server/spaces/queries";
import { validateAssetSet } from "@/server/validation/set";
import { error, hasErrors, type ValidationResult } from "@/server/validation/types";
import { COMMIT_INPUT, RELEASES, shortCommit } from "./config";
import { ReleaseError } from "./errors";
import { manifestAssets, parseManifest, scanSpaceAssets } from "./manifest";
import { commitsForVersion, getRelease } from "./queries";
import {
  buildRollbackItems,
  classifyRollback,
  countActions,
  type CurrentAsset,
  type RollbackAction,
  type RollbackRow,
  type RollbackScope,
  type TargetAsset,
} from "./rollback-plan";
import { fillFromService, readAssetFilesAt, readAssetJsonAt, resolveCommit, serviceVersionFetcher, type FetchVersion } from "./source";

/**
 * Rollback plans. A
 * rollback is a plan whose desired state is older content, so it gets the
 * same check, diff, validation and approval as any other change. This module
 * reads the target from git (and from the service for files git doesn't
 * hold), runs the pure planner (rollback-plan.ts), and creates the plan with
 * createPlan. Reads only: safe in the web process.
 */

export const rollbackTargetRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("release"), releaseId: z.string().uuid() }),
  z.object({ kind: z.literal("commit"), commit: z.string().trim().toLowerCase().regex(COMMIT_INPUT, "Enter a commit hash") }),
  z.object({ kind: z.literal("version"), assetId: z.string().regex(URL_ASSET_ID, "Unknown asset"), version: z.coerce.number().int().min(1) }),
]);

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

export const createRollbackPlanRequest = z.object({
  spaceId: z.string().uuid(),
  target: rollbackTargetRequest,
  reason: z.preprocess(blankToNull, z.string().trim().max(2000).nullable().default(null)),
  /** Plan title from the form; null uses policy releases.rollback.titles */
  title: z.preprocess(blankToNull, z.string().trim().nullable().default(null)),
});

export type RollbackTargetRequest = z.input<typeof rollbackTargetRequest>;
export type CreateRollbackPlanRequest = z.input<typeof createRollbackPlanRequest>;

export interface RollbackDeps {
  /** Reads a version from the service (default: the space's read role, see serviceVersionFetcher) */
  fetchVersion?: FetchVersion;
  /** Client for the default fetchVersion (tests pass a mocked one) */
  client?: DevOpsAgentClient;
  /** Defaults to createPlan from "@/server/plans" */
  createPlan?: CreatePlan;
}

export interface RollbackPreview {
  /** The resolved target, as stored with the plan */
  target: RollbackTarget;
  scope: RollbackScope;
  title: string;
  /** The history commit the target's assets come from (null for a version read only from the service) */
  sourceCommit: string | null;
  rows: RollbackRow[];
  counts: Record<RollbackAction, number>;
  /** Plan items (with file contents); not sent to the browser, see RollbackPreviewView */
  items: PlanItemInput[];
  deletes: { assetId: string; note?: string }[];
  /** Problems found while planning. Errors block createRollbackPlan. */
  problems: ValidationResult[];
  /** validateAssetSet of the items against the index; the plan check validates again against live */
  validation: ValidationResult[];
  blocked: boolean;
}

interface TargetSource {
  asset: TargetAsset;
  /** Where the files are in git, or null for a version read from the service */
  commit: string | null;
  gitPath: string | null;
  /** Content hash recorded in a release manifest, checked against git */
  contentHash: string | null;
  fetched: AssetSnapshot | null;
}

interface ResolvedTarget {
  target: RollbackTarget;
  scope: RollbackScope;
  title: string;
  sourceCommit: string | null;
  sources: TargetSource[];
  problems: ValidationResult[];
}

function toCurrent(row: IndexedAsset): CurrentAsset {
  const m = row.metadata;
  return {
    assetId: row.assetId,
    assetType: row.assetType,
    name: row.name,
    parentAssetId: row.parentAssetId,
    metadata: m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {},
    liveVersion: row.liveVersion ?? row.lastSyncedVersion,
    liveUpdatedAt: (row.liveUpdatedAt ?? row.lastSyncedUpdatedAt)?.toISOString() ?? null,
    deleted: row.deletedAt !== null,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : String(err);
}

async function resolveTarget(
  space: SpaceRow,
  repo: HistoryRepo,
  policy: Policy,
  request: z.output<typeof rollbackTargetRequest>,
  fetchVersion: FetchVersion,
): Promise<ResolvedTarget> {
  const titles = policy.releases.rollback.titles;
  const layout = policy.historyLayout;
  if (request.kind === "release") {
    const row = await getRelease(space.id, request.releaseId);
    if (!row) throw new ReleaseError("That release doesn't exist in this space.");
    const manifest = parseManifest(row.manifest);
    if (!manifest) throw new ReleaseError(`The manifest of release ${row.name} can't be read.`);
    const commit = await resolveCommit(repo, manifest.sourceCommit);
    if (!commit) throw new ReleaseError(`The history repository doesn't have commit ${shortCommit(manifest.sourceCommit)}, which release ${row.name} lists its assets from.`);
    return {
      target: { kind: "release", releaseId: row.id, name: row.name },
      scope: "space",
      title: fillTemplate(titles.release, { spaceAlias: space.alias, release: row.name, shortCommit: shortCommit(commit) }),
      sourceCommit: commit,
      sources: manifest.assets.map((a) => ({
        asset: { assetId: a.assetId, assetType: a.assetType, metadata: a.metadata, serviceVersion: a.serviceVersion, serviceUpdatedAt: a.serviceUpdatedAt },
        commit,
        gitPath: a.gitPath,
        contentHash: a.contentHash,
        fetched: null,
      })),
      problems: [],
    };
  }

  if (request.kind === "commit") {
    const commit = await resolveCommit(repo, request.commit);
    if (!commit) throw new ReleaseError(`The history repository has no commit ${request.commit}.`, { commit: "Unknown commit." });
    const scanned = await scanSpaceAssets(repo, layout, space.alias, commit);
    if (!scanned.assets.length) throw new ReleaseError(`No assets of ${space.alias} are recorded at commit ${shortCommit(commit)}.`, { commit: "No assets at this commit." });
    return {
      target: { kind: "commit", commit },
      scope: "space",
      title: fillTemplate(titles.commit, { spaceAlias: space.alias, shortCommit: shortCommit(commit) }),
      sourceCommit: commit,
      sources: manifestAssets(scanned.assets, policy).map((a) => ({
        asset: { assetId: a.assetId, assetType: a.assetType, metadata: a.metadata, serviceVersion: a.serviceVersion, serviceUpdatedAt: a.serviceUpdatedAt },
        commit,
        gitPath: a.gitPath,
        contentHash: null,
        fetched: null,
      })),
      problems: scanned.problems,
    };
  }

  // One service version of one asset: the latest state of that version in git, else the service.
  const row = await getIndexedAsset(space.id, request.assetId);
  if (!row) throw new ReleaseError("That asset is not recorded in this space.");
  const title = fillTemplate(titles.version, { spaceAlias: space.alias, assetName: assetLabel(policy, row), assetType: row.assetType, version: String(request.version) });
  const target: RollbackTarget = { kind: "version", assetId: row.assetId, version: request.version };
  const candidates: { commit: string; gitPath: string }[] = [];
  for (const c of await commitsForVersion(space.id, row.assetId, request.version)) {
    const p = c.gitPath ?? row.gitPath;
    if (p) candidates.push({ commit: c.commit, gitPath: p });
  }
  if (row.gitPath) {
    for (const c of await listAssetCommits(repo, row.gitPath, row.assetId, RELEASES.maxAssetCommits)) {
      if (c.trailers[TRAILERS.serviceVersion] === String(request.version)) candidates.push({ commit: c.hash, gitPath: row.gitPath });
    }
  }
  for (const c of candidates) {
    const json = await readAssetJsonAt(repo, c.commit, c.gitPath, layout);
    if (!json || json.assetId !== row.assetId || json.serviceVersion !== request.version) continue;
    return {
      target,
      scope: "asset",
      title,
      sourceCommit: c.commit,
      sources: [
        {
          asset: { assetId: json.assetId, assetType: json.assetType, metadata: json.metadata, serviceVersion: json.serviceVersion, serviceUpdatedAt: json.serviceUpdatedAt },
          commit: c.commit,
          gitPath: c.gitPath,
          contentHash: null,
          fetched: null,
        },
      ],
      problems: [],
    };
  }
  let fetched: AssetSnapshot | null;
  try {
    fetched = await fetchVersion({ assetId: row.assetId, assetType: row.assetType }, request.version);
  } catch (err) {
    throw new ReleaseError(`Version ${request.version} of ${row.name} is not in the history repository, and reading it from the service failed: ${message(err)}`);
  }
  if (!fetched) throw new ReleaseError(`Version ${request.version} of ${row.name} is not in the history repository, and the service doesn't have it.`);
  return {
    target,
    scope: "asset",
    title,
    sourceCommit: null,
    sources: [
      {
        asset: { assetId: row.assetId, assetType: fetched.assetType, metadata: fetched.metadata, serviceVersion: request.version, serviceUpdatedAt: fetched.updatedAt },
        commit: null,
        gitPath: null,
        contentHash: null,
        fetched,
      },
    ],
    problems: [],
  };
}

/** Files of one target asset, from git, with anything git lacks read from the service. */
async function loadTargetFiles(
  repo: HistoryRepo,
  policy: Policy,
  src: TargetSource,
  fetchVersion: FetchVersion,
  problems: ValidationResult[],
): Promise<{ files: AssetFileSnapshot[]; fetched: string[] } | null> {
  const a = src.asset;
  const assetKey = `${a.assetType}:${a.assetId}`;
  if (src.fetched) return { files: src.fetched.files, fetched: src.fetched.files.map((f) => f.path) };
  const json = await readAssetJsonAt(repo, src.commit!, src.gitPath!, policy.historyLayout);
  if (!json || json.assetId !== a.assetId) {
    problems.push(error("rollback.asset-json-missing", `The history repository has no asset.json for ${a.assetId} at ${src.gitPath} in commit ${shortCommit(src.commit!)}.`, { assetKey }));
    return null;
  }
  if (src.contentHash && assetContentHash(json.files) !== src.contentHash) {
    problems.push(error("rollback.manifest-mismatch", `The files of ${a.assetId} at commit ${shortCommit(src.commit!)} don't match the release manifest.`, { assetKey }));
    return null;
  }
  let files = await readAssetFilesAt(repo, src.commit!, src.gitPath!, json);
  let fetched: string[] = [];
  if (files.some((f) => f.content === undefined)) {
    let snap: AssetSnapshot | null = null;
    try {
      snap = await fetchVersion({ assetId: a.assetId, assetType: a.assetType }, json.serviceVersion);
    } catch (err) {
      problems.push(error("rollback.fetch-failed", `Reading version ${json.serviceVersion} of ${a.assetId} from the service failed: ${message(err)}`, { assetKey }));
    }
    const filled = fillFromService(files, snap);
    files = filled.files;
    fetched = filled.filled;
  }
  return { files, fetched };
}

/** The current files of an asset to set Inactive: HEAD in git, else the service. */
async function loadCurrentSnapshot(repo: HistoryRepo, policy: Policy, head: string | null, row: IndexedAsset, fetchVersion: FetchVersion, problems: ValidationResult[]): Promise<{ snap: AssetSnapshot; fetched: string[] } | null> {
  const assetKey = `${row.assetType}:${row.assetId}`;
  try {
    const json = head && row.gitPath ? await readAssetJsonAt(repo, head, row.gitPath, policy.historyLayout) : null;
    if (json && json.assetId === row.assetId) {
      let files = await readAssetFilesAt(repo, head!, row.gitPath!, json);
      let fetched: string[] = [];
      if (files.some((f) => f.content === undefined)) {
        const filled = fillFromService(files, await fetchVersion({ assetId: row.assetId, assetType: row.assetType }, json.serviceVersion));
        files = filled.files;
        fetched = filled.filled;
      }
      return {
        snap: { assetId: row.assetId, assetType: row.assetType, version: json.serviceVersion, createdAt: json.serviceCreatedAt, updatedAt: json.serviceUpdatedAt, metadata: json.metadata, files },
        fetched,
      };
    }
    const version = row.liveVersion ?? row.lastSyncedVersion;
    if (version === null) return null;
    const snap = await fetchVersion({ assetId: row.assetId, assetType: row.assetType }, version);
    if (!snap) return null;
    return { snap: { ...snap, version, updatedAt: (row.liveUpdatedAt ?? row.lastSyncedUpdatedAt)?.toISOString() ?? "" }, fetched: snap.files.map((f) => f.path) };
  } catch (err) {
    problems.push(error("rollback.fetch-failed", `Reading the current version of ${row.name} failed: ${message(err)}`, { assetKey }));
    return null;
  }
}

/**
 * Work out what a rollback plan will contain, without creating it. Used by
 * the preview loader and by createRollbackPlan. The caller has checked that
 * the user may read the space's history.
 */
export async function planRollback(space: SpaceRow, request: RollbackTargetRequest, actor: Actor, deps: RollbackDeps = {}): Promise<RollbackPreview> {
  const parsed = rollbackTargetRequest.parse(request);
  const opened = await openSpaceHistoryRepo(space);
  if (!opened.ok) throw new ReleaseError(opened.message);
  const repo = opened.repo;
  const policy = getPolicyForRepo(repo.dir).policy;
  const fetchVersion = deps.fetchVersion ?? serviceVersionFetcher(space, actor, policy, deps.client);

  const resolved = await resolveTarget(space, repo, policy, parsed, fetchVersion);
  const problems = [...resolved.problems];
  const indexRows = await listIndexedAssets(space.id, { includeDeleted: true });
  const current = indexRows.map(toCurrent);
  const targets = resolved.sources.map((s) => s.asset);
  const classification = classifyRollback({ scope: resolved.scope, targets, current, policy });

  const sourceById = new Map(resolved.sources.map((s) => [s.asset.assetId, s]));
  const targetFiles = new Map<string, AssetFileSnapshot[]>();
  const fetchedPaths = new Map<string, string[]>();
  await mapLimit(classification.restore, RELEASES.gitReadConcurrency, async (e) => {
    const loaded = await loadTargetFiles(repo, policy, sourceById.get(e.target.assetId)!, fetchVersion, problems);
    if (!loaded) return;
    targetFiles.set(e.target.assetId, loaded.files);
    if (loaded.fetched.length) fetchedPaths.set(e.target.assetId, loaded.fetched);
  });

  const head = await repo.head();
  const rowById = new Map(indexRows.map((r) => [r.assetId, r]));
  const deactivateSnapshots = new Map<string, AssetSnapshot>();
  const deactivating = classification.addedAfter.filter((a) => a.action === "deactivate");
  await mapLimit(deactivating, RELEASES.fetchConcurrency, async (a) => {
    const loaded = await loadCurrentSnapshot(repo, policy, head, rowById.get(a.current.assetId)!, fetchVersion, problems);
    if (!loaded) return;
    deactivateSnapshots.set(a.current.assetId, loaded.snap);
    if (loaded.fetched.length) fetchedPaths.set(a.current.assetId, loaded.fetched);
  });

  const built = buildRollbackItems({ classification, policy, targets, current, targetFiles, deactivateSnapshots, fetchedPaths });
  problems.push(...built.problems);
  const live = snapshotsToLiveRefs(current.filter((c) => !c.deleted));
  const validation = built.items.length ? validateAssetSet(built.items.map((i) => i.desired), { policy, live }) : [];
  return {
    target: resolved.target,
    scope: resolved.scope,
    title: resolved.title,
    sourceCommit: resolved.sourceCommit,
    rows: built.rows,
    counts: countActions(built.rows),
    items: built.items,
    deletes: built.deletes,
    problems,
    validation,
    blocked: hasErrors(problems),
  };
}

export interface CreateRollbackPlanResult {
  planId: string;
  checkRunId: string;
  title: string;
  counts: Record<RollbackAction, number>;
  /** Warnings found while planning (errors refuse the plan) */
  problems: ValidationResult[];
}

/**
 * Create a rollback plan. The caller (a Server Action) has checked
 * `plans.create` for the space; applying the plan needs `rollbacks.apply`
 * (applyPermissionFor on the plan's origin).
 */
export async function createRollbackPlan(request: CreateRollbackPlanRequest, actor: Actor & { name?: string | null }, deps: RollbackDeps = {}): Promise<CreateRollbackPlanResult> {
  const parsed = createRollbackPlanRequest.parse(request);
  const space = await getSpaceById(parsed.spaceId);
  if (!space) throw new ReleaseError("Space not found.");
  const titleMax = getAppPolicy().policy.plans.limits.titleMaxChars;
  if (parsed.title && parsed.title.length > titleMax) throw new ReleaseError(`Keep the title to ${titleMax} characters or fewer.`, { title: `Keep the title to ${titleMax} characters or fewer.` });
  const preview = await planRollback(space, parsed.target, actor, deps);
  const title = parsed.title ?? preview.title;
  const refuse = async (msg: string, problems: ValidationResult[]): Promise<never> => {
    await recordAuditEvent({
      actor,
      action: "rollback.plan",
      spaceId: space.id,
      targetType: "space",
      targetId: space.id,
      result: "error",
      details: { target: preview.target, title, error: msg, problems: problems.slice(0, 20).map((p) => p.message) },
    });
    throw new ReleaseError(msg, {}, problems);
  };
  if (preview.blocked) await refuse("This rollback can't be planned until the problems listed are fixed.", preview.problems.filter((p) => p.level === "error"));
  if (!preview.items.length && !preview.deletes.length) await refuse("Nothing to roll back: the target has no assets the app can restore.", []);

  const created = await (deps.createPlan ?? plansCreatePlan)(
    {
      spaceId: space.id,
      title,
      origin: { kind: "rollback", target: preview.target },
      items: preview.items,
      ...(preview.deletes.length ? { deletes: preview.deletes } : {}),
      reason: parsed.reason,
    },
    actor,
  );
  const listed = (action: RollbackAction) => preview.rows.filter((r) => r.action === action).slice(0, 100).map((r) => `${r.assetType}:${r.key}`);
  await recordAuditEvent({
    actor,
    action: "rollback.plan",
    spaceId: space.id,
    targetType: "plan",
    targetId: created.planId,
    details: {
      target: preview.target,
      title,
      sourceCommit: preview.sourceCommit,
      checkRunId: created.checkRunId,
      counts: preview.counts,
      kept: listed("keep"),
      skipped: listed("skip"),
      deletes: preview.deletes.map((d) => d.assetId),
      warnings: preview.problems.length,
    },
  });
  return { planId: created.planId, checkRunId: created.checkRunId, title, counts: preview.counts, problems: preview.problems };
}
