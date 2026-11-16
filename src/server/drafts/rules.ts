import type { DesiredAsset } from "@/server/packages/types";
import type { Policy } from "@/server/policy";
import { error, type ValidationResult } from "@/server/validation/types";
import { sameValue } from "@/server/plans/content";

/**
 * What a draft (or any plan item) may change, from asset-types.yaml
 * (`editable`, `managedNames`, `supportsStatus`) and plans.yaml `managed`.
 * Pure; unit-tested. The plan check applies the same rules to every item,
 * whatever made the plan.
 *
 * Managed assets are the ones named in their type's `managedNames`, and
 * assets whose single reference (a memory's store) points to a managed one.
 * Tested on a test space (2026-11-13): the service accepts content and metadata
 * writes to them, so plans.yaml `managed` allows both by default; each switch
 * can still turn one off.
 */

/** Why a managed asset's content is locked when plans.yaml turns it off (MANAGED_LOCK_REASON on the asset page reads the same). */
export const MANAGED_CONTENT_REASON = "Editing memories in managed stores is turned off in this app's plan rules.";

type RulesPolicy = Pick<Policy, "assetTypes" | "plans">;

/** The metadata key of the Active switch (asset-types.yaml `supportsStatus`). */
export const STATUS_KEY = "status";

export interface EditRules {
  /** The type can be edited at all */
  editable: boolean;
  managed: boolean;
  content: boolean;
  /** Metadata other than status */
  metadata: boolean;
  status: boolean;
  /** Plain reason when something is locked */
  reason: string | null;
}

/** Name of the referenced asset with this ID, if known. */
export type NameLookup = (assetType: string, assetId: string) => string | undefined;

export function isManagedAsset(policy: Pick<Policy, "assetTypes">, asset: Pick<DesiredAsset, "assetType" | "metadata" | "refs">, lookupName: NameLookup): boolean {
  const entry = policy.assetTypes.assetTypes[asset.assetType];
  if (!entry) return false;
  const name = asset.metadata.name;
  if (typeof name === "string" && entry.managedNames.includes(name)) return true;
  for (const rule of entry.references) {
    if (rule.many) continue;
    const target = policy.assetTypes.assetTypes[rule.assetType];
    if (!target?.managedNames.length) continue;
    const named = asset.refs?.[rule.ref];
    const id = asset.metadata[rule.key];
    const parentName = typeof named === "string" && named ? named : typeof id === "string" ? lookupName(rule.assetType, id) : undefined;
    if (parentName && target.managedNames.includes(parentName)) return true;
  }
  return false;
}

export function editRulesFor(policy: RulesPolicy, assetType: string, managed: boolean): EditRules {
  const entry = policy.assetTypes.assetTypes[assetType];
  if (!entry) return { editable: false, managed, content: false, metadata: false, status: false, reason: `Asset type ${assetType} has no entry in asset-types.yaml.` };
  if (!entry.editable) return { editable: false, managed, content: false, metadata: false, status: false, reason: `${entry.label} assets can't be edited in this app.` };
  if (!managed) return { editable: true, managed, content: true, metadata: true, status: entry.supportsStatus, reason: null };
  const m = policy.plans.managed;
  const status = entry.supportsStatus && m.allowStatusSwitch;
  const locked = !m.allowContentEdit || !m.allowMetadataEdit;
  return {
    editable: status || m.allowContentEdit || m.allowMetadataEdit,
    managed,
    content: m.allowContentEdit,
    metadata: m.allowMetadataEdit,
    status,
    reason: locked
      ? status
        ? `${MANAGED_CONTENT_REASON} You can still switch them on or off.`
        : "DevOps Agent manages this asset, so it can't be changed in this app."
      : null,
  };
}

export interface EditState {
  metadata: Record<string, unknown>;
  contentHash: string;
}

/**
 * Changes from `before` to `after` that the rules don't allow. `before` is
 * null for a new asset.
 */
export function editViolations(rules: EditRules, before: EditState | null, after: EditState, assetKey: string): ValidationResult[] {
  const out: ValidationResult[] = [];
  if (!rules.editable) {
    if (before === null || before.contentHash !== after.contentHash || !sameValue(before.metadata, after.metadata)) {
      out.push(error("edit.not-allowed", rules.reason ?? "This asset can't be changed in this app.", { assetKey }));
    }
    return out;
  }
  if (before === null) {
    if (rules.managed) out.push(error("managed.create", "This name belongs to an asset managed by DevOps Agent; choose another name.", { assetKey, path: "metadata.name" }));
    return out;
  }
  if (!rules.content && before.contentHash !== after.contentHash) {
    out.push(error("managed.content", rules.reason ?? "The content of this asset can't be changed in this app.", { assetKey }));
  }
  const keys = new Set([...Object.keys(before.metadata), ...Object.keys(after.metadata)]);
  for (const k of [...keys].sort()) {
    if (sameValue(before.metadata[k], after.metadata[k])) continue;
    const allowed = k === STATUS_KEY ? rules.status : rules.metadata;
    if (!allowed) {
      out.push(
        error(k === STATUS_KEY ? "edit.status" : "managed.metadata", k === STATUS_KEY ? "The Active switch doesn't apply to this asset type." : (rules.reason ?? `metadata.${k} can't be changed in this app.`), {
          assetKey,
          path: `metadata.${k}`,
        }),
      );
    }
  }
  return out;
}
