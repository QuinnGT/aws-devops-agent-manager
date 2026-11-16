import { metadataHash } from "@/server/history/content-hash";
import type { Policy } from "@/server/policy";
import { changedMetadataKeys } from "@/server/sync/content";
import { assetIdentity, computeIdentity } from "@/server/validation/identity";
import type { ManifestAsset } from "./manifest";

/**
 * Differences between two manifests, or between a manifest and the current
 * asset index (drift). Pure; unit-tested.
 *
 * Assets are matched by asset ID first, then by type and identity, so an
 * asset deleted and created again under the same name is one entry with
 * `idChanged`. Content is compared by content hash; when one side has no hash
 * (an index row whose version git doesn't hold yet), the service version
 * decides, because only metadata can change without a new version.
 */

export type DriftKind = "added" | "removed" | "content" | "metadata" | "unchanged";

export const DRIFT_KINDS: readonly DriftKind[] = ["added", "removed", "content", "metadata", "unchanged"];

export interface ComparableAsset {
  assetId: string;
  assetType: string;
  key: string;
  name: string;
  serviceVersion: number | null;
  /** null when not known */
  contentHash: string | null;
  metadata: Record<string, unknown>;
  /** The live space has changes for this asset that the history repository doesn't have yet */
  pendingSync?: boolean;
}

export interface DiffSide {
  assetId: string;
  serviceVersion: number | null;
  contentHash: string | null;
  metadataHash: string;
  status: string | null;
}

export interface ManifestDiffEntry {
  kind: DriftKind;
  assetType: string;
  key: string;
  name: string;
  before: DiffSide | null;
  after: DiffSide | null;
  /** Matched by type and identity, with a different asset ID on each side */
  idChanged: boolean;
  /** Top-level metadata keys whose values differ */
  metadataKeys: string[];
  /** Content was compared by service version because a content hash was missing */
  contentByVersion: boolean;
  pendingSync: boolean;
}

