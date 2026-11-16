import { getPolicyForRepo, type Policy } from "@/server/policy";
import type { SpaceRow } from "@/server/spaces/queries";
import { diffAssetVersions, type AssetDiff } from "./diff";
import { mergeAssetHistory, type HistoryEntry } from "./history";
import { liveAssetVersions, type LiveDeps } from "./live";
import { toLastChange, type LastChange } from "./browse";
import {
  distinctChangeSources,
  getIndexedAsset,
  listAssetChanges,
  listSpaceChanges,
  reasonsForCommits,
  countAssetsByType,
  type AssetReason,
  type IndexedAsset,
  type TimelineFilters,
  type TimelineRow,
} from "./queries";
import { canAddReason, parseReasonNotes } from "./reasons";
import { listAssetCommits, openSpaceHistoryRepo, readCommittedAsset, readNotes, type SpaceRepo } from "./repo";

/**
 * Data for the history pages: the space-wide timeline, one asset's merged
 * history with notes, and the diff between two recorded versions.
 */

function policyFor(repo: SpaceRepo): Policy {
  return getPolicyForRepo(repo.ok ? repo.repo.dir : null, repo.ok ? repo.layout.policyDir : undefined).policy;
}

export interface NoteView {
  reason: string;
  link: string | null;
  addedBy: string | null;
  addedAt: string | null;
}

export interface AssetHistoryEntry extends HistoryEntry {
  notes: NoteView[];
  /** Reasons indexed in Postgres that the git note doesn't show yet (job ran, notes ref not fetched) */
  pendingReasons: AssetReason[];
  canAddReason: boolean;
}

export interface AssetHistoryView {
  asset: IndexedAsset;
  repo: SpaceRepo;
  entries: AssetHistoryEntry[];
  liveError: string | null;
  policy: Policy;
}

export async function loadAssetHistory(space: SpaceRow, assetId: string, opts: { live: LiveDeps | null }): Promise<AssetHistoryView | null> {
  const asset = await getIndexedAsset(space.id, assetId);
  if (!asset) return null;
  const repo = await openSpaceHistoryRepo(space);
  const policy = policyFor(repo);
  const [commits, changes, live] = await Promise.all([
    repo.ok && asset.gitPath ? listAssetCommits(repo.repo, asset.gitPath, asset.assetId) : Promise.resolve([]),
    listAssetChanges(space.id, asset.assetId),
    opts.live ? liveAssetVersions(opts.live, asset.assetId) : Promise.resolve(null),
  ]);
  const merged = mergeAssetHistory({ commits, changes, live: live?.ok ? live.value : null, labels: policy.attribution.labels });
  const hashes = merged.flatMap((e) => (e.commitHash ? [e.commitHash] : []));
  const [notes, reasons] = await Promise.all([
    repo.ok ? readNotes(repo.repo, hashes, repo.layout.notesRef) : Promise.resolve(new Map<string, string>()),
    reasonsForCommits(space.id, hashes),
  ]);
  const changeByCommit = new Map(changes.map((c) => [c.commit, c]));
  const entries = merged.map((e): AssetHistoryEntry => {
    const note = e.commitHash ? notes.get(e.commitHash) : undefined;
    const parsed = note ? parseReasonNotes(note) : [];
    const indexed = e.commitHash ? (reasons.get(e.commitHash) ?? []) : [];
    const change = e.commitHash ? changeByCommit.get(e.commitHash) : undefined;
    return {
      ...e,
      notes: parsed.map(({ reason, link, addedBy, addedAt }) => ({ reason, link, addedBy, addedAt })),
      pendingReasons: indexed.filter((r) => !note?.includes(`Reason-Id: ${r.id}`)),
      canAddReason: Boolean(change && canAddReason(change)),
    };
  });
  return { asset, repo, entries, liveError: live && !live.ok ? live.error : opts.live ? null : "Live reads are off", policy };
}

// ---------- diff ----------

export interface AssetDiffView {
  asset: IndexedAsset;
  from: { commit: string; version: number | null; updatedAt: string | null };
  to: { commit: string; version: number | null; updatedAt: string | null };
  diff: AssetDiff;
}

