import type { Policy } from "@/server/policy";
import type { PackageLayout } from "@/server/policy/sections/package-layouts";
import { computeIdentity, type IdentityLookup } from "@/server/validation/identity";
import { describeSchemaErrors, metadataValidator, resolvedSchema } from "@/server/validation/schemas";
import { error, warning, type ValidationResult } from "@/server/validation/types";
import { matchesKeep } from "./asset-folders";
import { assetKeyOf, type DesiredAsset, type LiveAssetRef } from "./types";

/**
 * A mapped package aimed at one space. Pure. Before the asset rules run
 * against that space:
 *
 *   1. an asset whose sourceAssetId is live in the space (same type) gets it
 *      as its assetId, so it updates that asset;
 *   2. asset types not in `includeTypes` are left out;
 *   3. package assets that share an identity and all carry a source asset ID
 *      (an Agent Space's skill and its older copy): when every one of those
 *      IDs is live in the space, each updates its own asset; otherwise the one
 *      the layout's `duplicates.keep` prefers is kept and the others are left
 *      out (all of them when none or several match);
 *   4. references by source asset ID (custom agent `skills` and
 *      `memory_stores`, `memory_store_id`) are remapped: an ID live in the
 *      space stays; an ID of another package asset becomes a name reference
 *      (refs) through that asset's identity, and then every ID of that key
 *      becomes a name, because a plan writes the names over the IDs; an ID
 *      that is neither is an error on the referring asset.
 *
 * Assets without source IDs (the instruction-folders layouts) pass through steps 1,
 * 3 and 4 unchanged.
 */

/** cannot-create: the asset is not in the space and its type's createSchema refuses it (a LEARNED skill: the agent writes those itself) */
export type LeftOutReason = "type-not-selected" | "duplicate" | "cannot-create";

export interface LeftOutAsset {
  asset: DesiredAsset;
  reason: LeftOutReason;
  /** Plain sentence for the import page and the plan notes */
  message: string;
  /** For duplicates: key of the asset that is planned instead, when one is */
  keptKey?: string;
}

export interface TargetOptions {
  policy: Pick<Policy, "assetTypes" | "agentTypes" | "limits">;
  layout: Pick<PackageLayout, "duplicates">;
  /** The space's assets; none: a space that holds none of the package's IDs */
  live?: readonly LiveAssetRef[];
  /** Asset types to keep; null or undefined: every type */
  includeTypes?: readonly string[] | null;
}

export interface TargetedPackage {
  /** The assets to plan, in mapping order, with assetId set where the source ID is live and references remapped */
  assets: DesiredAsset[];
  leftOut: LeftOutAsset[];
  /** Duplicate warnings and unresolvable references */
  results: ValidationResult[];
}

