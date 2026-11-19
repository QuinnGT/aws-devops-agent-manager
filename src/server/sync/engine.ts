import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CloudTrailClient } from "@aws-sdk/client-cloudtrail";
import type { DevOpsAgentClient } from "@aws-sdk/client-devops-agent";
import { simpleGit } from "simple-git";
import { TRAILERS, type AssetJson, type AssetSnapshot } from "@/lib/assets/types";
import { type AssetChangeToAttribute, type Attribution, type AttributionDeps, attributeChanges, attributionKey } from "@/server/attribution";
import { type Actor, cloudTrailClient, devOpsAgentClient } from "@/server/aws/clients";
import { mapLimit } from "@/server/aws/paginate";
import { type FileChange, HistoryRepo } from "@/server/git/history-repo";
import { assetDir, assetDisplayName, fillTemplate, safeSegment, spaceRoot } from "@/server/history/layout";
import { findPlanItemByClientToken } from "@/server/plans/attribution";
import { getPolicyForRepo, type Policy } from "@/server/policy";
import type { StoreCommitPolicy } from "@/server/policy/sections/sync";
import { getHistoryRepoForSpace, getSpaceById, type Space, toAwsConfig, toHistoryRepoConfig } from "@/server/spaces/queries";
import { authorFor, fallbackAttribution } from "./author";
import { applyCommitPolicy, assignKinds, detectChanges, isIgnoredAttachment, orderChanges, type PlannedChange, resolveStorePolicy } from "./changes";
import { changedMetadataKeys, parseAssetJson, serializeJson } from "./content";
import { lastGoodSyncAt, withSucceededAt } from "./last-good";
import { withSpaceLock } from "./lock";
import { AssetGoneError, type LiveAsset, SpaceReader } from "./reader";
import { type IndexRow, getSyncStateRow, loadIndex, loadRecorded, patchIndex, patchSyncState, recordChange, upsertLive } from "./state";
import { planDelete, planMove, planWrite } from "./writer";

/**
 * The sync engine:
 * ListAssets since the cursor, ListAssetVersions for each changed asset, one
 * commit per change in time order across assets, then the index and cursor.
 * The first sync imports the full history; a reconcile also commits deletions.
 * Runs only in the worker (HistoryRepo enforces it).
 */

export type SyncMode = "baseline" | "incremental" | "reconcile";

export interface SyncDeps {
  actor: Actor;
  now?: () => Date;
  log?: (message: string, extra?: Record<string, unknown>) => void;
  progress?: (fraction: number, message?: string) => Promise<void>;
  cancelled?: () => Promise<boolean>;
  /** Override the DevOps Agent client (defaults to the space's read client) */
  client?: DevOpsAgentClient;
  /** Override the CloudTrail client passed to attribution */
  cloudTrail?: CloudTrailClient;
  /** Override the plan item lookup passed to attribution (defaults to the plans module's) */
  findPlanItemByClientToken?: AttributionDeps["findPlanItemByClientToken"];
}

export interface SyncResult {
  spaceId: string;
  mode: SyncMode;
  status: "succeeded" | "skipped" | "cancelled";
  /** Assets returned by ListAssets (plus pending assets read with GetAsset) */
  listed: number;
  /** Assets whose versions were read */
  changedAssets: number;
  /** Changes recorded (versions, metadata changes, deletions) */
  changes: number;
  /** New git commits */
  commits: number;
  /** Changes held back by a daily store policy until their UTC day is over */
  deferred: number;
  deleted: number;
  attributionFailed: boolean;
  pushed: boolean;
  pushError?: string;
  message?: string;
}

export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncError";
  }
}

function sameTime(a: Date | null | undefined, b: Date | null | undefined): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptyResult(spaceId: string, mode: SyncMode): SyncResult {
  return { spaceId, mode, status: "succeeded", listed: 0, changedAssets: 0, changes: 0, commits: 0, deferred: 0, deleted: 0, attributionFailed: false, pushed: false };
}

/** Sync one space. `mode: "reconcile"` does a full listing and commits deletions. */
export async function syncSpace(spaceId: string, deps: SyncDeps, opts: { mode?: "auto" | "reconcile" } = {}): Promise<SyncResult> {
  const space = await getSpaceById(spaceId);
  if (!space) throw new SyncError(`Space ${spaceId} is not registered.`);
  const repoRow = await getHistoryRepoForSpace(space);
  if (!repoRow) {
    await patchSyncState(spaceId, { status: "error", error: "The space has no history repository." });
    throw new SyncError(`Space ${space.alias} has no history repository.`);
  }
  const repoConfig = toHistoryRepoConfig(repoRow);
  const workingDir = HistoryRepo.workingDirFor(repoConfig);
  const waitSeconds = getPolicyForRepo(existsSync(workingDir) ? workingDir : null).policy.sync.lockWaitSeconds;

  const locked = await withSpaceLock(spaceId, waitSeconds, async () => {
    const now = deps.now ?? (() => new Date());
    // Rows written before last_result.succeededAt existed get it now, while the status still says whether the last run finished.
    const prev = await getSyncStateRow(spaceId);
    const good = lastGoodSyncAt(prev);
    const prevResult = prev?.lastResult && typeof prev.lastResult === "object" ? prev.lastResult : {};
    await patchSyncState(spaceId, { status: "running", lastSyncStartedAt: now(), error: null, ...(good ? { lastResult: withSucceededAt(prevResult, good) } : {}) });
    try {
      const repo = await HistoryRepo.open(repoConfig);
      const run = new SyncRun(space, repo, getPolicyForRepo(repo.dir).policy, deps, opts.mode === "reconcile");
      return await run.execute();
    } catch (err) {
      await patchSyncState(spaceId, { status: "error", error: errorMessage(err), lastSyncCompletedAt: now() });
      throw err;
    }
  });
  if (!locked.acquired) {
    return { ...emptyResult(spaceId, opts.mode === "reconcile" ? "reconcile" : "incremental"), status: "skipped", message: "Another sync of this space is still running." };
  }
  return locked.value;
}

