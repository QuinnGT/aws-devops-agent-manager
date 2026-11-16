import { CHANGE_SOURCES, type ChangeSource } from "@/lib/assets/types";
import { assetLabel } from "@/server/history/display-name";
import type { Policy } from "@/server/policy";
import type { IndexRowLike, ManifestDiff, ManifestDiffEntry } from "./diff";
import type { ManifestAsset } from "./manifest";
import type { RollbackRow, SkipReason } from "./rollback-plan";

/**
 * View models for the release pages (pages/releases.md). Pure, so the
 * grouping and wording rules are unit-tested; the loaders feed them rows
 * from Postgres and git.
 */

type ViewPolicy = Pick<Policy, "assetTypes" | "releases" | "agentTypes">;

/** What a release is, shown wherever the word appears unexplained (releases list, Create release dialog, Home card). */
export const RELEASE_SENTENCE = "A saved snapshot of every asset that you can restore later.";

/** Why "Create release" is disabled while the app can't reach the space; the cause follows it. */
export const RELEASE_NEEDS_CONNECTION = "A release starts with a sync, and the app can't reach the space.";

/**
 * The reason "Create release" is disabled up front, or null: a release of
 * HEAD syncs first (policy releases.syncBeforeCreate), so it can't succeed
 * while the connection is failed or rejected. A release of a given commit
 * (tag after apply) doesn't sync. Pure.
 */
export function connectionBlocksRelease(conn: { status: string; cause: string | null }, o: { syncFirst: boolean; commit: string | null }): string | null {
  if (!o.syncFirst || o.commit || (conn.status !== "failed" && conn.status !== "rejected")) return null;
  return conn.cause ? `${RELEASE_NEEDS_CONNECTION} ${conn.cause}` : RELEASE_NEEDS_CONNECTION;
}

// ---------- changes since a release ----------

/**
 * The newest service time a release knows about: the latest serviceUpdatedAt
 * among its manifest assets. Changes recorded with a later service time are
 * "changes since" the release. Null for an empty or unreadable manifest.
 */
export function releaseAnchor(assets: readonly Pick<ManifestAsset, "serviceUpdatedAt">[]): Date | null {
  let max: number | null = null;
  for (const a of assets) {
    const t = Date.parse(a.serviceUpdatedAt);
    if (Number.isFinite(t) && (max === null || t > max)) max = t;
  }
  return max === null ? null : new Date(max);
}

/** How many of `times` (ascending, ms) are after `anchor`. */
export function countAfter(sortedTimes: readonly number[], anchor: Date | null): number {
  if (!anchor) return 0;
  const a = anchor.getTime();
  let lo = 0;
  let hi = sortedTimes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedTimes[mid]! <= a) lo = mid + 1;
    else hi = mid;
  }
  return sortedTimes.length - lo;
}

// ---------- release detail table ----------

/** Change words in priority order (releases.md "Change words"). */
export const RELEASE_CHANGES = ["removed", "added", "content", "status", "metadata", "unchanged"] as const;
export type ReleaseChange = (typeof RELEASE_CHANGES)[number];

/** Display order of the table: changed rows first, then deleted, added and unchanged. */
const TABLE_ORDER: Record<ReleaseChange, number> = { content: 0, status: 1, metadata: 2, removed: 3, added: 4, unchanged: 5 };

export interface LastChange {
  source: ChangeSource;
  principal: string | null;
  /** Label stored with the change (asset_changes.change_source_label) */
  label: string | null;
  provisional: boolean;
  at: string;
}

/** The asset_changes columns the views read. */
export interface ChangeRowLike {
  assetId: string;
  serviceUpdatedAt: Date | string;
  changeSource: string;
  changeSourceLabel: string | null;
  principal: string | null;
  attributionProvisional: boolean;
}

export type MetadataKeyChange = { key: string; change: "added" | "removed" | "changed" };

