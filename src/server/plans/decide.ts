import type { AssetFileSnapshot } from "@/lib/assets/types";
import { diffAssetVersions, diffRecords, type FileDiff, type ValueChange } from "@/server/assets/diff";
import { measureInstructions, type SizeMeter } from "@/server/assets/size-meter";
import { editRulesFor, editViolations } from "@/server/drafts/rules";
import { assetKeyOf, type DesiredAsset } from "@/server/packages/types";
import type { Policy } from "@/server/policy";
import { writeModesFor } from "@/server/policy/sections/plans";
import { mainFileOf, validateDraftAsset } from "@/server/validation/asset";
import { error, hasErrors, warning, type ValidationResult } from "@/server/validation/types";
import { applyMetadataPatch, desiredContentHash, desiredFileBytes, desiredVersionContent, hashDesiredFiles, liveVersionContent, metadataPatch, snapshotContentHash } from "./content";
import type { ItemChange, ItemConflict, WriteStep } from "./types";
import { planWriteSteps } from "./write-plan";

/**
 * The plan check for one item, given the live asset. Pure; unit-tested. The check job reads live and stores
 * the result; the apply job re-reads live before writing.
 */

export type CheckPolicy = Pick<Policy, "assetTypes" | "agentTypes" | "limits" | "plans">;

export interface LiveState {
  assetId: string;
  version: number;
  updatedAt: Date;
  metadata: Record<string, unknown>;
  files: AssetFileSnapshot[];
}

export interface CheckItemInput {
  kind: "upsert" | "delete";
  assetType: string;
  assetKey: string;
  /** Target asset (from the input, or matched by identity) */
  assetId: string | null;
  desired: DesiredAsset | null;
  baseVersion: number | null;
  baseUpdatedAt: Date | null;
  removeMetadataKeys: readonly string[];
  /**
   * desired.metadata with name references (refs) written into their ID fields,
   * for the PATCH, the diff and the edit rules. Validation uses `desired` itself.
   */
  resolvedMetadata?: Record<string, unknown>;
}

export interface CheckContext {
  policy: CheckPolicy;
  deletesEnabled: boolean;
  /** The asset (or its parent store) is managed by DevOps Agent */
  managed: boolean;
  /** Ignore the base: plan against live as it is now (re-check from the conflict callout) */
  rebase?: boolean;
  /** Source label of the live version, for the conflict message */
  liveSource?: string | null;
}

export interface CheckItemResult {
  assetId: string | null;
  change: ItemChange;
  liveVersion: number | null;
  liveUpdatedAt: Date | null;
  conflict: ItemConflict | null;
  metadataDiff: ValueChange[];
  contentDiff: FileDiff[];
  addedLines: number;
  removedLines: number;
  /** Item-level results: per-asset validation, edit rules, write mode; set-level results are added by the caller */
  validation: ValidationResult[];
  writeSteps: WriteStep[];
  sizeMeter: SizeMeter | null;
  /** New base when rebased */
  baseVersion: number | null;
  baseUpdatedAt: Date | null;
}

const second = (d: Date) => Math.floor(d.getTime() / 1000);

/** Live moved past the base: a newer version, or a newer updatedAt on the same version (to the second). */
export function liveMovedPast(base: { version: number | null; updatedAt: Date | null }, live: { version: number; updatedAt: Date }): boolean {
  if (base.version === null) return false;
  if (live.version !== base.version) return true;
  return base.updatedAt !== null && second(live.updatedAt) > second(base.updatedAt);
}

