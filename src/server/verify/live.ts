import type { Policy } from "@/server/policy";
import type { IndexRowLike, ManifestDiff, ManifestDiffEntry } from "@/server/releases/diff";
import type { ManifestAsset } from "@/server/releases/manifest";
import { buildReleaseTable, metadataKeyChanges, type ChangeRowLike } from "@/server/releases/views";
import { LIVE_OUTCOMES, type LiveChange, type LiveOutcome, type LiveRow } from "./types";

/**
 * Check 1, live state: every asset
 * of a release against the live index after a sync. Pure. The drift and the
 * release table come from the releases module (diffManifests,
 * buildReleaseTable); this adds the verification words.
 *
 *   matches  same asset ID, same content (content hash, or service version
 *            when git has no hash), same metadata including status. A newer
 *            service version with the same content still matches; newerVersion says so.
 *   changed  content, status or other metadata differ, or the asset was
 *            deleted and created again under the same name (recreated)
 *   missing  in the release, not live
 *   added    live, not in the release
 */

type LivePolicy = Pick<Policy, "assetTypes" | "releases" | "agentTypes">;

function asMetadata(m: unknown): Record<string, unknown> {
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

export function liveChangesOf(entry: Pick<ManifestDiffEntry, "kind" | "metadataKeys" | "idChanged">, statusKey: string): LiveChange[] {
  const out: LiveChange[] = [];
  if (entry.kind === "content") out.push("content");
  if (entry.metadataKeys.includes(statusKey)) out.push("status");
  if (entry.metadataKeys.some((k) => k !== statusKey)) out.push("metadata");
  if (entry.idChanged) out.push("recreated");
  return out;
}

export function liveOutcomeOf(entry: Pick<ManifestDiffEntry, "kind" | "metadataKeys" | "idChanged">, statusKey: string): LiveOutcome {
  if (entry.kind === "removed") return "missing";
  if (entry.kind === "added") return "added";
  return liveChangesOf(entry, statusKey).length ? "changed" : "matches";
}

const ORDER: Record<LiveOutcome, number> = Object.fromEntries(LIVE_OUTCOMES.map((o, i) => [o, i])) as Record<LiveOutcome, number>;

export function compareLive(input: {
  assets: readonly ManifestAsset[];
  drift: Pick<ManifestDiff, "entries">;
  /** Index rows, deleted ones included */
  index: readonly (IndexRowLike & { name: string })[];
  /** Newest recorded change per asset ID */
  latest: ReadonlyMap<string, ChangeRowLike>;
  policy: LivePolicy;
}): { rows: LiveRow[]; counts: Record<LiveOutcome, number>; matches: boolean } {
  const statusKey = input.policy.releases.rollback.statusKey;
  const table = buildReleaseTable(input);
  const tableByKey = new Map(table.rows.map((r) => [r.rowKey, r]));
  const manifestById = new Map(input.assets.map((a) => [a.assetId, a]));
  const indexById = new Map(input.index.map((r) => [r.assetId, r]));

  const rows: LiveRow[] = input.drift.entries.map((e) => {
    const rowKey = `${e.assetType}:${e.key}`;
    const t = tableByKey.get(rowKey);
    const outcome = liveOutcomeOf(e, statusKey);
    const changes = outcome === "changed" ? liveChangesOf(e, statusKey) : [];
    const m = e.before ? manifestById.get(e.before.assetId) : undefined;
    const live = e.after ? indexById.get(e.after.assetId) : undefined;
    const releaseVersion = e.before?.serviceVersion ?? m?.serviceVersion ?? null;
    const liveVersion = e.after?.serviceVersion ?? null;
    return {
      rowKey,
      assetType: e.assetType,
      typeLabel: t?.typeLabel ?? input.policy.assetTypes.assetTypes[e.assetType]?.label ?? e.assetType,
      name: t?.name ?? e.name,
      parentName: t?.parentName ?? null,
      outcome,
      changes,
      release: e.before && m ? { assetId: e.before.assetId, version: m.serviceVersion, status: e.before.status, contentHash: m.contentHash } : null,
      live: e.after ? { assetId: e.after.assetId, version: liveVersion, status: e.after.status } : null,
      newerVersion: Boolean(e.before && e.after && !e.idChanged && releaseVersion !== null && liveVersion !== null && liveVersion > releaseVersion),
      metadataChanges: m && live && changes.includes("metadata") ? metadataKeyChanges(e.metadataKeys, m.metadata, asMetadata(live.metadata), statusKey) : [],
      lastChange: outcome === "matches" ? null : (t?.lastChange ?? null),
      pendingSync: e.pendingSync,
    };
  });

  const typeOrder = Object.keys(input.policy.assetTypes.assetTypes);
  const rank = (t: string) => (typeOrder.indexOf(t) < 0 ? typeOrder.length : typeOrder.indexOf(t));
  rows.sort((a, b) => ORDER[a.outcome] - ORDER[b.outcome] || rank(a.assetType) - rank(b.assetType) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const counts = Object.fromEntries(LIVE_OUTCOMES.map((o) => [o, 0])) as Record<LiveOutcome, number>;
  for (const r of rows) counts[r.outcome]++;
  return { rows, counts, matches: counts.changed === 0 && counts.missing === 0 && counts.added === 0 };
}
