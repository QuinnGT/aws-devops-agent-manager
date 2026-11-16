import type { AssetSnapshot } from "@/lib/assets/types";
import { mapLimit } from "@/server/aws/paginate";
import { isManagedAsset } from "@/server/drafts/rules";
import type { DesiredAsset, LiveAssetRef } from "@/server/packages/types";
import type { Policy } from "@/server/policy";
import type { SpaceSettings } from "@/server/spaces/settings-schema";
import type { LiveAsset } from "@/server/sync/reader";
import { validateAssetSet } from "@/server/validation/set";
import { errorsOf, warningsOf, type ValidationResult } from "@/server/validation/types";
import { checkItem, distributeResults, liveMovedPast, type LiveState, uniqueResults, validationStatusOf } from "./decide";
import { IdentityIndex, resolveRefsWith } from "./resolve";
import { stateAfterCheck } from "./states";
import type { ItemPatch, PlanStore } from "./store";
import type { PlanItemRow, PlanRow, PlanSummary } from "./types";

/**
 * The plan check job (worker, read role): read each item's live asset,
 * decide the change, compute the diffs, validate each item and the whole set
 * against the live index, flag conflicts and measure instructions. Re-check
 * runs it again. The I/O is behind `deps` so it can be unit-tested.
 */

/** A live index entry (asset_index): context for set validation and reference names. */
export interface IndexedLiveAsset extends LiveAssetRef {
  name: string;
}

/** The reads the check needs (SpaceReader with the space's read role). */
export interface LiveReader {
  getAsset(assetId: string): Promise<LiveAsset | null>;
  snapshot(asset: { assetId: string; assetType: string }, version: { version: number; createdAt: Date; updatedAt: Date }): Promise<AssetSnapshot>;
}

export interface CheckDeps {
  store: PlanStore;
  policy: Pick<Policy, "assetTypes" | "agentTypes" | "limits" | "plans">;
  settings: Pick<SpaceSettings, "deletesEnabled">;
  liveIndex: readonly IndexedLiveAsset[];
  reader: LiveReader;
  /** Source label of a recorded change of the asset at this version, for conflict messages */
  liveSource?: (assetId: string, version: number, updatedAt: Date) => Promise<string | null>;
  now?: () => Date;
}

export interface CheckOptions {
  /** job_runs.id of this check; a check that is no longer the plan's latest does nothing */
  runId: string;
  /** Plan against live as it is now (re-check from the conflict callout) */
  rebase?: boolean;
}

export type CheckOutcome = { status: "checked"; summary: PlanSummary } | { status: "skipped"; reason: string };

export class PlanCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanCheckError";
  }
}

export async function runPlanCheck(planId: string, opts: CheckOptions, deps: CheckDeps): Promise<CheckOutcome> {
  const now = deps.now ?? (() => new Date());
  const plan = await deps.store.getPlan(planId);
  if (!plan) throw new PlanCheckError(`Plan ${planId} not found.`);
  if (plan.state !== "checking") return { status: "skipped", reason: `The plan is ${plan.state}, not checking.` };
  if (plan.checkRunId && plan.checkRunId !== opts.runId) return { status: "skipped", reason: "A newer check of this plan was requested." };

  try {
    const items = await deps.store.getItems(planId);
    const { patches, planValidation, summary } = await checkItems(plan, items, opts, deps);
    for (const [id, patch] of patches) await deps.store.updateItem(id, { ...patch, checkedAt: now() });
    const updated = await deps.store.updatePlan(
      planId,
      { state: stateAfterCheck(plan), checkedAt: now(), checkError: null, summary, validation: planValidation },
      { whereStates: ["checking"], whereCheckRunId: plan.checkRunId },
    );
    if (!updated) return { status: "skipped", reason: "The plan changed while it was being checked." };
    return { status: "checked", summary };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 500) : String(err).slice(0, 500);
    await deps.store.updatePlan(planId, { state: stateAfterCheck(plan), checkedAt: now(), checkError: message }, { whereStates: ["checking"], whereCheckRunId: plan.checkRunId });
    throw err;
  }
}

