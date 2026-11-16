import type { AssetFileSnapshot, AssetSnapshot } from "@/lib/assets/types";
import { assetDisplayName, fillTemplate } from "@/server/history/layout";
import { snapshotsToDesiredAssets } from "@/server/packages/live";
import { assetKeyOf, type DesiredAsset } from "@/server/packages/types";
import type { PlanItemInput } from "@/server/plans/contract";
import type { Policy } from "@/server/policy";
import type { AddedAfterAction } from "@/server/policy/sections/releases";
import { canonicalize } from "@/server/sync/content";
import { assetIdentity, computeIdentity, type IdentityLookup } from "@/server/validation/identity";
import { error, warning, type ValidationResult } from "@/server/validation/types";

/**
 * The rollback planner's pure part. Two steps, with I/O between them (src/server/releases/rollback.ts):
 *
 * 1. classifyRollback: match every target asset to the current index (by ID,
 *    then by type and identity), decide which are restored, recreated or
 *    skipped, and what happens to assets added after the target.
 * 2. buildRollbackItems: turn the target files (read from git or the
 *    service) into plan items with DesiredAsset, refs by name, removed
 *    metadata keys and notes.
 */

export type RollbackPolicy = Pick<Policy, "assetTypes" | "historyLayout" | "releases">;

/** "space": a release or a commit (the whole space). "asset": one version of one asset. */
export type RollbackScope = "space" | "asset";

/** One asset of the target state (from a manifest, an asset.json or the service). */
export interface TargetAsset {
  assetId: string;
  assetType: string;
  metadata: Record<string, unknown>;
  serviceVersion: number;
  serviceUpdatedAt: string;
}

/** One asset_index row: the current state as last synced. */
export interface CurrentAsset {
  assetId: string;
  assetType: string;
  name: string;
  parentAssetId: string | null;
  metadata: Record<string, unknown>;
  liveVersion: number | null;
  liveUpdatedAt: string | null;
  deleted: boolean;
}

export interface RestoreEntry {
  target: TargetAsset;
  key: string;
  name: string;
  /** The live asset the item updates; null when the item creates the asset again */
  liveAssetId: string | null;
  via: "id" | "identity" | "create";
  removeMetadataKeys: string[];
  /** What the index suggests the item will do; the plan check decides */
  expected: "changes" | "unchanged" | "create";
}

export type AddedAfterOutcome = AddedAfterAction | "already-inactive";

export interface AddedAfterEntry {
  current: CurrentAsset;
  key: string;
  action: AddedAfterOutcome;
}

export type SkipReason = "managed" | "not-editable" | "unknown-type";

export interface SkippedEntry {
  assetId: string;
  assetType: string;
  key: string;
  name: string;
  /** Whether the skipped asset is in the target or only in the current space */
  side: "target" | "current";
  reason: SkipReason;
}