export function targetPackageAssets(mapped: readonly DesiredAsset[], opts: TargetOptions): TargetedPackage {
  const { policy, layout } = opts;
  const live = (opts.live ?? []).filter((a) => policy.assetTypes.assetTypes[a.assetType]);
  const liveById = new Map(live.map((a) => [a.assetId, a]));
  const lookup: IdentityLookup = (assetType, id) => {
    const a = liveById.get(id);
    return a && a.assetType === assetType ? (computeIdentity(policy, a, lookup) ?? undefined) : undefined;
  };
  const isLive = (a: Pick<DesiredAsset, "assetType" | "sourceAssetId">) => !!a.sourceAssetId && liveById.get(a.sourceAssetId)?.assetType === a.assetType;
  const identityOf = (a: DesiredAsset) => computeIdentity(policy, a) ?? a.key;
  const label = (t: string) => policy.assetTypes.assetTypes[t]?.label.toLowerCase() ?? t;
  const leftOut: LeftOutAsset[] = [];
  const results: ValidationResult[] = [];

  const include = opts.includeTypes ? new Set(opts.includeTypes) : null;
  let kept: DesiredAsset[] = [];
  for (const a of mapped) {
    if (include && !include.has(a.assetType)) leftOut.push({ asset: a, reason: "type-not-selected", message: `${where(a)} is left out: ${label(a.assetType)} assets were not selected for this import.` });
    else kept.push(a);
  }

  // Duplicate identities among assets with source IDs
  const groups = new Map<string, DesiredAsset[]>();
  for (const a of kept) {
    if (!a.sourceAssetId) continue;
    const k = `${a.assetType}\0${identityOf(a)}`;
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const dropped = new Set<DesiredAsset>();
  const keepText = describeKeep(layout.duplicates.keep);
  for (const group of groups.values()) {
    if (group.length < 2 || group.every(isLive)) continue;
    const preferred = group.filter((a) => matchesKeep(a.metadata, layout.duplicates));
    const winner = preferred.length === 1 ? preferred[0]! : null;
    const identity = identityOf(group[0]!);
    for (const a of group) {
      if (a === winner) continue;
      dropped.add(a);
      const message = winner
        ? `${where(a)} is left out: ${where(winner)} has the same name, ${identity}, and has ${keepText}. Assets that share a name are all imported only into a space that holds each of their asset IDs.`
        : `${where(a)} is left out: ${group.length} package ${label(a.assetType)} assets are named ${identity} and ${preferred.length === 0 ? "none" : "more than one"} has ${keepText}, so the import can't tell which one to plan.`;
      leftOut.push({ asset: a, reason: "duplicate", message, ...(winner ? { keptKey: winner.key } : {}) });
      results.push(warning("import.duplicate-left-out", message, { assetKey: assetKeyOf(a), ...(a.source ? { path: a.source } : {}) }));
    }
  }
  kept = kept.filter((a) => !dropped.has(a));

  // Assets from another space that this space would have to create, but whose
  // type's createSchema refuses them (policy asset-types.yaml). An asset whose
  // identity is live here is an update, so the create rules don't apply to it.
  const liveIdentities = new Set(live.map((a) => `${a.assetType}\0${computeIdentity(policy, a, lookup) ?? ""}`));
  kept = kept.filter((a) => {
    if (!a.sourceAssetId || isLive(a) || liveIdentities.has(`${a.assetType}\0${identityOf(a)}`)) return true;
    const validate = metadataValidator(policy, a.assetType, "createSchema");
    if (!validate || validate(a.metadata)) return true;
    const why = describeSchemaErrors(validate.errors, resolvedSchema(policy, a.assetType, "createSchema")!)
      .map((i) => i.message)
      .join(" ");
    const message = `${where(a)} is left out: it is not in this space, and it can't be created here. ${why}`.trim();
    leftOut.push({ asset: a, reason: "cannot-create", message });
    results.push(warning("import.cannot-create-left-out", message, { assetKey: assetKeyOf(a), ...(a.source ? { path: a.source } : {}) }));
    return false;
  });

  // Live IDs and remapped references
  const bySourceId = new Map<string, DesiredAsset>();
  for (const a of mapped) if (a.sourceAssetId && !bySourceId.has(a.sourceAssetId)) bySourceId.set(a.sourceAssetId, a);
  const liveNames = new Map<string, number>();
  for (const a of live) {
    const identity = computeIdentity(policy, a, lookup);
    if (identity !== null) liveNames.set(`${a.assetType}\0${identity}`, (liveNames.get(`${a.assetType}\0${identity}`) ?? 0) + 1);
  }
  const assets = kept.map((a) => {
    const out: DesiredAsset = isLive(a) ? { ...a, assetId: a.sourceAssetId } : a;
    return remapReferences(out, { policy, liveById, bySourceId, liveNames, lookup, identityOf, results });
  });
  return { assets, leftOut, results };
}

interface RemapContext {
  policy: Pick<Policy, "assetTypes">;
  liveById: Map<string, LiveAssetRef>;
  bySourceId: Map<string, DesiredAsset>;
  liveNames: Map<string, number>;
  lookup: IdentityLookup;
  identityOf: (a: DesiredAsset) => string;
  results: ValidationResult[];
}

function remapReferences(a: DesiredAsset, ctx: RemapContext): DesiredAsset {
  const entry = ctx.policy.assetTypes.assetTypes[a.assetType];
  if (!entry?.references.length || !a.sourceAssetId) return a;
  let metadata = a.metadata;
  let refs = a.refs;
  const assetKey = assetKeyOf(a);
  for (const rule of entry.references) {
    const raw = a.metadata[rule.key];
    const ids = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
    if (!ids.length) continue;
    const targetLabel = ctx.policy.assetTypes.assetTypes[rule.assetType]?.label.toLowerCase() ?? rule.assetType;
    const kinds = ids.map((id) => {
      if (ctx.liveById.get(id)?.assetType === rule.assetType) return "live" as const;
      if (ctx.bySourceId.get(id)?.assetType === rule.assetType) return "package" as const;
      return "unknown" as const;
    });
    const unknown = ids.filter((_, i) => kinds[i] === "unknown");
    for (const id of unknown) {
      ctx.results.push(
        error("reference.not-in-package", `${rule.key} names ${targetLabel} ${id}, which is not in this package or in this space, so the reference can't be kept here.`, {
          assetKey,
          path: `metadata.${rule.key}`,
        }),
      );
    }
    if (!kinds.includes("package")) {
      if (unknown.length) metadata = { ...metadata, [rule.key]: rule.many ? ids.filter((_, i) => kinds[i] === "live") : undefined };
      continue;
    }
    // A plan writes name references over the IDs of the same key, so every reference of this key becomes a name.
    const names: string[] = [];
    ids.forEach((id, i) => {
      if (kinds[i] === "package") names.push(ctx.identityOf(ctx.bySourceId.get(id)!));
      else if (kinds[i] === "live") {
        const name = ctx.lookup(rule.assetType, id);
        if (name !== undefined && (ctx.liveNames.get(`${rule.assetType}\0${name}`) ?? 0) === 1) names.push(name);
        else {
          ctx.results.push(
            error("reference.ambiguous-name", `${rule.key} names ${targetLabel} ${id}${name ? ` (${name})` : ""}, which shares its name with another ${targetLabel} in this space, so it can't be referenced by name next to the package's own ${targetLabel} assets.`, {
              assetKey,
              path: `metadata.${rule.key}`,
            }),
          );
        }
      }
    });
    const { [rule.key]: _ids, ...rest } = metadata;
    metadata = rest;
    refs = { ...(refs ?? {}), [rule.ref]: rule.many ? names : (names[0] ?? "") };
  }
  if (metadata === a.metadata && refs === a.refs) return a;
  const cleaned = Object.fromEntries(Object.entries(metadata).filter(([, v]) => v !== undefined));
  return { ...a, metadata: cleaned, ...(refs ? { refs } : {}) };
}

/** The asset's package path ("skill/verity.v2"), or its type and key. */
function where(a: DesiredAsset): string {
  return a.source ?? `${a.assetType} ${a.key}`;
}

/** "status ACTIVE" */
function describeKeep(keep: Record<string, unknown>): string {
  return Object.entries(keep)
    .map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" and ");
}