export function checkItem(input: CheckItemInput, live: LiveState | null, ctx: CheckContext): CheckItemResult {
  const { policy } = ctx;
  const base = {
    assetId: input.assetId,
    liveVersion: live?.version ?? null,
    liveUpdatedAt: live?.updatedAt ?? null,
    conflict: null as ItemConflict | null,
    metadataDiff: [] as ValueChange[],
    contentDiff: [] as FileDiff[],
    addedLines: 0,
    removedLines: 0,
    validation: [] as ValidationResult[],
    writeSteps: [] as WriteStep[],
    sizeMeter: null as SizeMeter | null,
    baseVersion: input.baseVersion,
    baseUpdatedAt: input.baseUpdatedAt,
  };
  const assetKey = `${input.assetType}:${input.assetKey}`;

  if (input.kind === "delete") {
    if (!ctx.deletesEnabled) base.validation.push(error("delete.disabled", "Deletes are off for this space. An Admin can turn on deletesEnabled in the space settings.", { assetKey }));
    if (!live) return { ...base, change: "none", validation: [...base.validation, warning("delete.already-gone", "The asset is already gone from the space.", { assetKey })] };
    return { ...base, change: "delete", writeSteps: [{ op: "DeleteAsset" }], metadataDiff: diffRecords(live.metadata, {}) };
  }

  const desired = input.desired!;
  const entry = policy.assetTypes.assetTypes[desired.assetType];
  const rules = editRulesFor(policy, desired.assetType, ctx.managed);
  const desiredHash = desiredContentHash(desired.files);
  const writeMetadata = input.resolvedMetadata ?? desired.metadata;

  if (input.assetId && !live) {
    return {
      ...base,
      change: "none",
      conflict: { kind: "missing", message: "The asset no longer exists in the space. Create a new plan to add it again.", baseVersion: input.baseVersion, baseUpdatedAt: iso(input.baseUpdatedAt) },
      validation: validateDraftAsset(desired, { policy }),
    };
  }

  const validation: ValidationResult[] = validateDraftAsset(desired, { policy, previous: live ? { metadata: live.metadata } : undefined });

  // Metadata PATCH and the metadata after apply.
  const remove = [...input.removeMetadataKeys];
  if (remove.length && policy.plans.write.metadataRemoval === "refuse" && live && remove.some((k) => k in live.metadata)) {
    validation.push(error("metadata.removal", `Removing ${remove.join(", ")} is turned off in plans.yaml (write.metadataRemoval: refuse).`, { assetKey }));
  }
  const patch = live ? metadataPatch(live.metadata, writeMetadata, remove) : {};
  const after = live ? applyMetadataPatch(live.metadata, patch) : writeMetadata;
  // The edit rules judge what apply will change: the metadata after the PATCH. A key the
  // desired metadata leaves out (an imported AGENTS.md has no status) stays as it is live.
  validation.push(...editViolations(rules, live ? { metadata: live.metadata, contentHash: snapshotContentHash(live) } : null, { metadata: after, contentHash: desiredHash }, assetKey));
  const metadataDiff = diffRecords(live?.metadata ?? {}, after);

  // Content diff, live against planned.
  const diff = diffAssetVersions(liveVersionContent(live?.metadata ?? {}, live?.files ?? []), desiredVersionContent(after, desired.files));
  const contentDiff = diff.files.filter((f) => f.status !== "unchanged");
  const addedLines = contentDiff.reduce((n, f) => n + f.added, 0);
  const removedLines = contentDiff.reduce((n, f) => n + f.removed, 0);

  const contentChanged = live ? snapshotContentHash(live) !== desiredHash : true;
  const patchKeys = Object.keys(patch);
  let change: ItemChange;
  if (!live) change = "create";
  else if (contentChanged) change = "content";
  else if (patchKeys.length === 1 && patchKeys[0] === "status") change = "status";
  else if (patchKeys.length) change = "metadata";
  else change = "none";

  const plan = planWriteSteps({
    kind: live ? "update" : "create",
    multiFile: entry?.content === "multi-file",
    modes: writeModesFor(policy.plans, desired.assetType),
    live: live?.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })) ?? [],
    desired: hashDesiredFiles(desired.files),
    metadataChanged: patchKeys.length > 0,
  });
  if (!plan.ok) validation.push(error("write.mode", plan.message, { assetKey }));

  let conflict: ItemConflict | null = null;
  let baseVersion = input.baseVersion;
  let baseUpdatedAt = input.baseUpdatedAt;
  if (live && ctx.rebase) {
    baseVersion = live.version;
    baseUpdatedAt = live.updatedAt;
  } else if (live && liveMovedPast({ version: input.baseVersion, updatedAt: input.baseUpdatedAt }, live)) {
    conflict = {
      kind: "moved",
      message: `Live moved from v${input.baseVersion} to v${live.version} after this plan was made.`,
      baseVersion: input.baseVersion,
      baseUpdatedAt: iso(input.baseUpdatedAt),
      liveVersion: live.version,
      liveUpdatedAt: live.updatedAt.toISOString(),
      source: ctx.liveSource ?? null,
    };
  }

  return {
    ...base,
    assetId: input.assetId,
    change,
    conflict,
    metadataDiff,
    contentDiff,
    addedLines,
    removedLines,
    validation,
    writeSteps: plan.ok && change !== "none" ? plan.steps : [],
    sizeMeter: sizeMeterFor(policy, desired),
    baseVersion,
    baseUpdatedAt,
  };
}

/** Size meter of the main file after the change, for types with a byte limit and a recommended line count (instructions). */
export function sizeMeterFor(policy: Pick<Policy, "assetTypes" | "limits">, desired: Pick<DesiredAsset, "assetType" | "files">): SizeMeter | null {
  const entry = policy.assetTypes.assetTypes[desired.assetType];
  const maxKey = entry?.limits.mainFileMaxBytes;
  const linesKey = entry?.limits.mainFileRecommendedLines;
  if (!entry || !maxKey || !linesKey) return null;
  const main = mainFileOf(entry, desired.files);
  if (!main) return null;
  const text = main.encoding === "utf8" ? main.content : desiredFileBytes(main).toString("utf8");
  return measureInstructions(text, { agentsMdMaxBytes: policy.limits[maxKey], agentsMdRecommendedLines: policy.limits[linesKey] });
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/** "passed", "warnings" or "failed" for a result list. */
export function validationStatusOf(results: readonly ValidationResult[]): "passed" | "warnings" | "failed" {
  if (hasErrors(results)) return "failed";
  return results.length ? "warnings" : "passed";
}

/** Split set-level results into per-item lists (by `${assetType}:${assetKey}`) and plan-level ones. */
export function distributeResults(results: readonly ValidationResult[], items: readonly { assetType: string; assetKey: string }[]): { byItem: ValidationResult[][]; plan: ValidationResult[] } {
  const byKey = new Map<string, number[]>();
  items.forEach((it, i) => {
    const k = `${it.assetType}:${it.assetKey}`;
    byKey.set(k, [...(byKey.get(k) ?? []), i]);
  });
  const byItem = items.map(() => [] as ValidationResult[]);
  const plan: ValidationResult[] = [];
  for (const r of results) {
    const idx = r.assetKey ? byKey.get(r.assetKey) : undefined;
    if (idx?.length) for (const i of idx) byItem[i]!.push(r);
    else plan.push(r);
  }
  return { byItem, plan };
}

/** Dedupe validation results (per-asset rules can arrive from two passes). */
export function uniqueResults(results: readonly ValidationResult[]): ValidationResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const k = `${r.level}\0${r.code}\0${r.assetKey ?? ""}\0${r.path ?? ""}\0${r.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export { assetKeyOf };
