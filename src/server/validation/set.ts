import { assetKeyOf, type DesiredAsset, type LiveAssetRef } from "@/server/packages/types";
import type { AssetTypePolicy } from "@/server/policy/sections/asset-types";
import { validateDraftAsset, type ValidationPolicy } from "./asset";
import { computeIdentity, type IdentityLookup } from "./identity";
import { error, warning, type ValidationResult } from "./types";

/**
 * Validate a whole desired asset set against the space it will be applied to:
 * each asset on its own (validateDraftAsset), then unique identities (one
 * AGENTS.md per agent type, unique skill and store names, unique memory names
 * per store), references (memory_store_id, custom agent skills and stores, by
 * ID or by name) and count limits (user skills, stores, memories per store).
 *
 * The resulting space is `live`, with each desired asset replacing the live
 * asset with the same assetId, or else the live asset of the same type with
 * the same identity (a plan would update it), and the rest added as new.
 * Live assets are context only: their own metadata is not re-validated.
 */

export interface AssetSetContext {
  policy: ValidationPolicy;
  /** Every asset currently in the space (types the policy knows; others are ignored) */
  live?: readonly LiveAssetRef[];
  /** Run validateDraftAsset on each desired asset (default true) */
  perAsset?: boolean;
}

interface Member {
  assetType: string;
  assetId?: string;
  metadata: Record<string, unknown>;
  refs?: DesiredAsset["refs"];
  desired?: DesiredAsset;
  identity: string | null;
}

export function validateAssetSet(desired: readonly DesiredAsset[], ctx: AssetSetContext): ValidationResult[] {
  const { policy } = ctx;
  const live = (ctx.live ?? []).filter((a) => policy.assetTypes.assetTypes[a.assetType]);
  const out: ValidationResult[] = [];
  const liveById = new Map(live.map((a) => [a.assetId, a]));

  // Identities of referenced assets by ID: desired assets win over live ones.
  const byId = new Map<string, { assetType: string; metadata: Record<string, unknown>; refs?: DesiredAsset["refs"] }>();
  for (const a of live) byId.set(a.assetId, a);
  for (const d of desired) if (d.assetId) byId.set(d.assetId, d);
  const lookup: IdentityLookup = (assetType, assetId) => {
    const a = byId.get(assetId);
    return a && a.assetType === assetType ? (computeIdentity(policy, a) ?? undefined) : undefined;
  };

  const members = new Map<string, Member>();
  const liveByIdentity = new Map<string, string>();
  for (const a of live) {
    const identity = computeIdentity(policy, a, lookup);
    members.set(`live:${a.assetId}`, { assetType: a.assetType, assetId: a.assetId, metadata: a.metadata, identity });
    if (identity !== null) liveByIdentity.set(`${a.assetType}\0${identity}`, a.assetId);
  }

  if (ctx.perAsset !== false) {
    for (const d of desired) {
      const prev = d.assetId ? liveById.get(d.assetId) : undefined;
      // An asset without an ID whose identity is live is an update (as below), so the create-only rules don't apply to it.
      const identity = d.assetId ? null : computeIdentity(policy, d, lookup);
      const replaces = identity === null ? undefined : liveByIdentity.get(`${d.assetType}\0${identity}`);
      out.push(...validateDraftAsset(replaces ? { ...d, assetId: replaces } : d, { policy, previous: prev ? { metadata: prev.metadata } : undefined }));
    }
  }

  desired.forEach((d, i) => {
    const identity = computeIdentity(policy, d, lookup);
    let replaces = d.assetId;
    if (!replaces && identity !== null) replaces = liveByIdentity.get(`${d.assetType}\0${identity}`);
    if (replaces) members.delete(`live:${replaces}`);
    members.set(`desired:${i}`, { assetType: d.assetType, assetId: d.assetId ?? replaces, metadata: d.metadata, refs: d.refs, desired: d, identity });
  });
  const all = [...members.values()];

  // Unique identities per type
  const groups = new Map<string, Member[]>();
  for (const m of all) {
    if (m.identity === null) continue;
    const k = `${m.assetType}\0${m.identity}`;
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // A name several live assets already share (the space allows it, for example a skill and its
    // older INACTIVE copy), with every desired member updating one of them by its own asset ID and
    // keeping its live identity: the change doesn't create the duplicate, so it is a warning.
    const preexisting = group.every((m) => {
      const own = m.desired ? m.desired.assetId : m.assetId;
      const before = own ? liveById.get(own) : undefined;
      return before !== undefined && computeIdentity(policy, before, lookup) === m.identity;
    });
    for (const m of group) {
      if (!m.desired) continue;
      const label = policy.assetTypes.assetTypes[m.assetType]!.label;
      if (preexisting) {
        out.push(
          warning("identity.duplicate-live", `${group.length} ${label.toLowerCase()} assets in this space already use ${m.identity}. The change updates each one by its asset ID; give them different names when you can.`, {
            assetKey: assetKeyOf(m.desired),
          }),
        );
      } else out.push(error("identity.duplicate", `Another ${label.toLowerCase()} already uses ${m.identity}; each must be unique.`, { assetKey: assetKeyOf(m.desired) }));
    }
  }

  // References
  for (const m of all) {
    if (!m.desired) continue;
    const entry = policy.assetTypes.assetTypes[m.assetType]!;
    for (const rule of entry.references) out.push(...referenceResults(policy, rule, m, all, lookup));
  }

  // Counts
  for (const [type, entry] of Object.entries(policy.assetTypes.assetTypes)) {
    for (const rule of entry.counts) out.push(...countResults(policy, type, entry, rule, all, lookup));
  }
  return out;
}