export interface ManifestDiff {
  entries: ManifestDiffEntry[];
  counts: Record<DriftKind, number>;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function side(a: ComparableAsset, statusKey: string): DiffSide {
  const s = a.metadata[statusKey];
  return {
    assetId: a.assetId,
    serviceVersion: a.serviceVersion,
    contentHash: a.contentHash,
    metadataHash: metadataHash(a.metadata),
    status: typeof s === "string" ? s : null,
  };
}

function sameContent(b: ComparableAsset, a: ComparableAsset): { same: boolean; byVersion: boolean } {
  if (b.contentHash && a.contentHash) return { same: b.contentHash === a.contentHash, byVersion: false };
  return { same: b.assetId === a.assetId && b.serviceVersion !== null && b.serviceVersion === a.serviceVersion, byVersion: true };
}

/** Match `before` to `after` by asset ID, then by type and identity. */
export function matchAssets<B extends ComparableAsset, A extends ComparableAsset>(
  before: readonly B[],
  after: readonly A[],
): { pairs: [B, A][]; removed: B[]; added: A[] } {
  const afterById = new Map(after.map((a) => [a.assetId, a]));
  const used = new Set<A>();
  const pairs: [B, A][] = [];
  const rest: B[] = [];
  for (const b of before) {
    const a = afterById.get(b.assetId);
    if (a && a.assetType === b.assetType && !used.has(a)) {
      pairs.push([b, a]);
      used.add(a);
    } else rest.push(b);
  }
  const afterByKey = new Map<string, A>();
  for (const a of after) if (!used.has(a)) afterByKey.set(`${a.assetType}\0${a.key}`, a);
  const removed: B[] = [];
  for (const b of rest) {
    const a = afterByKey.get(`${b.assetType}\0${b.key}`);
    if (a && !used.has(a)) {
      pairs.push([b, a]);
      used.add(a);
    } else removed.push(b);
  }
  return { pairs, removed, added: after.filter((a) => !used.has(a)) };
}

export function diffManifests(before: readonly ComparableAsset[], after: readonly ComparableAsset[], opts: { statusKey?: string } = {}): ManifestDiff {
  const statusKey = opts.statusKey ?? "status";
  const { pairs, removed, added } = matchAssets(before, after);
  const entries: ManifestDiffEntry[] = [];
  for (const [b, a] of pairs) {
    const content = sameContent(b, a);
    const metadataKeys = changedMetadataKeys(b.metadata, a.metadata);
    const kind: DriftKind = !content.same ? "content" : metadataKeys.length ? "metadata" : "unchanged";
    entries.push({
      kind,
      assetType: a.assetType,
      key: a.key,
      name: a.name,
      before: side(b, statusKey),
      after: side(a, statusKey),
      idChanged: a.assetId !== b.assetId,
      metadataKeys,
      contentByVersion: content.byVersion,
      pendingSync: Boolean(a.pendingSync || b.pendingSync),
    });
  }
  for (const b of removed) {
    entries.push({ kind: "removed", assetType: b.assetType, key: b.key, name: b.name, before: side(b, statusKey), after: null, idChanged: false, metadataKeys: [], contentByVersion: false, pendingSync: Boolean(b.pendingSync) });
  }
  for (const a of added) {
    entries.push({ kind: "added", assetType: a.assetType, key: a.key, name: a.name, before: null, after: side(a, statusKey), idChanged: false, metadataKeys: [], contentByVersion: false, pendingSync: Boolean(a.pendingSync) });
  }
  entries.sort((x, y) => cmp(x.assetType, y.assetType) || cmp(x.key, y.key) || cmp(x.kind, y.kind));
  const counts = Object.fromEntries(DRIFT_KINDS.map((k) => [k, 0])) as Record<DriftKind, number>;
  for (const e of entries) counts[e.kind]++;
  return { entries, counts };
}

export function comparableFromManifest(assets: readonly ManifestAsset[]): ComparableAsset[] {
  return assets.map((a) => ({
    assetId: a.assetId,
    assetType: a.assetType,
    key: a.key,
    name: a.name,
    serviceVersion: a.serviceVersion,
    contentHash: a.contentHash,
    metadata: a.metadata,
  }));
}

/** The asset_index columns the drift view reads. */
export interface IndexRowLike {
  assetId: string;
  assetType: string;
  name: string;
  parentAssetId: string | null;
  metadata: unknown;
  liveVersion: number | null;
  liveUpdatedAt: Date | string | null;
  lastSyncedVersion: number | null;
  lastSyncedUpdatedAt: Date | string | null;
  deletedAt: Date | string | null;
  gitPath: string | null;
}

function time(d: Date | string | null): number | null {
  if (d === null) return null;
  const t = d instanceof Date ? d.getTime() : Date.parse(d);
  return Number.isFinite(t) ? t : null;
}

function asMetadata(m: unknown): Record<string, unknown> {
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

/**
 * The live assets in the index as comparable assets. `headHashes` holds the
 * content hash of the asset.json at HEAD for some assets; it is used only
 * when its version is the index's live version.
 */
export function comparableFromIndex(
  rows: readonly IndexRowLike[],
  policy: Pick<Policy, "assetTypes">,
  headHashes: ReadonlyMap<string, { serviceVersion: number; contentHash: string }> = new Map(),
): ComparableAsset[] {
  const byId = new Map(rows.map((r) => [r.assetId, r]));
  const lookup = (assetType: string, id: string) => {
    const r = byId.get(id);
    return r && r.assetType === assetType ? (computeIdentity(policy, { assetType: r.assetType, metadata: asMetadata(r.metadata) }) ?? undefined) : undefined;
  };
  return rows
    .filter((r) => !r.deletedAt)
    .map((r) => {
      const metadata = asMetadata(r.metadata);
      const version = r.liveVersion ?? r.lastSyncedVersion;
      const head = headHashes.get(r.assetId);
      return {
        assetId: r.assetId,
        assetType: r.assetType,
        key: assetIdentity(policy, { assetType: r.assetType, assetId: r.assetId, metadata }, lookup),
        name: r.name,
        serviceVersion: version,
        contentHash: head && version !== null && head.serviceVersion === version ? head.contentHash : null,
        metadata,
        pendingSync: r.liveVersion !== r.lastSyncedVersion || time(r.liveUpdatedAt) !== time(r.lastSyncedUpdatedAt),
      };
    });
}

/**
 * Current assets whose content can't be compared by version alone: matched to
 * a manifest asset with a different ID or version. Read their HEAD asset.json
 * for a content hash.
 */
export function assetsNeedingContentHash(manifest: readonly ComparableAsset[], current: readonly ComparableAsset[]): string[] {
  const { pairs } = matchAssets(manifest, current);
  return pairs.filter(([m, c]) => m.assetId !== c.assetId || m.serviceVersion !== c.serviceVersion).map(([, c]) => c.assetId);
}
