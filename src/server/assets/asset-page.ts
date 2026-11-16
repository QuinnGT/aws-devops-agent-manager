import type { SpaceRow } from "@/server/spaces/queries";
import type { AssetListRow } from "./browse";
import { loadAssetDetail, type AssetDetailView } from "./browse";
import type { AssetDiff } from "./diff";
import { assetActionRules, type AssetActionRules } from "./edit-rules";
import { assetDirectory } from "./queries";
import { loadStoreMemories } from "./sections";
import { loadAssetDiff, loadAssetHistory, type AssetHistoryEntry } from "./timeline";
import { orderPair, previousEntry, resolveVersionRef, versionCadence, versionPoints, type AssetTab, type Cadence, type VersionPoint } from "./versions";

/**
 * Data for the asset page (design-system pages/asset-detail.md): the header,
 * the tab in the URL, the content at the latest or a chosen version, the
 * version list and strip, a compare between two versions and the actions'
 * rules. Reads Postgres and the history repository; no live AWS calls.
 */

export interface CompareSide {
  entry: AssetHistoryEntry;
  version: number;
}

export type CompareView =
  | { ok: true; from: CompareSide; to: CompareSide; diff: AssetDiff }
  | { ok: false; message: string };

export interface AssetPageView {
  /** Content and metadata at the shown version (the latest, or ?version=) */
  detail: AssetDetailView;
  /** The asset's metadata now, for the header and the actions, whichever version the content shows */
  currentMetadata: Record<string, unknown>;
  /** Newest first, with reasons */
  entries: AssetHistoryEntry[];
  /** One per version number, oldest first */
  points: VersionPoint[];
  cadence: Cadence | null;
  /** The newest recorded change (header "Add reason" and meta line) */
  latest: AssetHistoryEntry | null;
  actions: AssetActionRules;
  /** Content shown from an older version (?version=), else null */
  viewing: AssetHistoryEntry | null;
  /** The last version before the deletion, for "Restore as a plan" */
  restoreVersion: number | null;
  compare: CompareView | null;
  /** Metadata tab: what changed in the newest version against the one before */
  latestChange: { version: number | null; diff: AssetDiff } | null;
  /** Memory store: its memories */
  memories: AssetListRow[] | null;
}

export interface AssetPageRequest {
  tab: AssetTab;
  /** ?version= on the Content tab: a version number or commit */
  version?: string;
  from?: string;
  to?: string;
}

function isRecorded(e: AssetHistoryEntry): boolean {
  return e.inGit && e.commitHash !== null && e.version !== null && e.state !== "deleted";
}

export async function loadAssetPage(space: SpaceRow, assetId: string, req: AssetPageRequest): Promise<AssetPageView | null> {
  const history = await loadAssetHistory(space, assetId, { live: null });
  if (!history) return null;
  const entries = history.entries;
  const recorded = entries.filter(isRecorded);
  const latest = recorded[0] ?? null;
  const deleted = Boolean(history.asset.deletedAt);

  const viewing = req.tab === "content" && req.version ? resolveVersionRef(entries, req.version) : null;
  // A deleted asset's directory is gone at HEAD: show the last recorded version.
  const at = viewing?.commitHash ?? (deleted ? (latest?.commitHash ?? null) : null);
  const detail = await loadAssetDetail(space, assetId, { live: null, at });
  if (!detail) return null;

  const directory = await assetDirectory(space.id);
  const indexed = history.asset.metadata;
  const currentMetadata = at && !deleted && indexed && typeof indexed === "object" && !Array.isArray(indexed) ? (indexed as Record<string, unknown>) : detail.metadata;
  const actions = assetActionRules(detail.policy, { assetType: detail.asset.assetType, metadata: currentMetadata }, (type, id) => {
    const d = directory.get(id);
    return d && d.assetType === type ? d.name : undefined;
  });
  const points = versionPoints(entries);

  let compare: CompareView | null = null;
  if (req.tab === "versions" && (req.from || req.to)) {
    const a = resolveVersionRef(entries, req.from);
    const b = resolveVersionRef(entries, req.to);
    if (!a || !b) compare = { ok: false, message: "Pick two recorded versions of this asset." };
    else {
      const [from, to] = orderPair(a, b);
      const r = await loadAssetDiff(space, assetId, from.commitHash, to.commitHash);
      compare = r.ok ? { ok: true, from: { entry: from, version: from.version }, to: { entry: to, version: to.version }, diff: r.view.diff } : { ok: false, message: r.message };
    }
  }

  let latestChange: AssetPageView["latestChange"] = null;
  if (req.tab === "metadata" && latest) {
    const prev = previousEntry(entries, latest);
    if (prev) {
      const r = await loadAssetDiff(space, assetId, prev.commitHash, latest.commitHash!);
      if (r.ok) latestChange = { version: latest.version, diff: r.view.diff };
    }
  }

  return {
    detail,
    currentMetadata,
    entries,
    points,
    cadence: versionCadence(points),
    latest,
    actions,
    viewing: viewing && viewing.commitHash !== latest?.commitHash ? viewing : null,
    restoreVersion: deleted ? (latest?.version ?? null) : null,
    compare,
    latestChange,
    memories: detail.asset.assetType === "memory_store" && req.tab === "content" ? await loadStoreMemories(space, assetId, detail.policy) : null,
  };
}