function asList(v: unknown): string[] {
  if (typeof v === "string") return v ? [v] : [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x !== "");
  return [];
}

function referenceResults(
  policy: ValidationPolicy,
  rule: AssetTypePolicy["references"][number],
  m: Member,
  all: Member[],
  lookup: IdentityLookup,
): ValidationResult[] {
  const out: ValidationResult[] = [];
  const assetKey = assetKeyOf(m.desired!);
  const targetLabel = policy.assetTypes.assetTypes[rule.assetType]?.label.toLowerCase() ?? rule.assetType;
  const ids = asList(m.metadata[rule.key]);
  const names = asList(m.refs?.[rule.ref]);
  const targets = all.filter((t) => t.assetType === rule.assetType);
  for (const id of ids) {
    if (!targets.some((t) => t.assetId === id)) {
      out.push(error("reference.unresolved", `${rule.key} ${id} is not a ${targetLabel} in this space.`, { assetKey, path: `metadata.${rule.key}` }));
    }
  }
  for (const name of names) {
    if (!targets.some((t) => t.identity === name)) {
      out.push(error("reference.unresolved", `No ${targetLabel} named ${name} exists in this space or in this change.`, { assetKey, path: `refs.${rule.ref}` }));
    }
  }
  if (rule.required && !ids.length && !names.length) {
    out.push(error("reference.missing", `Choose the ${targetLabel} this asset belongs to (${rule.key}).`, { assetKey, path: `metadata.${rule.key}` }));
  }
  if (!rule.many && ids.length === 1 && names.length === 1) {
    const byId = lookup(rule.assetType, ids[0]!);
    if (byId !== undefined && byId !== names[0]) {
      out.push(error("reference.conflict", `${rule.key} points to ${byId} but the name reference says ${names[0]}.`, { assetKey, path: `metadata.${rule.key}` }));
    }
  }
  return out;
}

function groupOf(member: Member, per: string | undefined, entry: AssetTypePolicy, lookup: IdentityLookup): string {
  if (!per) return "";
  const rule = entry.references.find((r) => r.ref === per);
  if (!rule) return "";
  const named = member.refs?.[per];
  if (typeof named === "string" && named) return named;
  const id = member.metadata[rule.key];
  if (typeof id === "string") return lookup(rule.assetType, id) ?? id;
  return "";
}

function countResults(
  policy: ValidationPolicy,
  type: string,
  entry: AssetTypePolicy,
  rule: AssetTypePolicy["counts"][number],
  all: Member[],
  lookup: IdentityLookup,
): ValidationResult[] {
  const max = policy.limits[rule.limit];
  const counted = all.filter(
    (m) => m.assetType === type && !Object.entries(rule.exclude).some(([k, values]) => values.includes(String(m.metadata[k]))),
  );
  const groups = new Map<string, Member[]>();
  for (const m of counted) {
    const g = groupOf(m, rule.per, entry, lookup);
    groups.set(g, [...(groups.get(g) ?? []), m]);
  }
  const out: ValidationResult[] = [];
  for (const [g, members] of groups) {
    if (members.length <= max) continue;
    const added = members.filter((m) => m.desired && !m.assetId);
    if (!added.length) continue;
    const label = entry.label.toLowerCase();
    const where = rule.per ? ` in ${g || "an unknown parent"}` : " in the space";
    out.push(
      error("count.limit", `This change makes ${members.length} ${label} assets${where}; the limit is ${max}.`, {
        assetKey: assetKeyOf(added[0]!.desired!),
      }),
    );
  }
  return out;
}
