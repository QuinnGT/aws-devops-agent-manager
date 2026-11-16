import type { AssetSnapshot } from "@/lib/assets/types";
import type { Policy } from "@/server/policy";
import { assetIdentity, computeIdentity } from "@/server/validation/identity";
import { warning, type ValidationResult } from "@/server/validation/types";
import type { DesiredAsset, DesiredFile, LiveAssetRef } from "./types";

/**
 * Convert live asset snapshots (from sync or the history repository) into
 * desired assets: same metadata and files, plus name references for every
 * asset ID reference (memory_store_id -> refs.memoryStore, custom agent
 * skills -> refs.skills), so a package export or a rollback plan can refer
 * to assets by name. Files above the commit threshold (no content) are
 * skipped with a warning.
 */
export function snapshotsToDesiredAssets(
  snapshots: readonly AssetSnapshot[],
  policy: Pick<Policy, "assetTypes">,
): { assets: DesiredAsset[]; results: ValidationResult[] } {
  const results: ValidationResult[] = [];
  const byId = new Map(snapshots.map((s) => [s.assetId, s]));
  const lookup = (assetType: string, id: string) => {
    const s = byId.get(id);
    return s && s.assetType === assetType ? (computeIdentity(policy, s) ?? undefined) : undefined;
  };
  const assets: DesiredAsset[] = [];
  for (const s of snapshots) {
    const entry = policy.assetTypes.assetTypes[s.assetType];
    if (!entry) continue;
    const refs: Record<string, string | string[]> = {};
    for (const rule of entry.references) {
      const v = s.metadata[rule.key];
      const ids = typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
      const names = ids.map((id) => lookup(rule.assetType, id));
      if (names.some((n) => n === undefined)) {
        results.push(warning("live.reference-unknown", `${s.assetType} ${s.assetId} refers to an asset that is not in this snapshot set (${rule.key}).`));
      }
      const known = names.filter((n): n is string => n !== undefined);
      if (!known.length) continue;
      refs[rule.ref] = rule.many ? known : known[0]!;
    }
    const files: DesiredFile[] = [];
    for (const f of s.files) {
      if (f.content === undefined) {
        results.push(warning("live.file-not-committed", `${f.path} of ${s.assetType} ${s.assetId} has no stored content (${f.size} bytes) and is left out.`, { path: f.path }));
        continue;
      }
      files.push({ path: f.path, encoding: f.encoding, content: f.content });
    }
    const asset = { assetType: s.assetType, assetId: s.assetId, metadata: { ...s.metadata }, refs, files };
    assets.push({ ...asset, key: assetIdentity(policy, asset, lookup) });
  }
  return { assets, results };
}

/** The live context validateAssetSet needs, from snapshots. */
export function snapshotsToLiveRefs(snapshots: readonly Pick<AssetSnapshot, "assetId" | "assetType" | "metadata">[]): LiveAssetRef[] {
  return snapshots.map((s) => ({ assetId: s.assetId, assetType: s.assetType, metadata: s.metadata }));
}