/** One asset an apply wrote (or will delete), for recordAppliedVersions. */
export interface AppliedAsset {
  assetId: string;
  assetType: string;
  /**
   * The app's writes to this asset: every version (or in-place updatedAt)
   * after `before` is recorded as an app change. `before` is the live state
   * just before the first write, null for a create. Null `app` records only
   * the versions not yet in git, with the usual attribution (used to commit
   * an asset's current version before deleting it).
   */
  app: { before: { version: number; updatedAt: Date } | null } | null;
  /** The apply deleted the asset: commit the deletion as an app change */
  deleted?: boolean;
  /** Git note added to the asset's last app commit (the change reason), once */
  note?: { text: string; marker: string } | null;
}

export interface RecordAppliedInput {
  spaceId: string;
  planId: string;
  /** The app user who started the apply: the commit author and Principal */
  appUser: string;
  /** Lines added to each app commit's message body (plan title, approver) */
  body?: string[];
  assets: AppliedAsset[];
}

export interface RecordedCommit {
  assetId: string;
  version: number;
  updatedAt: string;
  commit: string;
  app: boolean;
  deleted?: boolean;
}

export interface RecordAppliedResult {
  commits: RecordedCommit[];
  /** The asset's last commit after recording (its last app commit, or the commit that already held it) */
  lastCommitByAsset: Record<string, string>;
  /** Commits that got a note in this call */
  notes: { assetId: string; commit: string }[];
  /** HEAD of the history repository after recording: the commit a release of this apply points at */
  head: string | null;
  pushed: boolean;
  pushError?: string;
}

/**
 * Record versions written by a plan apply in git and in asset_index and
 * asset_changes, attributed to the app (source "app", the app user as
 * principal, the Plan-Id trailer), so the next sync doesn't commit them
 * again. Versions of these assets that are not in git yet and are older than
 * the app's writes are committed first with the usual attribution. Pushes
 * through HistoryRepo.push (a no-op unless the repository has push on).
 *
 * Takes the space's sync lock unless `lock: false` (the caller already holds
 * it through withSpaceLock, as the apply job does for its whole run).
 */
export async function recordAppliedVersions(input: RecordAppliedInput, deps: SyncDeps, opts: { lock?: boolean } = {}): Promise<RecordAppliedResult> {
  const space = await getSpaceById(input.spaceId);
  if (!space) throw new SyncError(`Space ${input.spaceId} is not registered.`);
  const repoRow = await getHistoryRepoForSpace(space);
  if (!repoRow) throw new SyncError(`Space ${space.alias} has no history repository.`);
  const repoConfig = toHistoryRepoConfig(repoRow);
  const run = async () => {
    const repo = await HistoryRepo.open(repoConfig);
    return new SyncRun(space, repo, getPolicyForRepo(repo.dir).policy, deps, false).recordApplied(input);
  };
  if (opts.lock === false) return run();
  const waitSeconds = getPolicyForRepo(null).policy.sync.lockWaitSeconds;
  const locked = await withSpaceLock(input.spaceId, waitSeconds, run);
  if (!locked.acquired) throw new SyncError("A sync of this space is still running; the applied versions are recorded by the next sync.");
  return locked.value;
}

class SyncRun {
  private readonly now: () => Date;
  private readonly log: NonNullable<SyncDeps["log"]>;
  private readonly layout: Policy["historyLayout"];
  private readonly reader: SpaceReader;
  private index = new Map<string, IndexRow>();
  private recorded = new Map<string, Map<number, Date>>();
  /** Store ID to the store name its memories' directories use in git */
  private readonly storeGitNames = new Map<string, string>();
  /** Store ID to the store's live name (commit policies are keyed by it) */
  private readonly storeLiveNames = new Map<string, string>();
  /** Last committed asset.json per asset, read from the working tree on first use */
  private readonly assetJsonCache = new Map<string, AssetJson | null>();
  private pendingSpaceJson: FileChange | null = null;
  private cloudTrail: CloudTrailClient | null = null;
  private result!: SyncResult;

