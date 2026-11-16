import { getSyncState } from "@/server/assets/queries";
import { openSpaceHistoryRepo } from "@/server/assets/repo";
import { getPolicyForRepo, getAppPolicy, type Policy } from "@/server/policy";
import { comparableFromManifest, diffManifests } from "@/server/releases/diff";
import { parseManifest, type ReleaseManifest } from "@/server/releases/manifest";
import { getReleaseByName, listReleases, type ReleaseRow } from "@/server/releases/queries";
import { connectionView } from "@/server/spaces/connection-state";
import type { SpaceRow } from "@/server/spaces/queries";
import { BLOCKED_MESSAGES } from "./config";
import { applyReadBack, investigationTitles, investigationsInWindow, listVerifications, loadReleaseWindow, type ApplyReadBack, type VerificationRow } from "./queries";
import type { BlockedReason, LiveCheckResult, ReadOutcome, ReadsCheckResult, ReadsFileRow, RecordExample, VerifyKind, VerifyState } from "./types";

/**
 * Data for the Verification section of the release page. Read-only.
 * The page authorizes `history.read` for the space first, and shows the
 * start buttons when the user has `sync.run` (VERIFY_PERMISSIONS).
 */

export interface VerificationRunSummary {
  id: string;
  kind: VerifyKind;
  state: VerifyState;
  trigger: "manual" | "journals";
  requestedBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** How long it ran, when it finished */
  durationMs: number | null;
  /** Investigations the check covered (reads) */
  investigationCount: number;
  blockedReason: BlockedReason | null;
  /** Plain sentence for a blocked or failed check */
  message: string | null;
  jobRunId: string | null;
}

export interface CheckView<R> {
  kind: VerifyKind;
  /** Newest run, whatever its state */
  latest: VerificationRunSummary | null;
  /** A queued or running run, for progress polling */
  open: VerificationRunSummary | null;
  /** Newest run that finished with a result, and the result */
  lastResult: { run: VerificationRunSummary; result: R } | null;
  /** Why the check can't run now, or null when it can */
  cannotRun: { reason: BlockedReason; message: string } | null;
  /** Recent runs, newest first */
  history: VerificationRunSummary[];
}

/** `title`: the investigation's title from the journal cache, for the link text; null when it has none or isn't cached */
export type RecordLink = RecordExample & { href: string; title?: string | null };

export interface ReadsFileView extends Omit<ReadsFileRow, "examples"> {
  examples: Partial<Record<ReadOutcome, RecordLink[]>>;
  /** The asset's status in the release manifest (ACTIVE, INACTIVE), when it has one */
  releaseStatus?: string | null;
}

export interface ReadsCheckView extends Omit<ReadsCheckResult, "files"> {
  files: ReadsFileView[];
}

export interface ReleaseVerificationView {
  release: { id: string; name: string; createdAt: string; sourceCommit: string; planId?: string | null };
  /** What the apply job read back, for a release tagged after applying a plan; null for a release made from the live state */
  applied?: ApplyReadBack | null;
  /** When the space's last sync finished */
  lastSyncAt?: string | null;
  /**
   * The last result is older than what it checked: live, the space synced
   * after the check; reads, the window now holds investigations the check
   * didn't count.
   */
  stale?: { live: boolean; reads: boolean };
  /** The investigations check 2 reads (policy verify.reads.window and maxInvestigations) */
  window: { mode: Policy["verify"]["reads"]["window"]; from: string; to: string | null; nextRelease: string | null; investigations: number; cap: number };
  /** Check 1 syncs first (policy verify.live.syncFirst) */
  syncFirst: boolean;
  /** Check 2 runs by itself after journal exports and imports (policy verify.reads.auto) */
  auto: Policy["verify"]["reads"]["auto"];
  live: CheckView<LiveCheckResult>;
  reads: CheckView<ReadsCheckView>;
  /**
   * What this release changed, against the release before it (by creation
   * time): the IDs, in this release, of assets with new content or metadata
   * and of assets new in it, and how many it removed. `previous` is null for
   * the space's first release, whose assets all count as changed. Null when
   * the manifest can't be read.
   */
  changes?: ReleaseChanges | null;
}