/** Check every item against live. Returns the item patches, plan-level results and the summary; writes nothing. */
export async function checkItems(
  plan: Pick<PlanRow, "id">,
  items: readonly PlanItemRow[],
  opts: Pick<CheckOptions, "rebase">,
  deps: Omit<CheckDeps, "store">,
): Promise<{ patches: Map<string, ItemPatch>; planValidation: ValidationResult[]; summary: PlanSummary }> {
  const { policy } = deps;
  const index = new IdentityIndex(policy, deps.liveIndex);
  const nameOf = (type: string, id: string) => deps.liveIndex.find((a) => a.assetId === id && a.assetType === type)?.name;

  // Target asset of each item: its own ID, or the live asset with the same identity.
  const targets = items.map((it) => {
    if (it.kind === "delete") return { id: it.assetId, matched: false };
    const own = it.assetId ?? it.desired?.assetId ?? null;
    if (own) return { id: own, matched: false };
    const identity = it.desired ? index.identityOf(it.desired) : null;
    const found = identity !== null ? index.get(it.assetType, identity) : undefined;
    return { id: found ?? null, matched: Boolean(found) };
  });

  const lives = await mapLimit(items, policy.plans.check.concurrency, async (_it, i): Promise<LiveState | null> => {
    const id = targets[i]!.id;
    if (!id) return null;
    const asset = await deps.reader.getAsset(id);
    if (!asset) return null;
    const snap = await deps.reader.snapshot(asset, asset);
    return { assetId: asset.assetId, version: asset.version, updatedAt: asset.updatedAt, metadata: snap.metadata, files: snap.files };
  });

  // Name references written into their ID fields (creates and updates), against live and the plan's own creates.
  const creating = new Set(
    items.flatMap((it, i) => {
      if (it.kind !== "upsert" || targets[i]!.id || !it.desired) return [];
      const identity = index.identityOf(it.desired);
      return identity === null ? [] : [`${it.assetType}\0${identity}`];
    }),
  );
  const pending = (assetType: string, name: string) => creating.has(`${assetType}\0${name}`);

  const results = await Promise.all(
    items.map(async (it, i) => {
      const live = lives[i] ?? null;
      const target = targets[i]!;
      const desired = it.desired ? { ...it.desired, ...(target.id && it.kind === "upsert" ? { assetId: target.id } : {}) } : null;
      const resolvedMetadata = desired?.refs ? resolveRefsWith(policy, desired, index, pending).metadata : undefined;
      const managed = isManagedAsset(policy, desired ?? { assetType: it.assetType, metadata: live?.metadata ?? {} }, nameOf);
      const moved = live && liveMovedPast({ version: it.baseVersion, updatedAt: it.baseUpdatedAt }, live);
      const liveSource = moved && deps.liveSource ? await deps.liveSource(live.assetId, live.version, live.updatedAt).catch(() => null) : null;
      const r = checkItem(
        { kind: it.kind, assetType: it.assetType, assetKey: it.assetKey, assetId: target.id, desired, baseVersion: it.baseVersion, baseUpdatedAt: it.baseUpdatedAt, removeMetadataKeys: it.removeMetadataKeys, resolvedMetadata },
        live,
        { policy, deletesEnabled: deps.settings.deletesEnabled, managed, rebase: opts.rebase, liveSource },
      );
      return { r, desired, matched: target.matched };
    }),
  );

  // Set-level rules against the live index: unique names, references, counts.
  const deleted = new Set(items.filter((it) => it.kind === "delete" && it.assetId).map((it) => it.assetId!));
  const desiredSet: DesiredAsset[] = results.flatMap(({ desired }) => (desired ? [desired] : []));
  const setResults = validateAssetSet(desiredSet, { policy, live: deps.liveIndex.filter((a) => !deleted.has(a.assetId)), perAsset: false });
  const { byItem, plan: planLevel } = distributeResults(setResults, items);

  const patches = new Map<string, ItemPatch>();
  items.forEach((it, i) => {
    const { r, matched } = results[i]!;
    const validation = uniqueResults([...r.validation, ...byItem[i]!]);
    patches.set(it.id, {
      assetId: r.assetId,
      change: r.change,
      liveVersion: r.liveVersion,
      liveUpdatedAt: r.liveUpdatedAt,
      conflict: r.conflict,
      metadataDiff: r.metadataDiff,
      contentDiff: r.contentDiff,
      addedLines: r.addedLines,
      removedLines: r.removedLines,
      validation,
      validationStatus: validationStatusOf(validation),
      sizeMeter: r.sizeMeter,
      writeSteps: r.writeSteps,
      baseVersion: r.baseVersion,
      baseUpdatedAt: r.baseUpdatedAt,
      ...(matched && it.desired ? { desired: { ...it.desired, assetId: r.assetId ?? undefined }, note: it.note ?? "Matched to the live asset with the same name." } : {}),
    });
  });

  const rows = items.map((it) => {
    const p = patches.get(it.id)!;
    return { change: p.change ?? null, conflict: p.conflict ?? null, validation: p.validation ?? [], validationStatus: p.validationStatus ?? null };
  });
  return { patches, planValidation: planLevel, summary: summarize(rows, planLevel) };
}

export function summarize(
  items: readonly Pick<PlanItemRow, "change" | "conflict" | "validation" | "validationStatus">[],
  planValidation: readonly ValidationResult[],
): PlanSummary {
  const count = (c: string) => items.filter((i) => i.change === c && !i.conflict).length;
  const skipped = items.filter((i) => i.conflict).length;
  const all = items.flatMap((i) => (i.validation ?? []) as ValidationResult[]);
  const planErrors = errorsOf(planValidation).length;
  const s = {
    items: items.length,
    creates: count("create"),
    contentUpdates: count("content"),
    metadataUpdates: count("metadata"),
    statusChanges: count("status"),
    unchanged: items.filter((i) => i.change === "none" && !i.conflict).length,
    deletes: count("delete"),
    skipped,
  };
  return {
    ...s,
    writes: s.creates + s.contentUpdates + s.metadataUpdates + s.statusChanges + s.deletes,
    validation: {
      checkedAssets: items.length,
      failedAssets: items.filter((i) => i.validationStatus === "failed").length,
      errors: errorsOf(all).length + planErrors,
      warnings: warningsOf(all).length + warningsOf(planValidation).length,
      planErrors,
    },
  };
}

/** Number shown in "Validation failed for <N> asset(s)." */
export function validationFailedCount(summary: PlanSummary | null | undefined): number {
  if (!summary) return 0;
  return summary.validation.failedAssets + summary.validation.planErrors;
}
