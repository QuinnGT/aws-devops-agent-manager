import { editRulesFor, isManagedAsset, MANAGED_CONTENT_REASON, type EditRules } from "@/server/drafts/rules";
import type { Policy } from "@/server/policy";

/**
 * What the asset page and list may offer for one asset ("Edit as draft", the
 * Active switch, "Restore as a plan"), from the drafts edit rules so the page
 * and the plan check agree. Pure.
 */

export interface AssetActionRules {
  rules: EditRules;
  /** The type is editable in this app at all (asset-types.yaml `editable`) */
  typeEditable: boolean;
  supportsStatus: boolean;
  /** "Edit as draft" and "Restore as a plan" are blocked: the reason to show, else null */
  contentLocked: string | null;
}

/** Shown next to a disabled "Edit as draft" or "Restore" on a managed asset (word list in the design spec). */
export const MANAGED_LOCK_REASON = `${MANAGED_CONTENT_REASON} You can still switch them on or off.`;

export function assetActionRules(
  policy: Pick<Policy, "assetTypes" | "plans">,
  asset: { assetType: string; metadata: Record<string, unknown> },
  nameOf: (assetType: string, assetId: string) => string | undefined,
): AssetActionRules {
  const entry = policy.assetTypes.assetTypes[asset.assetType];
  const managed = isManagedAsset(policy, { assetType: asset.assetType, metadata: asset.metadata }, nameOf);
  const rules = editRulesFor(policy, asset.assetType, managed);
  const typeEditable = Boolean(entry?.editable);
  const contentLocked = !typeEditable || rules.content ? null : managed ? MANAGED_LOCK_REASON : (rules.reason ?? "This asset can't be edited in this app.");
  return { rules, typeEditable, supportsStatus: Boolean(entry?.supportsStatus), contentLocked };
}
