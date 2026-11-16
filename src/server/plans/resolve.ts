import type { DesiredAsset, LiveAssetRef } from "@/server/packages/types";
import type { Policy } from "@/server/policy";
import { computeIdentity, type IdentityLookup } from "@/server/validation/identity";

/** Apply order and reference resolution. Pure. */

type IdentityPolicy = Pick<Policy, "assetTypes">;

export function identityKey(assetType: string, identity: string): string {
  return `${assetType}\0${identity}`;
}

/**
 * Asset IDs by type and identity. A reference placeholder in an identity
 * (memories: "{memoryStore}/{name}") is resolved through the store's own
 * identity, so the map is built in two passes.
 */
export class IdentityIndex {
  private readonly ids = new Map<string, string>();
  private readonly byId = new Map<string, { assetType: string; metadata: Record<string, unknown>; refs?: DesiredAsset["refs"] }>();

  constructor(
    private readonly policy: IdentityPolicy,
    live: readonly LiveAssetRef[] = [],
  ) {
    for (const a of live) this.byId.set(a.assetId, a);
    for (const a of live) {
      const identity = computeIdentity(policy, a, this.lookup);
      if (identity !== null && !this.ids.has(identityKey(a.assetType, identity))) this.ids.set(identityKey(a.assetType, identity), a.assetId);
    }
  }

  readonly lookup: IdentityLookup = (assetType, assetId) => {
    const a = this.byId.get(assetId);
    return a && a.assetType === assetType ? (computeIdentity(this.policy, a, this.lookup) ?? undefined) : undefined;
  };

  get(assetType: string, identity: string): string | undefined {
    return this.ids.get(identityKey(assetType, identity));
  }

  identityOf(a: Pick<DesiredAsset, "assetType" | "metadata" | "refs">): string | null {
    return computeIdentity(this.policy, a, this.lookup);
  }

  /** Record an asset (a create that just returned its ID). */
  add(assetId: string, a: Pick<DesiredAsset, "assetType" | "metadata" | "refs">): void {
    this.byId.set(assetId, { assetType: a.assetType, metadata: a.metadata, refs: a.refs });
    const identity = computeIdentity(this.policy, a, this.lookup);
    if (identity !== null) this.ids.set(identityKey(a.assetType, identity), assetId);
  }
}

export interface ResolvedMetadata {
  metadata: Record<string, unknown>;
  /** Names that match no asset, as "<ref>: <name>" */
  unresolved: string[];
}

/**
 * Write the asset IDs for `refs` (names) into the reference metadata keys
 * (asset-types.yaml `references`), for creates and updates alike. Names win
 * over IDs already in metadata, so a rollback or import item whose referenced
 * asset is recreated in the same plan points at the new ID. Names resolve
 * against live assets and assets created earlier in the run (IdentityIndex.add).
 */
export function resolveRefs(policy: IdentityPolicy, desired: Pick<DesiredAsset, "assetType" | "metadata" | "refs">, index: IdentityIndex): ResolvedMetadata {
  return resolveRefsWith(policy, desired, index);
}

/** Placeholder written into a reference field at check time for an asset the same plan creates (its ID exists only after apply). */
export function pendingRefId(name: string): string {
  return `(new ID of ${name})`;
}

/**
 * Like resolveRefs, for the plan check: a name that matches no live asset but
 * that an earlier create in the plan provides (`pending`) gets pendingRefId,
 * so the metadata diff and the write steps show the reference change.
 */
export function resolveRefsWith(
  policy: IdentityPolicy,
  desired: Pick<DesiredAsset, "assetType" | "metadata" | "refs">,
  index: IdentityIndex,
  pending?: (assetType: string, name: string) => boolean,
): ResolvedMetadata {
  const entry = policy.assetTypes.assetTypes[desired.assetType];
  const metadata = { ...desired.metadata };
  const unresolved: string[] = [];
  for (const rule of entry?.references ?? []) {
    const named = desired.refs?.[rule.ref];
    if (named === undefined) continue;
    const names = typeof named === "string" ? (named ? [named] : []) : named;
    const ids: string[] = [];
    for (const n of names) {
      const id = index.get(rule.assetType, n) ?? (pending?.(rule.assetType, n) ? pendingRefId(n) : undefined);
      if (id) ids.push(id);
      else unresolved.push(`${rule.ref}: ${n}`);
    }
    if (rule.many) metadata[rule.key] = ids;
    else if (ids[0]) metadata[rule.key] = ids[0];
  }
  return { metadata, unresolved };
}

/**
 * Apply order: upserts by type (policy plans.applyOrder, unlisted types last)
 * then by position; deletes after every upsert, in reverse type order.
 */
export function applyOrder<T extends { kind: "upsert" | "delete"; assetType: string; position: number }>(items: readonly T[], typeOrder: readonly string[]): T[] {
  const rank = (t: string) => {
    const i = typeOrder.indexOf(t);
    return i === -1 ? typeOrder.length : i;
  };
  const upserts = items.filter((i) => i.kind === "upsert").sort((a, b) => rank(a.assetType) - rank(b.assetType) || a.position - b.position);
  const deletes = items.filter((i) => i.kind === "delete").sort((a, b) => rank(b.assetType) - rank(a.assetType) || a.position - b.position);
  return [...upserts, ...deletes];
}
