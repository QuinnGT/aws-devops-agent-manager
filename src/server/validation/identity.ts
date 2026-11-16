import type { Policy } from "@/server/policy";
import type { DesiredAsset } from "@/server/packages/types";

/**
 * Asset identity from asset-types.yaml `identity` templates. Placeholders are
 * metadata keys ("{name}") or reference names ("{memoryStore}"). A reference
 * placeholder takes DesiredAsset.refs[name] when set, otherwise the identity
 * of the asset whose ID is in the reference's metadata key (via `lookup`).
 */

type AssetLike = Pick<DesiredAsset, "assetType" | "metadata"> & { refs?: DesiredAsset["refs"] };

/** Identity of the referenced asset with this ID, if known. */
export type IdentityLookup = (assetType: string, assetId: string) => string | undefined;

export function computeIdentity(policy: Pick<Policy, "assetTypes">, asset: AssetLike, lookup?: IdentityLookup): string | null {
  const entry = policy.assetTypes.assetTypes[asset.assetType];
  const template = entry?.identity;
  if (!template) return null;
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const rule = entry.references.find((r) => r.ref === key);
    if (rule) {
      const named = asset.refs?.[key];
      if (typeof named === "string" && named) return named;
      const id = asset.metadata[rule.key];
      if (typeof id === "string" && id && lookup) {
        const found = lookup(rule.assetType, id);
        if (found) return found;
      }
      missing = true;
      return "";
    }
    const v = asset.metadata[key];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
    missing = true;
    return "";
  });
  return missing ? null : out;
}

/**
 * The identity key for a desired asset (DesiredAsset.key). A reference that
 * can't be resolved to a name uses the referenced asset ID instead; then the
 * key falls back to the asset ID, metadata.name and "(unnamed)", so every
 * asset has a key for messages.
 */
export function assetIdentity(policy: Pick<Policy, "assetTypes">, asset: AssetLike & { assetId?: string }, lookup?: IdentityLookup): string {
  const name = asset.metadata.name;
  return (
    computeIdentity(policy, asset, (type, id) => lookup?.(type, id) ?? id) ??
    asset.assetId ??
    (typeof name === "string" && name ? name : "(unnamed)")
  );
}