export interface ReleaseTableRow {
  /** `${assetType}:${key}`, unique within the table */
  rowKey: string;
  assetType: string;
  typeLabel: string;
  name: string;
  /** Name of the parent asset (a memory's store), when there is one */
  parentName: string | null;
  /** The asset in the release, null for an asset added since */
  releaseAssetId: string | null;
  /** The live asset, null when it was deleted since */
  liveAssetId: string | null;
  change: ReleaseChange;
  inRelease: { version: number; status: string | null; contentHash: string } | null;
  /** Null when the asset was deleted since */
  live: { version: number | null; status: string | null } | null;
  /** Metadata keys that differ, other than the status key */
  metadataChanges: MetadataKeyChange[];
  /** The newest recorded change since the release; null for "Same" */
  lastChange: LastChange | null;
  /** Live has changes the history repository doesn't have yet */
  pendingSync: boolean;
}

export interface ReleaseChangeCounts {
  unchanged: number;
  /** content + status + metadata */
  changed: number;
  content: number;
  status: number;
  metadata: number;
  removed: number;
  added: number;
}

function asMetadata(m: unknown): Record<string, unknown> {
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

function toTime(d: Date | string): number {
  return d instanceof Date ? d.getTime() : Date.parse(d);
}

function lastChangeOf(row: ChangeRowLike | undefined, after: number | null): LastChange | null {
  if (!row) return null;
  const at = toTime(row.serviceUpdatedAt);
  if (!Number.isFinite(at) || (after !== null && at <= after)) return null;
  const source = (CHANGE_SOURCES as readonly string[]).includes(row.changeSource) ? (row.changeSource as ChangeSource) : "unknown";
  return { source, principal: row.principal, label: row.changeSourceLabel, provisional: row.attributionProvisional, at: new Date(at).toISOString() };
}

/** Word for a drift entry: status-only metadata changes are "status". */
export function releaseChangeOf(entry: Pick<ManifestDiffEntry, "kind" | "metadataKeys">, statusKey: string): ReleaseChange {
  if (entry.kind === "metadata") return entry.metadataKeys.length > 0 && entry.metadataKeys.every((k) => k === statusKey) ? "status" : "metadata";
  return entry.kind;
}

export function metadataKeyChanges(keys: readonly string[], before: Record<string, unknown>, after: Record<string, unknown>, statusKey: string): MetadataKeyChange[] {
  return keys
    .filter((k) => k !== statusKey)
    .map((key) => ({ key, change: !(key in before) ? "added" : !(key in after) ? "removed" : "changed" }) satisfies MetadataKeyChange)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function buildReleaseTable(input: {
  assets: readonly ManifestAsset[];
  drift: Pick<ManifestDiff, "entries">;
  /** Index rows, deleted ones included (for names, parents and current metadata) */
  index: readonly (IndexRowLike & { name: string })[];
  /** Newest change per asset ID */
  latest: ReadonlyMap<string, ChangeRowLike>;
  policy: ViewPolicy;
}): { rows: ReleaseTableRow[]; counts: ReleaseChangeCounts } {
  const { assets, drift, index, latest, policy } = input;
  const statusKey = policy.releases.rollback.statusKey;
  const types = policy.assetTypes.assetTypes;
  const manifestById = new Map(assets.map((a) => [a.assetId, a]));
  const indexById = new Map(index.map((r) => [r.assetId, r]));
  const anchor = releaseAnchor(assets)?.getTime() ?? null;

  const parentName = (assetId: string | null, manifest: ManifestAsset | undefined): string | null => {
    const row = assetId ? indexById.get(assetId) : undefined;
    const parentId = row?.parentAssetId ?? null;
    if (parentId) return indexById.get(parentId)?.name ?? manifestById.get(parentId)?.name ?? null;
    if (manifest) {
      for (const rule of types[manifest.assetType]?.references ?? []) {
        if (rule.many || !rule.required) continue;
        const id = manifest.metadata[rule.key];
        if (typeof id === "string") return manifestById.get(id)?.name ?? indexById.get(id)?.name ?? null;
      }
    }
    return null;
  };

  const rows: ReleaseTableRow[] = drift.entries.map((e) => {
    const m = e.before ? manifestById.get(e.before.assetId) : undefined;
    const live = e.after ? indexById.get(e.after.assetId) : undefined;
    const change = releaseChangeOf(e, statusKey);
    const since = m ? toTime(m.serviceUpdatedAt) : anchor;
    const changeAssetId = e.after?.assetId ?? e.before?.assetId ?? null;
    return {
      rowKey: `${e.assetType}:${e.key}`,
      assetType: e.assetType,
      typeLabel: types[e.assetType]?.label ?? e.assetType,
      name: assetLabel(policy, { assetType: e.assetType, name: e.name, assetId: e.after?.assetId ?? e.before?.assetId ?? null, metadata: m?.metadata ?? live?.metadata }),
      parentName: parentName(e.after?.assetId ?? e.before?.assetId ?? null, m),
      releaseAssetId: e.before?.assetId ?? null,
      liveAssetId: e.after?.assetId ?? null,
      change,
      inRelease: e.before ? { version: e.before.serviceVersion ?? m?.serviceVersion ?? 0, status: e.before.status, contentHash: e.before.contentHash ?? m?.contentHash ?? "" } : null,
      live: e.after ? { version: e.after.serviceVersion, status: e.after.status } : null,
      metadataChanges: change === "metadata" && m && live ? metadataKeyChanges(e.metadataKeys, m.metadata, asMetadata(live.metadata), statusKey) : [],
      lastChange: change === "unchanged" || !changeAssetId ? null : lastChangeOf(latest.get(changeAssetId), Number.isFinite(since ?? NaN) ? since : null),
      pendingSync: e.pendingSync,
    };
  });
  const order = Object.keys(types);
  const rank = (t: string) => (order.indexOf(t) < 0 ? order.length : order.indexOf(t));
  rows.sort((a, b) => TABLE_ORDER[a.change] - TABLE_ORDER[b.change] || rank(a.assetType) - rank(b.assetType) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const counts: ReleaseChangeCounts = { unchanged: 0, changed: 0, content: 0, status: 0, metadata: 0, removed: 0, added: 0 };
  for (const r of rows) {
    counts[r.change]++;
    if (r.change === "content" || r.change === "status" || r.change === "metadata") counts.changed++;
  }
  return { rows, counts };
}

// ---------- rollback preview groups ----------

/** Groups of the rollback preview table, in display order (releases.md "What the plan will do"). */
export const ROLLBACK_GROUPS = ["restore-content", "restore-status", "restore-metadata", "recreate", "deactivate", "remove-keys", "delete", "left-out"] as const;
export type RollbackGroupKey = (typeof ROLLBACK_GROUPS)[number];

export type RollbackAfter =
  | { kind: "content"; releaseVersion: number; writtenAs: number | null }
  | { kind: "status"; version: number | null; status: string | null }
  | { kind: "metadata"; version: number | null }
  | { kind: "recreate"; releaseVersion: number | null }
  | { kind: "keys-removed"; keys: string[] }
  | { kind: "deleted" }
  | { kind: "unchanged"; version: number | null };

export interface RollbackViewRow {
  rowKey: string;
  assetType: string;
  typeLabel: string;
  name: string;
  parentName: string | null;
  liveAssetId: string | null;
  /** "matching": the live space already matches the release for this asset */
  group: RollbackGroupKey | "matching";
  /** Null when the asset is deleted live */
  live: { version: number | null; status: string | null } | null;
  after: RollbackAfter;
  /** The plan item's note from the planner, if any */
  note: string | null;
  /** The newest change since the release, for "<source> changed it <Time>." */
  lastChange: LastChange | null;
  removeMetadataKeys: string[];
  /** Release assets whose metadata references this one (custom agents), for recreated assets */
  referencedBy: string[];
  skipReason: SkipReason | null;
  /** The row comes from a release asset (false: an asset added since) */
  fromRelease: boolean;
}

export interface RollbackGroups {
  groups: { key: RollbackGroupKey; rows: RollbackViewRow[] }[];
  matching: RollbackViewRow[];
  /** Rows in groups other than "left-out": what the plan changes */
  changes: number;
  /** Release assets plus assets added since */
  total: number;
  /** Restorable assets left out because they are managed or not editable, and differ from the release */
  cantRestore: RollbackViewRow[];
}

function referencesTo(assetId: string, assets: readonly ManifestAsset[]): string[] {
  const out: string[] = [];
  for (const a of assets) {
    if (a.assetId === assetId) continue;
    const hit = Object.values(a.metadata).some((v) => v === assetId || (Array.isArray(v) && v.includes(assetId)));
    if (hit) out.push(a.name);
  }
  return out.sort();
}

export function groupRollbackRows(input: {
  rows: readonly RollbackRow[];
  table: readonly ReleaseTableRow[];
  assets: readonly ManifestAsset[];
  policy: ViewPolicy;
}): RollbackGroups {
  const { rows, table, assets, policy } = input;
  const r = policy.releases.rollback;
  const types = policy.assetTypes.assetTypes;
  const byRelease = new Map(table.filter((t) => t.releaseAssetId).map((t) => [t.releaseAssetId!, t]));
  const byLive = new Map(table.filter((t) => t.liveAssetId).map((t) => [t.liveAssetId!, t]));
  const manifestById = new Map(assets.map((a) => [a.assetId, a]));

  const out: RollbackViewRow[] = rows.map((row) => {
    const t = (row.targetAssetId ? byRelease.get(row.targetAssetId) : undefined) ?? (row.assetId ? byLive.get(row.assetId) : undefined);
    const live = t ? t.live : row.assetId ? { version: row.currentVersion, status: null } : null;
    const base = {
      rowKey: `${row.assetType}:${row.key}:${row.action}`,
      assetType: row.assetType,
      typeLabel: types[row.assetType]?.label ?? row.assetType,
      name: t?.name ?? assetLabel(policy, { assetType: row.assetType, name: row.name, assetId: row.assetId ?? row.targetAssetId }),
      parentName: t?.parentName ?? null,
      liveAssetId: row.assetId,
      live,
      note: row.note,
      lastChange: t?.lastChange ?? null,
      removeMetadataKeys: row.removeMetadataKeys,
      referencedBy: [] as string[],
      skipReason: row.skipReason ?? null,
      fromRelease: row.targetAssetId !== null,
    };
    const releaseVersion = row.targetVersion ?? t?.inRelease?.version ?? null;
    switch (row.action) {
      case "create":
        return { ...base, group: "recreate", after: { kind: "recreate", releaseVersion }, referencedBy: row.targetAssetId ? referencesTo(row.targetAssetId, assets) : [] };
      case "deactivate":
        return { ...base, group: "deactivate", after: { kind: "status", version: row.currentVersion, status: r.inactiveValue } };
      case "delete":
        return { ...base, group: "delete", after: { kind: "deleted" } };
      case "keep":
        return { ...base, group: "left-out", after: { kind: "unchanged", version: row.currentVersion } };
      case "skip": {
        // A managed or non-editable asset that already matches the release isn't really left out.
        const group = t?.change === "unchanged" ? "matching" : "left-out";
        return { ...base, group, after: { kind: "unchanged", version: t?.live?.version ?? row.currentVersion } };
      }
      case "update": {
        const change = t?.change ?? (row.expected === "unchanged" ? "unchanged" : "content");
        if (change === "unchanged") return { ...base, group: "matching", after: { kind: "unchanged", version: row.currentVersion } };
        if (change === "status") {
          const status = row.targetAssetId ? manifestById.get(row.targetAssetId)?.metadata[r.statusKey] : undefined;
          return { ...base, group: "restore-status", after: { kind: "status", version: row.currentVersion, status: typeof status === "string" ? status : (t?.inRelease?.status ?? null) } };
        }
        if (change === "metadata") {
          const onlyAdded = t !== undefined && t.metadataChanges.length > 0 && t.metadataChanges.every((c) => c.change === "added" && row.removeMetadataKeys.includes(c.key));
          if (onlyAdded) return { ...base, group: "remove-keys", after: { kind: "keys-removed", keys: row.removeMetadataKeys } };
          return { ...base, group: "restore-metadata", after: { kind: "metadata", version: row.currentVersion } };
        }
        return { ...base, group: "restore-content", after: { kind: "content", releaseVersion: releaseVersion ?? 0, writtenAs: row.currentVersion === null ? null : row.currentVersion + 1 } };
      }
    }
  });

  const groups = ROLLBACK_GROUPS.map((key) => ({ key, rows: out.filter((o) => o.group === key) })).filter((g) => g.rows.length > 0);
  const matching = out.filter((o) => o.group === "matching");
  const changes = out.filter((o) => o.group !== "matching" && o.group !== "left-out").length;
  const cantRestore = out.filter((o) => o.group === "left-out" && o.fromRelease && o.skipReason !== null);
  return { groups, matching, changes, total: table.length, cantRestore };
}