export type DiffResult = { ok: true; view: AssetDiffView } | { ok: false; status: 404 | 409; message: string };

/**
 * Diff between two commits of one asset. Both commits must be in the asset's
 * own history, so a URL can't be used to read other paths or commits.
 */
export async function loadAssetDiff(space: SpaceRow, assetId: string, fromCommit: string, toCommit: string): Promise<DiffResult> {
  const asset = await getIndexedAsset(space.id, assetId);
  if (!asset) return { ok: false, status: 404, message: "Asset not found" };
  const repo = await openSpaceHistoryRepo(space);
  if (!repo.ok) return { ok: false, status: 409, message: repo.message };
  if (!asset.gitPath) return { ok: false, status: 409, message: "This asset is not in git yet." };
  const commits = await listAssetCommits(repo.repo, asset.gitPath, asset.assetId);
  const changes = await listAssetChanges(space.id, asset.assetId);
  const policy = policyFor(repo);
  const merged = mergeAssetHistory({ commits, changes, live: null, labels: policy.attribution.labels });
  const byHash = new Map(merged.filter((e) => e.commitHash && e.commit).map((e) => [e.commitHash!, e]));
  const a = byHash.get(fromCommit);
  const b = byHash.get(toCommit);
  if (!a || !b) return { ok: false, status: 404, message: "Pick two recorded versions of this asset." };
  const [va, vb] = await Promise.all([
    readCommittedAsset(repo.repo, asset.gitPath, repo.layout, fromCommit),
    readCommittedAsset(repo.repo, asset.gitPath, repo.layout, toCommit),
  ]);
  const empty = { assetJson: null, files: [] };
  return {
    ok: true,
    view: {
      asset,
      from: { commit: fromCommit, version: a.version, updatedAt: a.updatedAt },
      to: { commit: toCommit, version: b.version, updatedAt: b.updatedAt },
      diff: diffAssetVersions(va ?? empty, vb ?? empty),
    },
  };
}

/** The recorded version before `commit` in the asset's history (for "compare with previous"). */
export function previousRecorded(entries: readonly HistoryEntry[], commit: string): string | null {
  const recorded = entries.filter((e) => e.inGit && e.commit);
  const i = recorded.findIndex((e) => e.commitHash === commit);
  return i >= 0 ? (recorded[i + 1]?.commitHash ?? null) : null;
}

// ---------- space timeline ----------

export interface TimelineEntry extends TimelineRow {
  last: LastChange | null;
  reasons: AssetReason[];
}

export interface SpaceTimelineView {
  rows: TimelineEntry[];
  hasMore: boolean;
  sources: { value: string; label: string }[];
  assetTypes: { value: string; label: string }[];
  policy: Policy;
}

export async function loadSpaceTimeline(space: SpaceRow, filters: TimelineFilters): Promise<SpaceTimelineView> {
  const policy = policyFor(await openSpaceHistoryRepo(space));
  const [{ rows, hasMore }, sources, counts] = await Promise.all([listSpaceChanges(space.id, filters), distinctChangeSources(space.id), countAssetsByType(space.id)]);
  const reasons = await reasonsForCommits(
    space.id,
    rows.map((r) => r.commit),
  );
  const labels = policy.attribution.labels;
  const knownSources = Object.keys(labels) as (keyof typeof labels)[];
  const sourceValues = [...new Set([...knownSources, ...sources])];
  const typeValues = [...new Set([...Object.keys(policy.assetTypes.assetTypes), ...Object.keys(counts)])];
  return {
    rows: rows.map((r) => ({ ...r, last: toLastChange(r, labels), reasons: (reasons.get(r.commit) ?? []).filter((x) => x.assetId === r.assetId) })),
    hasMore,
    sources: sourceValues.map((v) => ({ value: v, label: labels[v as keyof typeof labels] ?? v })),
    assetTypes: typeValues.map((v) => ({ value: v, label: policy.assetTypes.assetTypes[v]?.label ?? v })),
    policy,
  };
}