export interface ReleaseChanges {
  previous: string | null;
  assetIds: string[];
  removed: number;
}

/** The assets `manifest` changed against `previous` (null: the first release, every asset). Pure. */
export function releaseChanges(manifest: ReleaseManifest, previous: { name: string; manifest: ReleaseManifest } | null, statusKey: string): ReleaseChanges {
  if (!previous) return { previous: null, assetIds: manifest.assets.map((a) => a.assetId), removed: 0 };
  const diff = diffManifests(comparableFromManifest(previous.manifest.assets), comparableFromManifest(manifest.assets), { statusKey });
  const assetIds = diff.entries.filter((e) => e.after && (e.kind === "content" || e.kind === "metadata" || e.kind === "added")).map((e) => e.after!.assetId);
  return { previous: previous.name, assetIds, removed: diff.counts.removed };
}

/** The release created just before `release` in its space, with a readable manifest, or null. */
async function previousRelease(spaceId: string, release: ReleaseRow): Promise<{ name: string; manifest: ReleaseManifest } | null> {
  const rows = await listReleases(spaceId);
  const t = release.createdAt.getTime();
  const before = rows.filter((r) => r.id !== release.id && (r.createdAt.getTime() < t || (r.createdAt.getTime() === t && r.name < release.name)));
  const prev = before.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const manifest = prev ? parseManifest(prev.manifest) : null;
  return prev && manifest ? { name: prev.name, manifest } : null;
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function summary(r: VerificationRow): VerificationRunSummary {
  return {
    id: r.id,
    kind: r.kind,
    state: r.state,
    trigger: r.trigger,
    requestedBy: r.requestedBy,
    createdAt: r.createdAt.toISOString(),
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    durationMs: r.startedAt && r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
    investigationCount: r.investigationCount,
    blockedReason: (r.blockedReason as BlockedReason | null) ?? null,
    message: r.message,
    jobRunId: r.jobRunId,
  };
}

/** Link to a record on the investigation page. */
export function recordHref(spaceAlias: string, taskId: string, recordId: string | null): string {
  const base = `/spaces/${encodeURIComponent(spaceAlias)}/journals/investigations/${encodeURIComponent(taskId)}`;
  return recordId ? `${base}#rec-${encodeURIComponent(recordId)}` : base;
}

export function withLinks(
  result: ReadsCheckResult,
  spaceAlias: string,
  extra: { titles?: ReadonlyMap<string, string | null>; statuses?: ReadonlyMap<string, string | null> } = {},
): ReadsCheckView {
  return {
    ...result,
    files: result.files.map((f) => ({
      ...f,
      ...(extra.statuses ? { releaseStatus: extra.statuses.get(f.assetId) ?? null } : {}),
      examples: Object.fromEntries(
        Object.entries(f.examples).map(([k, list]) => [
          k,
          (list ?? []).map((e) => ({ ...e, href: recordHref(spaceAlias, e.taskId, e.recordId), ...(extra.titles ? { title: extra.titles.get(e.taskId) ?? null } : {}) })),
        ]),
      ) as Partial<Record<ReadOutcome, RecordLink[]>>,
    })),
  };
}

/** Task IDs of every example record in a reads result. */
function exampleTaskIds(result: unknown): string[] {
  const files = (result as Partial<ReadsCheckResult> | null)?.files ?? [];
  return files.flatMap((f) => Object.values(f.examples ?? {}).flatMap((list) => (list ?? []).map((e) => e.taskId)));
}

function checkView<R>(kind: VerifyKind, rows: readonly VerificationRow[], cannotRun: CheckView<R>["cannotRun"], map: (result: unknown) => R | null): CheckView<R> {
  const latest = rows[0] ?? null;
  const open = rows.find((r) => r.state === "queued" || r.state === "running") ?? null;
  const done = rows.find((r) => r.state === "succeeded" && r.result);
  const result = done ? map(done.result) : null;
  return {
    kind,
    latest: latest ? summary(latest) : null,
    open: open ? summary(open) : null,
    lastResult: done && result ? { run: summary(done), result } : null,
    cannotRun,
    history: rows.map(summary),
  };
}

const blocked = (reason: BlockedReason, detail?: string | null) => ({ reason, message: detail ? `${BLOCKED_MESSAGES[reason]} ${detail}` : BLOCKED_MESSAGES[reason] });

/** The Verification section of a release, by name (the route uses the name). Null when the space has no release of that name. */
export async function loadReleaseVerification(space: SpaceRow, releaseName: string): Promise<ReleaseVerificationView | null> {
  const release = await getReleaseByName(space.id, releaseName);
  if (!release) return null;
  return loadVerificationFor(space, release);
}

export async function loadVerificationFor(space: SpaceRow, release: ReleaseRow): Promise<ReleaseVerificationView> {
  const opened = await openSpaceHistoryRepo(space);
  const policy = opened.ok ? getPolicyForRepo(opened.repo.dir).policy : getAppPolicy().policy;
  const opts = policy.verify.reads;
  const [liveRows, readsRows, window, sync, previous] = await Promise.all([
    listVerifications(space.id, release.id, "live"),
    listVerifications(space.id, release.id, "reads"),
    loadReleaseWindow(space.id, release, opts.window),
    getSyncState(space.id),
    previousRelease(space.id, release),
  ]);
  const { total } = await investigationsInWindow(space.id, window.from, window.to, 1);
  const done = readsRows.find((r) => r.state === "succeeded" && r.result);
  const [titles, applied] = await Promise.all([investigationTitles(space.id, done ? exampleTaskIds(done.result) : []), applyReadBack(space.id, release.planId)]);
  const manifest = parseManifest(release.manifest);
  const statusKey = policy.releases.rollback.statusKey;
  const statuses = new Map((manifest?.assets ?? []).map((a) => [a.assetId, typeof a.metadata[statusKey] === "string" ? (a.metadata[statusKey] as string) : null]));

  const common = !manifest ? blocked("manifest-invalid") : !opened.ok ? blocked(opened.reason) : null;
  const conn = connectionView(space, sync);
  const liveBlocked =
    common ?? (policy.verify.live.syncFirst && (conn.status === "failed" || conn.status === "rejected") ? blocked("space-unreachable", conn.cause) : null);
  const readsBlocked = common ?? (total === 0 ? blocked("no-journals") : null);

  const live = checkView<LiveCheckResult>("live", liveRows, liveBlocked, (r) => r as LiveCheckResult);
  const reads = checkView<ReadsCheckView>("reads", readsRows, readsBlocked, (r) => withLinks(r as ReadsCheckResult, space.alias, { titles, statuses }));
  const lastSyncAt = sync?.lastSyncCompletedAt ?? null;
  const liveCheckedAt = live.lastResult?.run.finishedAt ?? null;
  return {
    release: { id: release.id, name: release.name, createdAt: release.createdAt.toISOString(), sourceCommit: release.sourceCommit, planId: release.planId },
    applied,
    lastSyncAt: iso(lastSyncAt),
    stale: {
      live: Boolean(lastSyncAt && liveCheckedAt && lastSyncAt.getTime() > new Date(liveCheckedAt).getTime()),
      reads: Boolean(reads.lastResult && total > reads.lastResult.result.investigationsInWindow),
    },
    window: { mode: window.mode, from: window.from.toISOString(), to: iso(window.to), nextRelease: window.nextRelease, investigations: total, cap: opts.maxInvestigations },
    syncFirst: policy.verify.live.syncFirst,
    auto: opts.auto,
    live,
    reads,
    changes: manifest ? releaseChanges(manifest, previous, statusKey) : null,
  };
}