  constructor(
    private readonly space: Space,
    private readonly repo: HistoryRepo,
    private readonly policy: Policy,
    private readonly deps: SyncDeps,
    private readonly reconcile: boolean,
  ) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
    this.layout = policy.historyLayout;
    this.reader = new SpaceReader(deps.client ?? devOpsAgentClient(toAwsConfig(space), "read", deps.actor), {
      agentSpaceId: space.agentSpaceId,
      pageSize: policy.api.pageSize,
      versionsPageSize: policy.sync.versionsPageSize,
      concurrency: policy.sync.concurrency,
      zipMinFiles: policy.sync.zipMinFiles,
      maxCommittedFileBytes: policy.historyLayout.maxCommittedFileBytes,
    });
  }

  private async progress(fraction: number, message: string): Promise<void> {
    await this.deps.progress?.(fraction, message);
  }

  /** True when no reconcile has run yet, or the last one is older than sync.reconcile.maxAgeHours. */
  private reconcileOverdue(lastReconcileAt: Date | null | undefined): boolean {
    if (!lastReconcileAt) return true;
    return this.now().getTime() - lastReconcileAt.getTime() >= this.policy.sync.reconcile.maxAgeHours * 3_600_000;
  }

  async execute(): Promise<SyncResult> {
    const spaceId = this.space.id;
    const state = await getSyncStateRow(spaceId);
    const mode: SyncMode = this.reconcile ? "reconcile" : !state?.baselineCompletedAt ? "baseline" : this.reconcileOverdue(state.lastReconcileAt) ? "reconcile" : "incremental";
    if (mode === "reconcile" && !this.reconcile) {
      this.log("the last reconcile is overdue, so this sync runs as a reconcile", { lastReconcileAt: state?.lastReconcileAt?.toISOString() ?? null });
    }
    this.result = emptyResult(spaceId, mode);
    const conc = this.policy.sync.concurrency;

    this.index = await loadIndex(spaceId);
    this.recorded = await loadRecorded(spaceId);
    await this.prepareSpaceJson();

    // 1. List assets: everything on the first sync and on reconcile, otherwise since the cursor.
    const cursor = state?.updatedAfter ?? null;
    const listAfter = mode === "incremental" && cursor ? new Date(cursor.getTime() - this.policy.sync.cursorOverlapSeconds * 1000) : undefined;
    const live = (await this.reader.listAssets(listAfter)).filter((a) => !isIgnoredAttachment(a, this.policy.sync.ignoredAttachmentPrefixes));
    const liveById = new Map(live.map((a) => [a.assetId, a]));
    this.result.listed = live.length;
    await this.progress(0.05, `Listed ${live.length} assets`);

    this.initStoreNames(live);

    // Deletions are decided on the full listing, before anything is committed.
    const missing = mode === "reconcile" ? [...this.index.values()].filter((i) => !i.deletedAt && !liveById.has(i.assetId)) : [];
    this.checkDeleteGuard(missing.length);

    // Assets with versions not yet in git (daily deferrals, interrupted runs) that the listing didn't return.
    if (mode === "incremental") {
      const pending = [...this.index.values()].filter(
        (i) => !liveById.has(i.assetId) && this.isPending(i) && this.policyFor(i.assetId, i.assetType, i.parentAssetId) !== "ignore",
      );
      const fetched = await mapLimit(pending, conc, (i) => this.reader.getAsset(i.assetId));
      for (const a of fetched) {
        if (!a) continue;
        live.push(a);
        liveById.set(a.assetId, a);
      }
      this.result.listed = live.length;
    }

    const reappeared = new Set(live.filter((a) => this.index.get(a.assetId)?.deletedAt).map((a) => a.assetId));
    const candidates = live.filter((a) => {
      const i = this.index.get(a.assetId);
      if (!i || i.deletedAt) return true;
      if (i.liveVersion !== a.version || !sameTime(i.liveUpdatedAt, a.updatedAt)) return true;
      return this.isPending(i);
    });

    // 2. Record the live state of every listed asset.
    await upsertLive(live.map((a) => this.liveValues(a)));
    this.index = await loadIndex(spaceId);

    // 3. Versions of each changed asset, filtered by the store commit policy.
    const planned: PlannedChange[] = [];
    await mapLimit(candidates, conc, async (a) => {
      const policy = this.policyFor(a.assetId, a.assetType, storeIdOf(a));
      if (policy === "ignore") return;
      let versions;
      try {
        versions = await this.reader.listVersions(a.assetId);
      } catch (err) {
        if (err instanceof AssetGoneError) return;
        throw err;
      }
      this.result.changedAssets++;
      const i = this.index.get(a.assetId);
      const isBack = reappeared.has(a.assetId);
      const found = detectChanges(a, versions, {
        lastSyncedVersion: i?.lastSyncedVersion ?? null,
        lastSyncedUpdatedAt: i?.lastSyncedUpdatedAt ?? null,
        recorded: this.recorded.get(a.assetId) ?? new Map(),
        reappeared: isBack,
      });
      const { commit, deferred } = applyCommitPolicy(found, policy, this.now());
      this.result.deferred += deferred;
      planned.push(...assignKinds(commit, (i?.lastSyncedVersion ?? null) !== null));
    });
    const ordered = orderChanges(planned, this.policy.sync.typeOrder);
    await this.progress(0.15, `Found ${ordered.length} changes in ${this.result.changedAssets} assets`);

    // 4. Fetch, attribute and commit in batches, oldest change first.
    const cancelled = await this.commitChanges(ordered, reappeared);
    if (cancelled) return this.finish(state, mode, live, true);

    // 5. Deletions (reconcile only).
    if (missing.length) await this.commitDeletions(missing);

    // 6. space.json on its own when nothing else was committed.
    if (this.pendingSpaceJson) await this.commitSpaceJsonAlone();

    return this.finish(state, mode, live, false);
  }

  // ---------- versions written by a plan apply ----------

  async recordApplied(input: RecordAppliedInput): Promise<RecordAppliedResult> {
    const spaceId = this.space.id;
    this.result = emptyResult(spaceId, "incremental");
    this.index = await loadIndex(spaceId);
    this.recorded = await loadRecorded(spaceId);
    await this.prepareSpaceJson();
    const appAttribution: Attribution = {
      source: "app",
      label: this.policy.attribution.labels.app,
      principal: input.appUser,
      cloudTrailEventId: null,
      planId: input.planId,
      matchedBy: "clientToken",
    };

    const live: LiveAsset[] = [];
    for (const a of input.assets) {
      if (a.deleted) continue;
      const l = await this.reader.getAsset(a.assetId);
      if (l) live.push(l);
    }
    if (live.length) {
      await upsertLive(live.map((a) => this.liveValues(a)));
      this.index = await loadIndex(spaceId);
    }
    this.initStoreNames(live);

    type Planned = PlannedChange & { app: boolean };
    const planned: Planned[] = [];
    for (const a of live) {
      const entry = input.assets.find((x) => x.assetId === a.assetId)!;
      const storePolicy = this.policyFor(a.assetId, a.assetType, storeIdOf(a));
      const i = this.index.get(a.assetId);
      const versions = await this.reader.listVersions(a.assetId).catch((err) => {
        if (err instanceof AssetGoneError) return [];
        throw err;
      });
      const found = detectChanges(a, versions, {
        lastSyncedVersion: i?.lastSyncedVersion ?? null,
        lastSyncedUpdatedAt: i?.lastSyncedUpdatedAt ?? null,
        recorded: this.recorded.get(a.assetId) ?? new Map(),
      });
      for (const c of assignKinds(found, (i?.lastSyncedVersion ?? null) !== null)) {
        const before = entry.app?.before;
        const isApp = entry.app !== null && (!before || c.version > before.version || (c.version === before.version && c.updatedAt.getTime() > before.updatedAt.getTime()));
        // The app's own writes are recorded whatever the store's commit policy; other versions follow it.
        if (!isApp && storePolicy !== "every-version") continue;
        planned.push({ ...c, app: isApp });
      }
    }
    const ordered = orderChanges(planned, this.policy.sync.typeOrder);
    const attributionFor = await this.attribute(ordered.filter((c) => !c.app));
    const commits: RecordedCommit[] = [];
    const lastApp = new Map<string, string>();
    for (const c of ordered) {
      const snapshot = await this.reader.snapshot(c, c);
      const commit = await this.commitOne(c, snapshot, c.app ? appAttribution : attributionFor(c), false, c.app ? (input.body ?? []) : []);
      commits.push({ assetId: c.assetId, version: c.version, updatedAt: c.updatedAt.toISOString(), commit, app: c.app });
      if (c.app) lastApp.set(c.assetId, commit);
    }

    for (const a of input.assets) {
      if (!a.deleted) continue;
      const i = this.index.get(a.assetId);
      if (!i || i.deletedAt) continue;
      const version = i.liveVersion ?? i.lastSyncedVersion ?? 0;
      const commit = await this.commitAppDeletion(i, appAttribution);
      if (commit) {
        commits.push({ assetId: a.assetId, version, updatedAt: (i.deletedAt ?? this.now()).toISOString(), commit, app: true, deleted: true });
        lastApp.set(a.assetId, commit);
      }
    }

    const lastCommitByAsset: Record<string, string> = {};
    for (const a of input.assets) {
      const c = lastApp.get(a.assetId) ?? this.index.get(a.assetId)?.lastCommit ?? null;
      if (c) lastCommitByAsset[a.assetId] = c;
    }

    const notes: { assetId: string; commit: string }[] = [];
    const notesRef = this.layout.notesRef;
    for (const a of input.assets) {
      const commit = lastCommitByAsset[a.assetId];
      if (!a.note || !commit) continue;
      const marker = a.note.marker;
      const existing = await this.repo.note(commit, notesRef);
      if (existing?.split("\n").some((l) => l.trim() === marker)) continue;
      await this.repo.addNote(commit, a.note.text, notesRef, { author: authorFor(appAttribution, this.policy.sync.syntheticEmailDomain), committer: this.policy.sync.committer });
      notes.push({ assetId: a.assetId, commit });
    }

    let pushed = false;
    let pushError: string | undefined;
    try {
      pushed = await this.repo.push((await refExists(this.repo.dir, notesRef)) ? notesRef : undefined);
    } catch (err) {
      pushError = errorMessage(err);
      this.log("push failed after recording applied versions", { error: pushError });
    }
    return { commits, lastCommitByAsset, notes, head: await this.repo.head(), pushed, ...(pushError ? { pushError } : {}) };
  }

  /** Commit the deletion of one asset by the app (the apply's DeleteAsset). */
  private async commitAppDeletion(i: IndexRow, attribution: Attribution): Promise<string | null> {
    const detectedAt = this.now();
    if (!i.gitPath) {
      await patchIndex(this.space.id, i.assetId, { deletedAt: detectedAt });
      i.deletedAt = detectedAt;
      return null;
    }
    const version = i.liveVersion ?? i.lastSyncedVersion ?? 0;
    const previous = await this.readAssetJson(i.assetId, i.gitPath);
    const plan = planDelete({ oldDir: i.gitPath, previous, assetJsonName: this.layout.assetJson });
    const commit = await this.commit(
      plan.changes,
      {
        message: this.subject("deleted", { assetType: i.assetType, name: i.name, version }),
        author: authorFor(attribution, this.policy.sync.syntheticEmailDomain),
        committer: this.policy.sync.committer,
        date: detectedAt,
        trailers: this.trailers({ assetId: i.assetId, assetType: i.assetType, version, updatedAt: detectedAt }, attribution),
      },
      i.gitPath,
    );
    await recordChange(
      {
        spaceId: this.space.id,
        assetId: i.assetId,
        serviceVersion: version,
        serviceUpdatedAt: detectedAt,
        changeKind: "deleted",
        commit,
        changeSource: attribution.source,
        changeSourceLabel: attribution.label,
        principal: attribution.principal,
        cloudTrailEventId: attribution.cloudTrailEventId,
        planId: attribution.planId,
        attributionMatchedBy: attribution.matchedBy,
        gitPath: i.gitPath,
      },
      { deletedAt: detectedAt, lastCommit: commit },
    );
    i.deletedAt = detectedAt;
    i.lastCommit = commit;
    this.assetJsonCache.delete(i.assetId);
    return commit;
  }

  // ---------- state helpers ----------

  private isPending(i: IndexRow): boolean {
    if (i.deletedAt || i.liveVersion === null) return false;
    return i.lastSyncedVersion !== i.liveVersion || !sameTime(i.lastSyncedUpdatedAt, i.liveUpdatedAt);
  }

  private initStoreNames(live: LiveAsset[]): void {
    for (const i of this.index.values()) {
      if (i.assetType !== "memory_store") continue;
      this.storeLiveNames.set(i.assetId, i.name);
      if (i.gitPath && !i.deletedAt) this.storeGitNames.set(i.assetId, i.name);
    }
    for (const a of live) {
      if (a.assetType === "memory_store") this.storeLiveNames.set(a.assetId, assetDisplayName(this.layout, a));
    }
  }

  private policyFor(assetId: string, assetType: string, storeId: string | null): StoreCommitPolicy {
    const id = assetType === "memory_store" ? assetId : assetType === "memory" ? storeId : null;
    if (!id) return "every-version";
    return resolveStorePolicy(this.storeLiveNames.get(id) ?? null, this.policy.sync, this.space.parsedSettings.storeCommitPolicies);
  }

  private liveValues(a: LiveAsset) {
    const i = this.index.get(a.assetId);
    const committed = Boolean(i?.gitPath) && !i?.deletedAt;
    return {
      spaceId: this.space.id,
      assetId: a.assetId,
      assetType: a.assetType,
      name: committed ? i!.name : assetDisplayName(this.layout, a),
      parentAssetId: committed ? i!.parentAssetId : storeIdOf(a),
      liveVersion: a.version,
      liveUpdatedAt: a.updatedAt,
      metadata: committed ? i!.metadata : a.metadata,
      createdAt: a.createdAt,
    };
  }

  private checkDeleteGuard(missing: number): void {
    const liveCount = [...this.index.values()].filter((i) => !i.deletedAt).length;
    const { maxDeleteFraction, guardMinAssets } = this.policy.sync.reconcile;
    if (missing > 0 && liveCount >= guardMinAssets && missing > maxDeleteFraction * liveCount) {
      throw new SyncError(
        `Reconcile stopped: ${missing} of ${liveCount} known assets are missing from the space, more than the limit of ${Math.round(maxDeleteFraction * 100)}%. Check the space's read access, then run the reconcile again or raise sync.reconcile.maxDeleteFraction.`,
      );
    }
  }

  private async readAssetJson(assetId: string, dir: string): Promise<AssetJson | null> {
    const cached = this.assetJsonCache.get(assetId);
    if (cached) return cached;
    const json = parseAssetJson(await this.repo.readFile(path.posix.join(dir, this.layout.assetJson)));
    this.assetJsonCache.set(assetId, json);
    return json;
  }

  /** A directory not used by another live asset (two names can map to the same safe path). */
  private uniqueDir(dir: string, assetId: string): string {
    const taken = [...this.index.values()].some((i) => i.assetId !== assetId && !i.deletedAt && i.gitPath === dir);
    return taken ? `${dir}~${safeSegment(assetId)}` : dir;
  }

  private dirFor(assetId: string, assetType: string, metadata: Record<string, unknown>): string {
    const storeId = typeof metadata.memory_store_id === "string" ? metadata.memory_store_id : null;
    const storeName = assetType === "memory" && storeId ? (this.storeGitNames.get(storeId) ?? this.storeLiveNames.get(storeId) ?? null) : null;
    return assetDir(this.layout, this.space.alias, { assetId, assetType, metadata, storeName });
  }

  private async prepareSpaceJson(): Promise<void> {
    const p = path.posix.join(spaceRoot(this.layout, this.space.alias), this.layout.spaceFile);
    const content = serializeJson({
      alias: this.space.alias,
      displayName: this.space.displayName ?? null,
      agentSpaceId: this.space.agentSpaceId,
      region: this.space.region,
      accountId: this.space.accountId,
    });
    this.pendingSpaceJson = (await this.repo.readFile(p)) === content ? null : { path: p, content };
  }

  private subject(kind: keyof Policy["sync"]["commitMessages"], values: { assetType?: string; name?: string; version?: number }): string {
    const assetType = values.assetType ?? "";
    return fillTemplate(this.policy.sync.commitMessages[kind], {
      assetType,
      typeLabel: this.policy.assetTypes.assetTypes[assetType]?.label ?? assetType,
      name: values.name ?? "",
      version: values.version === undefined ? "" : String(values.version),
      spaceAlias: this.space.alias,
    });
  }

  private trailers(c: { assetId: string; assetType: string; version: number; updatedAt: Date }, a: Attribution) {
    return {
      [TRAILERS.assetId]: c.assetId,
      [TRAILERS.assetType]: c.assetType,
      [TRAILERS.serviceVersion]: c.version,
      [TRAILERS.serviceUpdatedAt]: c.updatedAt.toISOString(),
      [TRAILERS.changeSource]: a.source,
      [TRAILERS.principal]: a.principal,
      [TRAILERS.cloudTrailEventId]: a.cloudTrailEventId,
      [TRAILERS.planId]: a.planId,
      [TRAILERS.spaceAlias]: this.space.alias,
    };
  }

  /**
   * The one place that builds attributeChanges deps. Optional attribution
   * fields (for example a scope with the space's account and Region) go here.
   */
  private attributionDeps(): AttributionDeps {
    this.cloudTrail ??= this.deps.cloudTrail ?? cloudTrailClient(toAwsConfig(this.space), this.deps.actor);
    return {
      cloudTrail: this.cloudTrail,
      policy: { attribution: this.policy.attribution },
      scope: { accountId: this.space.accountId, region: this.space.region },
      findPlanItemByClientToken: this.deps.findPlanItemByClientToken ?? findPlanItemByClientToken,
    };
  }

  /**
   * Attribute one batch of changes (one attributeChanges call). Returns a lookup
   * by change; a failure labels every change "unknown" and never fails the sync.
   */
  private async attribute(changes: AttributableChange[]): Promise<(c: AttributableChange) => Attribution> {
    const labels = this.policy.attribution.labels;
    if (!changes.length) return () => fallbackAttribution(labels, "none");
    try {
      const map = await attributeChanges(changes.map(toAttributionInput), this.attributionDeps());
      return (c) => map.get(attributionKey(toAttributionInput(c))) ?? fallbackAttribution(labels, "none");
    } catch (err) {
      this.result.attributionFailed = true;
      this.log("attribution failed; labeling changes as unknown", { error: errorMessage(err) });
      return () => fallbackAttribution(labels, "error");
    }
  }

  /** Commit, falling back to the last commit of the path when the content is already in git (an interrupted earlier run). */
  private async commit(changes: FileChange[], opts: Parameters<HistoryRepo["writeAndCommit"]>[1], probePath: string): Promise<string> {
    if (this.pendingSpaceJson) {
      changes = [...changes, this.pendingSpaceJson];
      this.pendingSpaceJson = null;
    }
    const hash = await this.repo.writeAndCommit(changes, opts);
    if (hash) {
      this.result.commits++;
      return hash;
    }
    const [last] = await this.repo.log({ path: probePath, maxCount: 1 });
    const head = last?.hash ?? (await this.repo.head());
    if (!head) throw new SyncError("Nothing to commit and the history repository has no commits.");
    return head;
  }

  // ---------- commits ----------

  private async commitChanges(ordered: PlannedChange[], reappeared: Set<string>): Promise<boolean> {
    const gone = new Set<string>();
    const batchSize = this.policy.sync.batchSize;
    const total = ordered.length;
    let done = 0;
    for (let start = 0; start < total; start += batchSize) {
      if (await this.deps.cancelled?.()) return true;
      const batch = ordered.slice(start, start + batchSize);
      const snapshots = new Map<PlannedChange, AssetSnapshot>();
      await mapLimit(batch, this.policy.sync.concurrency, async (c) => {
        if (gone.has(c.assetId)) return;
        try {
          snapshots.set(c, await this.reader.snapshot(c, c));
        } catch (err) {
          if (!(err instanceof AssetGoneError)) throw err;
          gone.add(c.assetId);
          this.log("asset disappeared during sync; the reconcile will record it", { assetId: c.assetId });
        }
      });
      const toCommit = batch.filter((c) => snapshots.has(c) && !gone.has(c.assetId));
      const attributionFor = await this.attribute(toCommit);
      for (const c of toCommit) {
        await this.commitOne(c, snapshots.get(c)!, attributionFor(c), reappeared.has(c.assetId));
        reappeared.delete(c.assetId);
      }
      done += batch.length;
      await this.progress(0.15 + 0.8 * (done / Math.max(1, total)), `Committed ${done} of ${total} changes`);
    }
    return false;
  }

  private async commitOne(c: PlannedChange, snapshot: AssetSnapshot, attribution: Attribution, reappeared: boolean, extraBody: string[] = []): Promise<string> {
    const i = this.index.get(c.assetId);
    const oldDir = i?.gitPath && !i.deletedAt && !reappeared ? i.gitPath : null;
    const previous = oldDir ? await this.readAssetJson(c.assetId, oldDir) : null;
    const newDir = this.uniqueDir(this.dirFor(c.assetId, c.assetType, snapshot.metadata), c.assetId);
    const plan = planWrite({ snapshot, newDir, oldDir, previous, assetJsonName: this.layout.assetJson });
    const changes = [...plan.changes];
    const name = assetDisplayName(this.layout, snapshot);
    const body: string[] = [];
    if (oldDir && oldDir !== newDir) body.push(`Moved from ${oldDir} to ${newDir}.`);

    // A renamed store moves its memories' directories in the same commit.
    const moved: { assetId: string; gitPath: string }[] = [];
    if (c.assetType === "memory_store") {
      const oldName = this.storeGitNames.get(c.assetId);
      this.storeGitNames.set(c.assetId, name);
      if (oldName !== undefined && oldName !== name) {
        for (const m of this.index.values()) {
          if (m.assetType !== "memory" || m.parentAssetId !== c.assetId || !m.gitPath || m.deletedAt) continue;
          const target = this.uniqueDir(this.dirFor(m.assetId, m.assetType, (m.metadata ?? {}) as Record<string, unknown>), m.assetId);
          if (target === m.gitPath) continue;
          const prev = await this.readAssetJson(m.assetId, m.gitPath);
          if (!prev) continue;
          changes.push(
            ...(await planMove({
              oldDir: m.gitPath,
              newDir: target,
              previous: prev,
              assetJsonName: this.layout.assetJson,
              read: (p) => readFile(path.join(this.repo.dir, p)).catch(() => null),
            })),
          );
          moved.push({ assetId: m.assetId, gitPath: target });
        }
        if (moved.length) body.push(`Moved ${moved.length} ${moved.length === 1 ? "memory" : "memories"} to the renamed store's directory.`);
      }
    }
    const keys = previous ? changedMetadataKeys(previous.metadata, plan.assetJson!.metadata) : [];
    if (keys.length) body.push(`Changed metadata: ${keys.join(", ")}.`);
    body.push(...extraBody);

    const subject = this.subject(c.kind, { assetType: c.assetType, name, version: c.version });
    const commit = await this.commit(
      changes,
      {
        message: body.length ? `${subject}\n\n${body.join("\n")}` : subject,
        author: authorFor(attribution, this.policy.sync.syntheticEmailDomain),
        committer: this.policy.sync.committer,
        date: c.updatedAt,
        trailers: this.trailers(c, attribution),
      },
      path.posix.join(newDir, this.layout.assetJson),
    );

    const latest = i?.lastSyncedVersion == null || c.version >= i.lastSyncedVersion;
    const patch = {
      name,
      metadata: plan.assetJson!.metadata,
      parentAssetId: storeIdOf(snapshot),
      gitPath: newDir,
      lastCommit: commit,
      lastSyncedVersion: latest ? c.version : i!.lastSyncedVersion,
      lastSyncedUpdatedAt: latest ? c.updatedAt : i!.lastSyncedUpdatedAt,
      deletedAt: null,
    };
    await recordChange(
      {
        spaceId: this.space.id,
        assetId: c.assetId,
        serviceVersion: c.version,
        serviceUpdatedAt: c.updatedAt,
        changeKind: c.kind,
        commit,
        changeSource: attribution.source,
        changeSourceLabel: attribution.label,
        principal: attribution.principal,
        cloudTrailEventId: attribution.cloudTrailEventId,
        planId: attribution.planId,
        attributionMatchedBy: attribution.matchedBy,
        attributionProvisional: attribution.provisional ?? false,
        gitPath: newDir,
      },
      patch,
      moved.map((m) => ({ assetId: m.assetId, patch: { gitPath: m.gitPath, lastCommit: commit } })),
    );
    this.result.changes++;
    if (i) Object.assign(i, patch);
    for (const m of moved) {
      const row = this.index.get(m.assetId);
      if (row) Object.assign(row, { gitPath: m.gitPath, lastCommit: commit });
    }
    this.assetJsonCache.set(c.assetId, plan.assetJson);
    let rec = this.recorded.get(c.assetId);
    if (!rec) this.recorded.set(c.assetId, (rec = new Map()));
    const prevRec = rec.get(c.version);
    if (!prevRec || prevRec < c.updatedAt) rec.set(c.version, c.updatedAt);
    return commit;
  }

  private async commitDeletions(missing: IndexRow[]): Promise<void> {
    const detectedAt = this.now();
    const rank = (t: string) => {
      const i = this.policy.sync.typeOrder.indexOf(t);
      return i === -1 ? this.policy.sync.typeOrder.length : i;
    };
    // Memories before their stores: reverse type order.
    const current = missing.map((m) => this.index.get(m.assetId) ?? m);
    const ordered = current.sort((a, b) => rank(b.assetType) - rank(a.assetType) || (a.assetId < b.assetId ? -1 : 1));
    const deletion = (i: IndexRow): AttributableChange => ({
      assetId: i.assetId,
      assetType: i.assetType,
      version: i.liveVersion ?? i.lastSyncedVersion ?? 0,
      createdAt: i.createdAt ?? detectedAt,
      updatedAt: detectedAt,
      kind: "deleted",
      detectedAt,
    });
    const attributionFor = await this.attribute(ordered.filter((i) => i.gitPath).map(deletion));
    for (const i of ordered) {
      if (!i.gitPath) {
        await patchIndex(this.space.id, i.assetId, { deletedAt: detectedAt });
        i.deletedAt = detectedAt;
        this.result.deleted++;
        continue;
      }
      const change = deletion(i);
      const version = change.version;
      const attribution = attributionFor(change);
      const previous = await this.readAssetJson(i.assetId, i.gitPath);
      const plan = planDelete({ oldDir: i.gitPath, previous, assetJsonName: this.layout.assetJson });
      const commit = await this.commit(
        plan.changes,
        {
          message: this.subject("deleted", { assetType: i.assetType, name: i.name, version }),
          author: authorFor(attribution, this.policy.sync.syntheticEmailDomain),
          committer: this.policy.sync.committer,
          date: detectedAt,
          trailers: this.trailers({ assetId: i.assetId, assetType: i.assetType, version, updatedAt: detectedAt }, attribution),
        },
        i.gitPath,
      );
      await recordChange(
        {
          spaceId: this.space.id,
          assetId: i.assetId,
          serviceVersion: version,
          serviceUpdatedAt: detectedAt,
          changeKind: "deleted",
          commit,
          changeSource: attribution.source,
          changeSourceLabel: attribution.label,
          principal: attribution.principal,
          cloudTrailEventId: attribution.cloudTrailEventId,
          planId: attribution.planId,
          attributionMatchedBy: attribution.matchedBy,
        attributionProvisional: attribution.provisional ?? false,
          gitPath: i.gitPath,
        },
        { deletedAt: detectedAt, lastCommit: commit },
      );
      i.deletedAt = detectedAt;
      i.lastCommit = commit;
      this.assetJsonCache.delete(i.assetId);
      this.result.changes++;
      this.result.deleted++;
    }
    await this.progress(0.97, `Recorded ${this.result.deleted} deletions`);
  }

  private async commitSpaceJsonAlone(): Promise<void> {
    const file = this.pendingSpaceJson!;
    await this.commit([], {
      message: this.subject("space", {}),
      author: this.policy.sync.committer,
      committer: this.policy.sync.committer,
      date: this.now(),
      trailers: { [TRAILERS.spaceAlias]: this.space.alias },
    }, file.path);
  }

  private async finish(state: Awaited<ReturnType<typeof getSyncStateRow>>, mode: SyncMode, live: LiveAsset[], cancelled: boolean): Promise<SyncResult> {
    const r = this.result;
    if (cancelled) {
      r.status = "cancelled";
      r.message = "Sync cancelled; the next sync continues where this one stopped.";
      // A cancelled run didn't record every change: keep the previous good sync's time.
      await patchSyncState(this.space.id, { status: "cancelled", lastSyncCompletedAt: this.now(), lastResult: withSucceededAt(r, lastGoodSyncAt(state)) });
      return r;
    }
    try {
      const notesRef = (await refExists(this.repo.dir, this.layout.notesRef)) ? this.layout.notesRef : undefined;
      r.pushed = await this.repo.push(notesRef);
    } catch (err) {
      r.pushError = errorMessage(err);
      this.log("push failed", { error: r.pushError });
    }
    let cursor = state?.updatedAfter ?? null;
    for (const a of live) if (!cursor || a.updatedAt > cursor) cursor = a.updatedAt;
    const completedAt = this.now();
    await patchSyncState(this.space.id, {
      status: r.pushError ? "error" : "succeeded",
      error: r.pushError ? `Changes were committed but the push failed: ${r.pushError}` : null,
      updatedAfter: cursor,
      lastSyncCompletedAt: completedAt,
      baselineCompletedAt: state?.baselineCompletedAt ?? completedAt,
      // A baseline lists every asset too, so it counts as a reconcile.
      ...(mode === "reconcile" || mode === "baseline" ? { lastReconcileAt: completedAt } : {}),
      lastResult: withSucceededAt(r, completedAt),
    });
    await this.progress(1, `Recorded ${r.changes} changes in ${r.commits} commits`);
    return r;
  }
}

/** A change as the sync engine sees it, before it is handed to attribution. */
type AttributableChange = Pick<PlannedChange, "assetId" | "assetType" | "version" | "createdAt" | "updatedAt"> & {
  kind: AssetChangeToAttribute["changeKind"];
  /** When the sync noticed the change (set for deletions, which have no service timestamp) */
  detectedAt?: Date;
};

/**
 * The one place that builds attributeChanges input. Optional per-change
 * attribution fields (for example the time the sync detected the change) go
 * here.
 */
function toAttributionInput(c: AttributableChange): AssetChangeToAttribute {
  return {
    assetId: c.assetId,
    assetType: c.assetType,
    serviceVersion: c.version,
    serviceCreatedAt: c.createdAt,
    serviceUpdatedAt: c.updatedAt,
    changeKind: c.kind,
    ...(c.detectedAt ? { detectedAt: c.detectedAt } : {}),
  };
}

function storeIdOf(a: { assetType: string; metadata: Record<string, unknown> }): string | null {
  const id = a.metadata.memory_store_id;
  return a.assetType === "memory" && typeof id === "string" ? id : null;
}

async function refExists(dir: string, ref: string): Promise<boolean> {
  try {
    await simpleGit({ baseDir: dir }).raw(["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}