export interface RollbackClassification {
  scope: RollbackScope;
  restore: RestoreEntry[];
  addedAfter: AddedAfterEntry[];
  skipped: SkippedEntry[];
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function asList(v: unknown): string[] {
  if (typeof v === "string") return v ? [v] : [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x !== "");
  return [];
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

type Named = { assetId: string; assetType: string; metadata: Record<string, unknown>; name: string };

/**
 * Managed per asset-types.yaml managedNames: the asset itself, or an asset
 * whose parent (a required single reference, such as a memory's store) is.
 */
function isManaged(policy: RollbackPolicy, a: Named, byId: ReadonlyMap<string, Named>): boolean {
  const types = policy.assetTypes.assetTypes;
  const entry = types[a.assetType];
  if (!entry) return false;
  if (entry.managedNames.includes(a.name)) return true;
  for (const rule of entry.references) {
    if (rule.many || !rule.required) continue;
    const id = a.metadata[rule.key];
    const parent = typeof id === "string" ? byId.get(id) : undefined;
    if (parent && types[parent.assetType]?.managedNames.includes(parent.name)) return true;
  }
  return false;
}

function skipReason(policy: RollbackPolicy, a: Named, byId: ReadonlyMap<string, Named>): SkipReason | null {
  const entry = policy.assetTypes.assetTypes[a.assetType];
  if (!entry) return "unknown-type";
  if (!entry.editable) return "not-editable";
  if (policy.releases.rollback.managed === "skip" && isManaged(policy, a, byId)) return "managed";
  return null;
}

function addedAfterAction(policy: RollbackPolicy, c: CurrentAsset): AddedAfterOutcome {
  const r = policy.releases.rollback;
  const action = r.addedAfterTarget[c.assetType] ?? r.addedAfterTarget.default ?? "keep";
  if (action !== "deactivate") return action;
  if (!policy.assetTypes.assetTypes[c.assetType]?.supportsStatus) return "keep";
  return c.metadata[r.statusKey] === r.inactiveValue ? "already-inactive" : "deactivate";
}

export function classifyRollback(input: {
  scope: RollbackScope;
  targets: readonly TargetAsset[];
  current: readonly CurrentAsset[];
  policy: RollbackPolicy;
}): RollbackClassification {
  const { scope, targets, current, policy } = input;
  const layout = policy.historyLayout;
  const targetNamed: Named[] = targets.map((t) => ({ ...t, name: assetDisplayName(layout, t) }));
  const currentNamed: Named[] = current.map((c) => ({ ...c }));
  const targetById = new Map(targetNamed.map((t) => [t.assetId, t]));
  const currentById = new Map(currentNamed.map((c) => [c.assetId, c]));
  // Targets resolve references within the target set first, then against the index.
  const namedById = new Map<string, Named>([...currentById, ...targetById]);
  const identityLookup = (byId: ReadonlyMap<string, Named>): IdentityLookup => (assetType, id) => {
    const a = byId.get(id);
    return a && a.assetType === assetType ? (computeIdentity(policy, a) ?? undefined) : undefined;
  };
  const targetLookup = identityLookup(namedById);
  const currentLookup = identityLookup(currentById);

  const live = current.filter((c) => !c.deleted);
  const liveById = new Map(live.map((c) => [c.assetId, c]));
  const liveByKey = new Map<string, CurrentAsset>();
  const currentKeys = new Map<string, string>();
  for (const c of live) {
    const key = assetIdentity(policy, c, currentLookup);
    currentKeys.set(c.assetId, key);
    liveByKey.set(`${c.assetType}\0${key}`, c);
  }

  const used = new Set<string>();
  const restore: RestoreEntry[] = [];
  const skipped: SkippedEntry[] = [];
  const keep = new Set(policy.releases.rollback.keepMetadataKeys);

  targetNamed.forEach((t, i) => {
    const target = targets[i]!;
    const key = assetIdentity(policy, t, targetLookup);
    let match = liveById.get(t.assetId);
    let via: RestoreEntry["via"] = "id";
    if (!match || match.assetType !== t.assetType || used.has(match.assetId)) {
      const byKey = liveByKey.get(`${t.assetType}\0${key}`);
      match = byKey && !used.has(byKey.assetId) && !targetById.has(byKey.assetId) ? byKey : undefined;
      via = match ? "identity" : "create";
    }
    if (match) used.add(match.assetId);
    const reason = skipReason(policy, t, namedById);
    if (reason) {
      skipped.push({ assetId: t.assetId, assetType: t.assetType, key, name: t.name, side: "target", reason });
      return;
    }
    const immutable = new Set(policy.assetTypes.assetTypes[t.assetType]?.immutableKeys ?? []);
    const removeMetadataKeys = match
      ? Object.keys(match.metadata)
          .filter((k) => !(k in target.metadata) && !keep.has(k) && !immutable.has(k))
          .sort()
      : [];
    const expected: RestoreEntry["expected"] = !match
      ? "create"
      : via === "id" && match.liveVersion === target.serviceVersion && sameJson(match.metadata, target.metadata)
        ? "unchanged"
        : "changes";
    restore.push({ target, key, name: t.name, liveAssetId: match?.assetId ?? null, via, removeMetadataKeys, expected });
  });

  const addedAfter: AddedAfterEntry[] = [];
  if (scope === "space") {
    for (const c of live) {
      if (used.has(c.assetId)) continue;
      const key = currentKeys.get(c.assetId)!;
      const reason = skipReason(policy, c, currentById);
      if (reason) {
        skipped.push({ assetId: c.assetId, assetType: c.assetType, key, name: c.name, side: "current", reason });
        continue;
      }
      addedAfter.push({ current: c, key, action: addedAfterAction(policy, c) });
    }
  }
  return { scope, restore, addedAfter, skipped };
}

// ---------- items ----------

export type RollbackAction = "update" | "create" | "deactivate" | "delete" | "keep" | "skip";

export const ROLLBACK_ACTIONS: readonly RollbackAction[] = ["update", "create", "deactivate", "delete", "keep", "skip"];

/** One row of the rollback preview: every asset the rollback touches or leaves alone. */
export interface RollbackRow {
  assetType: string;
  key: string;
  name: string;
  /** The live asset the plan writes or leaves; null when the plan creates the asset */
  assetId: string | null;
  /** The asset ID recorded in the target (restored assets only) */
  targetAssetId: string | null;
  action: RollbackAction;
  /** For update and create rows: what the index suggests the plan check will find */
  expected: RestoreEntry["expected"] | null;
  targetVersion: number | null;
  currentVersion: number | null;
  removeMetadataKeys: string[];
  refs: Record<string, string | string[]>;
  /** Files read from the service because git doesn't hold them */
  fetchedPaths: string[];
  note: string | null;
  skipReason?: SkipReason;
}

export interface RollbackBuildInput {
  classification: RollbackClassification;
  policy: RollbackPolicy;
  targets: readonly TargetAsset[];
  current: readonly CurrentAsset[];
  /** Files of each restored target with content, by target asset ID; absent when they couldn't be read */
  targetFiles: ReadonlyMap<string, AssetFileSnapshot[]>;
  /** The current version of each asset to deactivate, with content, by asset ID */
  deactivateSnapshots: ReadonlyMap<string, AssetSnapshot>;
  /** Paths read from the service, by asset ID */
  fetchedPaths?: ReadonlyMap<string, string[]>;
}

export interface RollbackBuild {
  items: PlanItemInput[];
  deletes: { assetId: string; note?: string }[];
  rows: RollbackRow[];
  /** Errors block plan creation; warnings are shown in the preview */
  problems: ValidationResult[];
}

/** Asset types ordered so referenced types come first (stores and skills before memories and custom agents). */
export function typeOrder(policy: Pick<Policy, "assetTypes">): Map<string, number> {
  const types = policy.assetTypes.assetTypes;
  const depth = new Map<string, number>();
  const visit = (t: string, stack: Set<string>): number => {
    const known = depth.get(t);
    if (known !== undefined) return known;
    if (stack.has(t)) return 0;
    stack.add(t);
    const refs = types[t]?.references ?? [];
    const d = refs.length ? 1 + Math.max(...refs.map((r) => visit(r.assetType, stack))) : 0;
    stack.delete(t);
    depth.set(t, d);
    return d;
  };
  const names = Object.keys(types);
  for (const t of names) visit(t, new Set());
  const ordered = [...names].sort((a, b) => depth.get(a)! - depth.get(b)! || names.indexOf(a) - names.indexOf(b));
  return new Map(ordered.map((t, i) => [t, i]));
}

function joinNotes(notes: (string | null | undefined)[]): string | null {
  const parts = notes.filter((n): n is string => Boolean(n));
  return parts.length ? parts.join(" ") : null;
}

function missingContent(files: readonly AssetFileSnapshot[] | undefined): string[] | null {
  if (!files) return null;
  return files.filter((f) => f.content === undefined).map((f) => f.path);
}

function lookupSnapshot(a: { assetId: string; assetType: string; metadata: Record<string, unknown> }): AssetSnapshot {
  return { assetId: a.assetId, assetType: a.assetType, version: 0, createdAt: "", updatedAt: "", metadata: a.metadata, files: [] };
}

export function buildRollbackItems(input: RollbackBuildInput): RollbackBuild {
  const { classification: cl, policy, targets, current, targetFiles, deactivateSnapshots } = input;
  const notes = policy.releases.rollback.notes;
  const r = policy.releases.rollback;
  const fetched = input.fetchedPaths ?? new Map<string, string[]>();
  const problems: ValidationResult[] = [];
  const rows: RollbackRow[] = [];
  const items: { order: [number, string]; item: PlanItemInput }[] = [];
  const order = typeOrder(policy);
  const orderOf = (t: string) => order.get(t) ?? order.size;

  const targetById = new Map(targets.map((t) => [t.assetId, t]));
  const liveById = new Map(current.filter((c) => !c.deleted).map((c) => [c.assetId, c]));
  const restoreByTargetId = new Map(cl.restore.map((e) => [e.target.assetId, e]));

  // Snapshots for name references: every target, then index rows the targets don't cover.
  const readable = new Set<string>();
  const snapshots: AssetSnapshot[] = [];
  for (const t of targets) {
    const e = restoreByTargetId.get(t.assetId);
    const files = e ? targetFiles.get(t.assetId) : undefined;
    const missing = missingContent(files);
    if (e && files && missing && missing.length === 0) {
      readable.add(t.assetId);
      snapshots.push({ assetId: t.assetId, assetType: t.assetType, version: t.serviceVersion, createdAt: "", updatedAt: t.serviceUpdatedAt, metadata: t.metadata, files });
    } else snapshots.push(lookupSnapshot(t));
  }
  for (const c of current) if (!targetById.has(c.assetId)) snapshots.push(lookupSnapshot(c));
  const snapshotById = new Map(snapshots.map((s) => [s.assetId, s]));
  const desiredById = new Map(snapshotsToDesiredAssets(snapshots, policy).assets.map((d) => [d.assetId!, d]));

  // The same for assets to set Inactive: their current files, and the index for names.
  const deactivating = [...deactivateSnapshots.values()];
  const deactivatingIds = new Set(deactivating.map((s) => s.assetId));
  const deactivateDesired = new Map(
    snapshotsToDesiredAssets([...deactivating, ...current.filter((c) => !deactivatingIds.has(c.assetId)).map(lookupSnapshot)], policy).assets.map((d) => [d.assetId!, d]),
  );

  for (const e of cl.restore) {
    const t = e.target;
    const assetKey = `${t.assetType}:${e.key}`;
    const base: Omit<RollbackRow, "action" | "note"> = {
      assetType: t.assetType,
      key: e.key,
      name: e.name,
      assetId: e.liveAssetId,
      targetAssetId: t.assetId,
      expected: e.expected,
      targetVersion: t.serviceVersion,
      currentVersion: e.liveAssetId ? (liveById.get(e.liveAssetId)?.liveVersion ?? null) : null,
      removeMetadataKeys: e.removeMetadataKeys,
      refs: {},
      fetchedPaths: fetched.get(t.assetId) ?? [],
    };
    const desired = readable.has(t.assetId) ? desiredById.get(t.assetId) : undefined;
    if (!desired) {
      const missing = missingContent(targetFiles.get(t.assetId));
      const what = missing?.length ? `the files ${missing.join(", ")}` : "its files";
      problems.push(error("rollback.content-missing", `${e.name}: ${what} of version ${t.serviceVersion} are not in the history repository and could not be read from the service.`, { assetKey }));
      rows.push({ ...base, action: "skip", note: null });
      continue;
    }
    const out: DesiredAsset = { ...desired, metadata: { ...desired.metadata }, refs: { ...(desired.refs ?? {}) } };
    if (e.liveAssetId) out.assetId = e.liveAssetId;
    else delete out.assetId;

    // Reference IDs: point them at the live asset that the referenced target maps to.
    // An asset that will be created again has no ID yet; its name in refs is resolved at apply.
    const entry = policy.assetTypes.assetTypes[t.assetType]!;
    for (const rule of entry.references) {
      const ids = asList(t.metadata[rule.key]);
      if (!ids.length) continue;
      const names = asList(out.refs?.[rule.ref]);
      const kept: string[] = [];
      for (const id of ids) {
        const restored = restoreByTargetId.get(id);
        if (restored) {
          if (restored.liveAssetId) kept.push(restored.liveAssetId);
          continue;
        }
        if (liveById.has(id)) {
          kept.push(id);
          continue;
        }
        const known = snapshotById.get(id);
        const name = known ? computeIdentity(policy, known) : null;
        if (name && names.includes(name)) {
          problems.push(
            warning("rollback.reference-missing", `${e.name} refers to ${rule.assetType} ${name}, which no longer exists and is not part of this rollback.`, { assetKey, path: `refs.${rule.ref}` }),
          );
        } else kept.push(id);
      }
      if (rule.many) out.metadata[rule.key] = kept;
      else if (kept[0]) out.metadata[rule.key] = kept[0];
      else delete out.metadata[rule.key];
    }
    if (out.refs && !Object.keys(out.refs).length) delete out.refs;

    const fetchedPaths = fetched.get(t.assetId) ?? [];
    const note = joinNotes([
      e.via === "create" ? notes.recreated : e.via === "identity" ? notes.replaced : null,
      e.removeMetadataKeys.length ? fillTemplate(notes.removedKeys, { keys: e.removeMetadataKeys.join(", ") }) : null,
      fetchedPaths.length ? fillTemplate(notes.fetched, { paths: fetchedPaths.join(", ") }) : null,
    ]);
    const item: PlanItemInput = { desired: out, baseVersion: null, baseUpdatedAt: null };
    if (e.removeMetadataKeys.length) item.removeMetadataKeys = [...e.removeMetadataKeys];
    if (note) item.note = note;
    items.push({ order: [orderOf(t.assetType), e.key], item });
    rows.push({ ...base, refs: out.refs ?? {}, action: e.liveAssetId ? "update" : "create", note });
  }

  const deletes: RollbackBuild["deletes"] = [];
  for (const a of cl.addedAfter) {
    const c = a.current;
    const assetKey = `${c.assetType}:${a.key}`;
    const base: Omit<RollbackRow, "action" | "note"> = {
      assetType: c.assetType,
      key: a.key,
      name: c.name,
      assetId: c.assetId,
      targetAssetId: null,
      expected: null,
      targetVersion: null,
      currentVersion: c.liveVersion,
      removeMetadataKeys: [],
      refs: {},
      fetchedPaths: fetched.get(c.assetId) ?? [],
    };
    if (a.action === "keep" || a.action === "already-inactive") {
      rows.push({ ...base, action: "keep", note: a.action === "keep" ? notes.kept : notes.alreadyInactive });
      continue;
    }
    if (a.action === "delete") {
      deletes.push({ assetId: c.assetId, note: notes.deleted });
      rows.push({ ...base, action: "delete", note: notes.deleted });
      continue;
    }
    const snap = deactivateSnapshots.get(c.assetId);
    const missing = missingContent(snap?.files);
    if (!snap || !missing || missing.length) {
      problems.push(error("rollback.content-missing", `${c.name} can't be set Inactive: its current files could not be read from the history repository or the service.`, { assetKey }));
      rows.push({ ...base, action: "skip", note: null });
      continue;
    }
    const desired = deactivateDesired.get(c.assetId)!;
    const out: DesiredAsset = { ...desired, assetId: c.assetId, metadata: { ...desired.metadata, [r.statusKey]: r.inactiveValue } };
    if (out.refs && !Object.keys(out.refs).length) delete out.refs;
    items.push({
      order: [orderOf(c.assetType), a.key],
      item: { desired: out, baseVersion: snap.version, baseUpdatedAt: snap.updatedAt || c.liveUpdatedAt, note: notes.deactivated },
    });
    rows.push({ ...base, refs: out.refs ?? {}, currentVersion: snap.version, action: "deactivate", note: notes.deactivated });
  }

  for (const s of cl.skipped) {
    const note = s.reason === "managed" ? notes.managed : notes.notEditable;
    const live = s.side === "current" ? liveById.get(s.assetId) : undefined;
    const target = s.side === "target" ? targetById.get(s.assetId) : undefined;
    rows.push({
      assetType: s.assetType,
      key: s.key,
      name: s.name,
      assetId: live?.assetId ?? (target && liveById.has(target.assetId) ? target.assetId : null),
      targetAssetId: target?.assetId ?? null,
      action: "skip",
      expected: null,
      targetVersion: target?.serviceVersion ?? null,
      currentVersion: live?.liveVersion ?? null,
      removeMetadataKeys: [],
      refs: {},
      fetchedPaths: [],
      note,
      skipReason: s.reason,
    });
  }

  items.sort((a, b) => a.order[0] - b.order[0] || cmp(a.order[1], b.order[1]));
  rows.sort((a, b) => orderOf(a.assetType) - orderOf(b.assetType) || cmp(a.key, b.key) || cmp(a.action, b.action));
  return { items: items.map((i) => i.item), deletes, rows, problems };
}

/** Counts of preview rows per action. */
export function countActions(rows: readonly RollbackRow[]): Record<RollbackAction, number> {
  const out = Object.fromEntries(ROLLBACK_ACTIONS.map((a) => [a, 0])) as Record<RollbackAction, number>;
  for (const row of rows) out[row.action]++;
  return out;
}

/** `${assetType}:${key}` of a plan item, for matching validation results to rows. */
export function itemKey(item: PlanItemInput): string {
  return assetKeyOf(item.desired);
}
