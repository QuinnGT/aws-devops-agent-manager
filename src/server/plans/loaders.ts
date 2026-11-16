import { and, count, desc, eq, ilike, inArray, lt, type SQL } from "drizzle-orm";
import { db } from "@/server/db/client";
import { applyRuns, assetIndex, planItems, plans } from "@/server/db/schema";
import type { FileDiff, ValueChange } from "@/server/assets/diff";
import type { SizeMeter } from "@/server/assets/size-meter";
import { committedVersion, displayNames } from "@/server/drafts/loaders";
import { plainErrorText } from "@/server/jobs/error-text";
import { loadJobStatus } from "@/server/jobs/status";
import { assetLabel } from "@/server/history/display-name";
import { getAppPolicy } from "@/server/policy";
import { getSpaceById, type Space } from "@/server/spaces/queries";
import { mainFileOf } from "@/server/validation/asset";
import { errorsOf, warningsOf, type ValidationResult } from "@/server/validation/types";
import { applyLabel, type PlanActions, REASONS } from "./actions";
import { checkItems, type LiveReader, summarize, validationFailedCount } from "./check";
import type { PlanOrigin } from "./contract";
import { loadLiveIndex, policyForSpace } from "./runtime";
import { actionsFor } from "./service";
import { type Badge, ITEM_PROGRESS_LABELS, itemChangeBadge, OPEN_STATES, PLAN_STATE_BADGES, versionLabel } from "./states";
import { dbPlanStore } from "./store";
import type { ApplyRunRow, ItemConflict, ItemProgress, PlanActor, PlanItemRow, PlanRow, PlanState, PlanSummary, WriteStep } from "./types";
import { type ApplyJobView, loadApplyJob, settleGaveUpPlans, settleIfApplyGaveUp } from "./stuck";
import { originLine, type OriginLookups } from "./view";
import { describeStepsPlain } from "./write-plan";

/**
 * Page loaders: the plan list (/spaces/[alias]/plans) and the
 * plan review (/spaces/[alias]/plans/[planId], plan-review.md). The page
 * checks the viewer's access with the DAL first and passes the viewer's
 * permissions in the space. Times are Date objects; the page renders them
 * with the shared Time component.
 */

export type PlanViewer = PlanActor;

export interface PlanListRow {
  id: string;
  title: string;
  state: PlanState;
  badge: Badge;
  originKind: PlanRow["originKind"];
  originLabel: string;
  /** The origin line of the table (pages/plans.md), for example "From 4 drafts" */
  originLine: string;
  items: number;
  /** Items apply will write, from the last check (or from the last sync, see writesSynced) */
  writes: number | null;
  /** The check failed, so `writes` compares with the last synced version, as the plan page does */
  writesSynced: boolean;
  /** The last live-space check failed (the badge says "Check failed") */
  checkFailed: boolean;
  /** The last check found a validation error (the badge says "Validation failed") */
  validationFailed: boolean;
  author: string;
  authorName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * What to do about a validation error, by where the plan came from. Only a
 * plan made from drafts has a draft to fix; the others are fixed at the source
 * and made again.
 */
export function validationFixText(origin: PlanOrigin["kind"], hasDraft: boolean): string {
  if (hasDraft) return "Fix the draft, then re-check.";
  if (origin === "package") return "This plan can't be applied while an item fails validation. Fix the package and import it again, then discard this plan.";
  if (origin === "revision") return "This plan can't be applied while an item fails validation. Fix the revision, then discard this plan and create a new one from the revision.";
  return "This plan can't be applied while an item fails validation. Discard it and create it again once the cause is fixed.";
}

export function originLabel(origin: PlanOrigin): string {
  switch (origin.kind) {
    case "drafts":
      return `${origin.draftIds.length} ${origin.draftIds.length === 1 ? "draft" : "drafts"}`;
    case "rollback":
      return origin.target.kind === "release" ? `Restore to release ${origin.target.name}` : origin.target.kind === "commit" ? `Restore to commit ${origin.target.commit.slice(0, 7)}` : `Restore to v${origin.target.version}`;
    case "package":
      return `Package ${origin.fileName}`;
    case "revision":
      return `Revision ${origin.name}`;
    case "retry":
      return "Retry of failed items";
  }
}

export interface PlanListOptions {
  states?: readonly PlanState[];
  /** Only plans with these origin kinds */
  originKinds?: readonly PlanRow["originKind"][];
  /** Case-insensitive part of the title */
  q?: string | null;
  limit?: number;
  before?: Date;
  /** "created" (default) or "updated": newest first either way */
  orderBy?: "created" | "updated";
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function listWhere(spaceId: string, opts: Pick<PlanListOptions, "states" | "originKinds" | "q">): SQL[] {
  const where: SQL[] = [eq(plans.spaceId, spaceId)];
  if (opts.states?.length) where.push(inArray(plans.state, [...opts.states]));
  if (opts.originKinds?.length) where.push(inArray(plans.originKind, [...opts.originKinds]));
  const q = opts.q?.trim();
  if (q) where.push(ilike(plans.title, likePattern(q)));
  return where;
}

/** Asset names and plan titles the origin lines of these plans need. */
async function originLookupsFor(spaceId: string, origins: readonly PlanOrigin[]): Promise<(o: PlanOrigin) => OriginLookups> {
  const assetIds = [...new Set(origins.flatMap((o) => (o.kind === "rollback" && o.target.kind === "version" ? [o.target.assetId] : [])))];
  const planIds = [...new Set(origins.flatMap((o) => (o.kind === "retry" ? [o.planId] : [])))].filter((id) => UUID_RE.test(id));
  const [assets, retried] = await Promise.all([
    assetIds.length
      ? db().select({ assetId: assetIndex.assetId, assetType: assetIndex.assetType, name: assetIndex.name }).from(assetIndex).where(and(eq(assetIndex.spaceId, spaceId), inArray(assetIndex.assetId, assetIds)))
      : Promise.resolve([]),
    planIds.length ? db().select({ id: plans.id, title: plans.title }).from(plans).where(inArray(plans.id, planIds)) : Promise.resolve([]),
  ]);
  return (o) => ({
    assetName: (() => {
      if (o.kind !== "rollback" || o.target.kind !== "version") return null;
      const target = o.target;
      const a = assets.find((x) => x.assetId === target.assetId);
      return a ? assetLabel(getAppPolicy().policy, a) : null;
    })(),
    retryOfTitle: o.kind === "retry" ? (retried.find((p) => p.id === o.planId)?.title ?? null) : null,
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Plans of a space, newest first. `before` pages back by creation time. */
export async function loadPlanList(spaceId: string, opts: PlanListOptions = {}): Promise<PlanListRow[]> {
  const query = () => {
    const where = listWhere(spaceId, opts);
    if (opts.before) where.push(lt(opts.orderBy === "updated" ? plans.updatedAt : plans.createdAt, opts.before));
    return db()
      .select()
      .from(plans)
      .where(and(...where))
      .orderBy(desc(opts.orderBy === "updated" ? plans.updatedAt : plans.createdAt), desc(plans.createdAt))
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 500));
  };
  let rows = await query();
  // A plan whose apply job gave up would show "Applying" forever; settle it first.
  if ((await settleGaveUpPlans(rows)).length) rows = await query();
  const counts = rows.length
    ? await db()
        .select({ planId: planItems.planId, n: count() })
        .from(planItems)
        .where(inArray(planItems.planId, rows.map((r) => r.id)))
        .groupBy(planItems.planId)
    : [];
  const [lookups, nameOf] = await Promise.all([originLookupsFor(spaceId, rows.map((r) => r.origin)), displayNames(rows.filter((r) => !r.createdByName).map((r) => r.createdBy))]);
  // An open plan whose check failed before comparing anything counts its changes against the last sync, as its page does.
  const needsSynced = rows.filter((p) => p.checkError && !p.summary && OPEN_STATES.includes(p.state));
  const space = needsSynced.length ? await getSpaceById(spaceId) : null;
  const syncedWrites = new Map<string, number>();
  for (const p of space ? needsSynced : []) {
    const items = await dbPlanStore.getItems(p.id);
    const c = await syncedComparison(space!, items);
    if (c.items.size) syncedWrites.set(p.id, summarize(withSynced(items, c.items), c.planValidation).writes);
  }
  return rows.map((p) => ({
    id: p.id,
    title: p.title,
    state: p.state,
    badge: PLAN_STATE_BADGES[p.state],
    originKind: p.originKind,
    originLabel: originLabel(p.origin),
    originLine: originLine(p.origin, lookups(p.origin)),
    items: counts.find((c) => c.planId === p.id)?.n ?? 0,
    writes: (p.summary as PlanSummary | null)?.writes ?? syncedWrites.get(p.id) ?? null,
    writesSynced: syncedWrites.has(p.id),
    checkFailed: Boolean(p.checkError),
    validationFailed: validationFailedCount(p.summary as PlanSummary | null) > 0,
    author: p.createdBy,
    authorName: p.createdByName ?? nameOf(p.createdBy),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
}

/** How many plans of the space match the filters (for the "Plans" tab and "Show <N> closed plans"). */
export async function countPlans(spaceId: string, opts: Pick<PlanListOptions, "states" | "originKinds" | "q"> = {}): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(plans)
    .where(and(...listWhere(spaceId, opts)));
  return row?.n ?? 0;
}

export interface PlanItemView {
  id: string;
  name: string;
  assetType: string;
  typeLabel: string;
  /** The memory store of a memory, from the item's name references ("Memory in verity") */
  parentName: string | null;
  assetId: string | null;
  kind: PlanItemRow["kind"];
  change: PlanItemRow["change"];
  changeBadge: Badge;
  /** "v5 → v6", "v1, status only", "planned v1, live v2" */
  versionLabel: string;
  validation: { status: PlanItemRow["validationStatus"]; errors: number; warnings: number };
  progress: ItemProgress | null;
  progressLabel: string | null;
  progressMessage: string | null;
  conflict: ItemConflict | null;
  note: string | null;
  draftId: string | null;
  selected: boolean;
}

export interface SelectedItemView {
  id: string;
  name: string;
  /** The asset's main file, for the card header "<name> · <main file>" */
  mainFile: string | null;
  added: number;
  removed: number;
  contentDiff: FileDiff[];
  metadataDiff: ValueChange[];
  /** Instructions only: the size after the change */
  sizeMeter: SizeMeter | null;
  validation: ValidationResult[];
  /** What apply will do, in plain words ("Apply will replace AGENTS.md."); null before the check or for no write */
  writes: string | null;
  conflict: ItemConflict | null;
  note: string | null;
  /** The live-space check has compared this item; before that the diff is empty, not "no change" */
  checked: boolean;
  /** "synced": the check couldn't read live, so the diff compares with the last synced version */
  comparedWith: "live" | "synced";
}

export type PlanCallout =
  | {
      kind: "conflict";
      tone: "warning";
      title: string;
      items: { planItemId: string; name: string; fromVersion: number | null; toVersion: number | null; at: Date | null; source: string | null; message: string }[];
      body: string;
      action: { label: "Re-check live space"; action: "recheck"; enabled: boolean; disabledReason: string | null } | null;
    }
  | { kind: "validation"; tone: "destructive"; title: string; body: string; action: { label: "Open draft"; draftId: string } | null; planErrors: ValidationResult[] }
  | { kind: "check-failed"; tone: "destructive"; title: string; body: string; action: { label: "Re-check live space"; action: "recheck"; enabled: boolean; disabledReason: string | null } | null }
  | { kind: "applied"; tone: "success"; title: string; body: string; commit: string | null; release: string | null; action: { label: "View in History" } }
  | {
      kind: "apply-failed";
      tone: "destructive";
      title: string;
      body: string;
      items: { planItemId: string; name: string; message: string | null }[];
      action: { label: "Create a plan for the failed items"; action: "retry-failed"; enabled: boolean; disabledReason: string | null } | null;
    };

export interface PlanReview {
  plan: {
    id: string;
    title: string;
    state: PlanState;
    badge: Badge;
    origin: PlanOrigin;
    originLabel: string;
    /** The origin line (pages/plans.md), for example "Retry of Shorter verity guidance" */
    originLine: string;
    /** The plan a retry plan came from */
    retryOf: { id: string; title: string } | null;
    author: string;
    authorName: string | null;
    /** Drafts the plan came from (meta line "from <N> drafts") */
    draftCount: number;
    createdAt: Date;
    checkedAt: Date | null;
    checkError: string | null;
    /** The last check failed, recorded on the plan or as a failed check job */
    checkFailed: boolean;
    /** The plan has a validation error, so Apply stays off (the badge says "Validation failed") */
    validationFailed: boolean;
    /** "synced" when the check failed and the counts and diffs compare with the last synced version */
    comparedWith: "live" | "synced" | null;
    reason: string | null;
    /** Plan-level notes from the caller (things that are not items, such as assets kept as they are) */
    notes: string[];
    /** Final history commit of the apply (HEAD after recording), for "Create release" */
    resultCommit: string | null;
  };
  space: { id: string; alias: string; name: string; approvalRequired: boolean; changeReasonRequired: boolean; deletesEnabled: boolean };
  callouts: PlanCallout[];
  tiles: {
    contentUpdates: number;
    statusChanges: number;
    metadataUpdates: number;
    skipped: number;
    /** Shown only when above zero */
    creates: number | null;
    deletes: number | null;
    validation: { passed: boolean; failed: number; checks: number; warnings: number };
  };
  items: PlanItemView[];
  selected: SelectedItemView | null;
  approval: {
    reasonRequired: boolean;
    reason: string | null;
    approvalRequired: boolean;
    canApprove: string;
    requested: { by: string; at: Date } | null;
    approved: { by: string; name: string | null; at: Date } | null;
    rejected: { by: string; at: Date; note: string | null } | null;
  };
  actions: PlanActions;
  /** The apply confirmation dialog */
  confirm: { title: string; counts: { label: string; n: number }[]; skippedNames: string[]; reason: string | null; button: string };
  jobs: {
    checkRunId: string | null;
    applyRunId: string | null;
    showProgress: boolean;
    /** The check job while the plan is checking: waiting for a worker, or failed before it could record a result */
    check: { status: string; waitingForWorker: boolean; error: string | null } | null;
  };
  /** The apply job's state while the plan is applying (or after it gave up), from job_runs */
  applyJob: ApplyJobView | null;
  lastApply: Pick<ApplyRunRow, "id" | "status" | "counts" | "commits" | "finalCommit" | "pushed" | "pushError" | "error" | "startedAt" | "finishedAt"> | null;
  /** "What apply does", always shown */
  whatApplyDoes: string[];
}

export const WHAT_APPLY_DOES = [
  "Re-reads each asset and skips any that changed since this check.",
  "Each change is sent once, even if apply is retried.",
  "Reads every asset back and checks it matches the plan.",
  "Saves the result in the history repository with your reason.",
] as const;

/** The Apply button's reason while the check job has not been picked up by a worker. */
export const CHECK_NOT_STARTED = "The live-space check hasn't started yet.";

function typeLabel(assetType: string): string {
  return getAppPolicy().policy.assetTypes.assetTypes[assetType]?.label ?? assetType;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What the UI calls a plan item's asset ("Global instructions" for GENERIC). */
function itemLabel(i: Pick<PlanItemRow, "assetType" | "name" | "assetId" | "desired">): string {
  return assetLabel(getAppPolicy().policy, { assetType: i.assetType, name: i.name, assetId: i.assetId, metadata: i.desired?.metadata });
}

function parentNameOf(i: Pick<PlanItemRow, "assetType" | "desired">): string | null {
  const single = getAppPolicy().policy.assetTypes.assetTypes[i.assetType]?.references.find((r) => !r.many);
  const v = single ? i.desired?.refs?.[single.ref] : undefined;
  return typeof v === "string" && v ? v : null;
}

/** "v2 → v3, same content as v1": a version restore writes a new version, so say where its content comes from. */
export function restoredFrom(origin: PlanOrigin, i: Pick<PlanItemRow, "assetId" | "change">): string {
  const t = origin.kind === "rollback" ? origin.target : null;
  return t?.kind === "version" && t.assetId === i.assetId && i.change === "content" ? `, same content as v${t.version}` : "";
}

function itemView(i: PlanItemRow, selectedId: string | null, origin: PlanOrigin): PlanItemView {
  const validation = (i.validation ?? []) as ValidationResult[];
  const conflict = (i.conflict ?? null) as ItemConflict | null;
  return {
    id: i.id,
    name: itemLabel(i),
    assetType: i.assetType,
    typeLabel: typeLabel(i.assetType),
    parentName: parentNameOf(i),
    assetId: i.assetId,
    kind: i.kind,
    change: i.change,
    changeBadge: itemChangeBadge(i.change, { skipped: Boolean(conflict), status: i.desired?.metadata.status }),
    versionLabel: versionLabel({ change: i.change, liveVersion: i.liveVersion, baseVersion: i.baseVersion, conflict, writtenVersion: i.writtenVersion }) + (conflict ? "" : restoredFrom(origin, i)),
    validation: { status: i.validationStatus, errors: errorsOf(validation).length, warnings: warningsOf(validation).length },
    progress: i.progress,
    progressLabel: i.progress ? ITEM_PROGRESS_LABELS[i.progress] : null,
    progressMessage: i.progressMessage,
    conflict,
    note: i.note,
    draftId: i.draftId,
    selected: i.id === selectedId,
  };
}

function selectedView(i: PlanItemRow, synced: boolean): SelectedItemView {
  const entry = getAppPolicy().policy.assetTypes.assetTypes[i.assetType];
  return {
    id: i.id,
    name: itemLabel(i),
    mainFile: entry && i.desired ? (mainFileOf(entry, i.desired.files)?.path ?? null) : null,
    added: i.addedLines,
    removed: i.removedLines,
    contentDiff: (i.contentDiff ?? []) as FileDiff[],
    metadataDiff: (i.metadataDiff ?? []) as ValueChange[],
    sizeMeter: (i.sizeMeter ?? null) as SizeMeter | null,
    validation: (i.validation ?? []) as ValidationResult[],
    writes: i.change === null || synced ? null : describeStepsPlain((i.writeSteps ?? []) as WriteStep[]),
    conflict: (i.conflict ?? null) as ItemConflict | null,
    note: i.note,
    checked: i.change !== null,
    comparedWith: synced ? "synced" : "live",
  };
}

/** What the comparison with the last synced version fills in on an item the failed check never compared. */
export type SyncedItem = Pick<PlanItemRow, "change" | "liveVersion" | "metadataDiff" | "contentDiff" | "addedLines" | "removedLines" | "sizeMeter" | "validation" | "validationStatus">;

export interface SyncedComparison {
  items: Map<string, SyncedItem>;
  /** Plan-level results of the set rules (names, references, counts) */
  planValidation: ValidationResult[];
}

/**
 * After a failed check: run the check's own comparison and validation
 * (checkItems) on each uncompared item against its last synced (committed)
 * version, the way the draft editor falls back, so the page can show counts,
 * a diff and validation labeled as such. The set rules use the last synced
 * index (asset_index), as a passing check does. Writes nothing; apply still
 * needs a check that passes, which alone decides what apply will skip.
 * Items without a synced version are left out.
 */
export async function syncedComparison(space: Space, items: readonly PlanItemRow[]): Promise<SyncedComparison> {
  const policy = await policyForSpace(space);
  const liveIndex = await loadLiveIndex(space.id);
  const committed = new Map<string, Awaited<ReturnType<typeof committedVersion>>>();
  const read = async (assetId: string) => {
    if (!committed.has(assetId)) committed.set(assetId, await committedVersion(space, policy, assetId).catch(() => null));
    return committed.get(assetId) ?? null;
  };
  const reader: LiveReader = {
    async getAsset(assetId) {
      const c = await read(assetId);
      const assetType = liveIndex.find((a) => a.assetId === assetId)?.assetType ?? "";
      return c ? { assetId, assetType, metadata: c.metadata, version: c.version, createdAt: c.updatedAt, updatedAt: c.updatedAt } : null;
    },
    async snapshot(asset) {
      const c = (await read(asset.assetId))!;
      const at = c.updatedAt.toISOString();
      const files = c.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size, encoding: f.encoding, ...(f.content !== null ? { content: f.content } : {}) }));
      return { assetId: asset.assetId, assetType: asset.assetType, version: c.version, createdAt: at, updatedAt: at, metadata: c.metadata, files };
    },
  };
  const open = items.filter((it) => it.change === null && !(it.kind === "upsert" && !it.desired));
  const { patches, planValidation } = await checkItems({ id: "" }, open, { rebase: true }, { policy, settings: space.parsedSettings, liveIndex, reader });
  const out = new Map<string, SyncedItem>();
  for (const it of open) {
    const assetId = it.assetId ?? it.desired?.assetId ?? null;
    if (assetId && !committed.get(assetId)) continue;
    const r = patches.get(it.id)!;
    out.set(it.id, {
      change: r.change ?? null,
      liveVersion: r.liveVersion ?? null,
      metadataDiff: r.metadataDiff ?? [],
      contentDiff: r.contentDiff ?? [],
      addedLines: r.addedLines ?? 0,
      removedLines: r.removedLines ?? 0,
      sizeMeter: r.sizeMeter ?? null,
      validation: r.validation ?? [],
      validationStatus: r.validationStatus ?? null,
    });
  }
  return { items: out, planValidation };
}

/** Items as the pages show them after a failed check: uncompared items take the synced comparison, without conflicts. */
function withSynced(items: readonly PlanItemRow[], synced: ReadonlyMap<string, SyncedItem>): PlanItemRow[] {
  return items.map((i) => (synced.has(i.id) ? { ...i, ...synced.get(i.id)!, conflict: null } : i));
}

/** Pure part of the review: everything from the rows, for unit tests and the loader. */
export function buildPlanReview(input: {
  plan: PlanRow;
  items: PlanItemRow[];
  space: Pick<Space, "id" | "alias" | "displayName" | "parsedSettings">;
  viewer: PlanViewer;
  lastApply: ApplyRunRow | null;
  selectedItemId?: string | null;
  lookups?: OriginLookups;
  retryOf?: { id: string; title: string } | null;
  applyJob?: ApplyJobView | null;
  /** The check job's state while the plan is checking */
  checkJob?: { status: string; waitingForWorker: boolean; error: string | null } | null;
  /** The author's display name when the plan didn't store one */
  authorName?: string | null;
  /** After a failed check: items compared with their last synced version (syncedComparison) */
  synced?: ReadonlyMap<string, SyncedItem> | null;
  /** The plan-level results of that comparison */
  syncedPlanValidation?: readonly ValidationResult[];
}): PlanReview {
  const { plan, viewer } = input;
  const synced = input.synced?.size ? input.synced : null;
  // The rows the page shows: uncompared items take the synced comparison and its validation, without conflicts.
  const items = synced ? withSynced(input.items, synced) : input.items;
  const space = input.space;
  const summary = plan.summary as PlanSummary | null;
  const planValidation = ((summary ? plan.validation : synced ? input.syncedPlanValidation : null) ?? []) as ValidationResult[];
  const shownSummary = summary ?? (synced ? summarize(items, planValidation) : null);
  const settings = space.parsedSettings;
  const checkJob = plan.state === "checking" ? (input.checkJob ?? null) : null;
  const actions = actionsFor(plan, input.items, space, viewer);
  if (synced && summary === null && actions.primary?.action === "apply") actions.primary = { ...actions.primary, label: applyLabel(shownSummary?.writes ?? 0) };
  // "Still running" would not be true while no worker has picked the check up.
  if (checkJob?.waitingForWorker && actions.primary?.disabledReason === REASONS.checking) actions.primary = { ...actions.primary, disabledReason: CHECK_NOT_STARTED };
  const selectedId =
    (input.selectedItemId && items.some((i) => i.id === input.selectedItemId) ? input.selectedItemId : null) ??
    items.find((i) => i.change && i.change !== "none")?.id ??
    items[0]?.id ??
    null;

  const callouts: PlanCallout[] = [];
  const conflicted = items.filter((i) => i.conflict && i.progress !== "done");
  const recheckAction = actions.recheck ? { label: "Re-check live space" as const, action: "recheck" as const, enabled: actions.recheck.enabled, disabledReason: actions.recheck.disabledReason } : null;
  if (conflicted.length && plan.state !== "discarded") {
    callouts.push({
      kind: "conflict",
      tone: "warning",
      title: `${plural(conflicted.length, "asset", "assets")} changed after this plan was made`,
      body: "Apply will skip them. Re-check to plan them again against the new version.",
      items: conflicted.map((i) => {
        const c = i.conflict as ItemConflict;
        return { planItemId: i.id, name: itemLabel(i), fromVersion: c.baseVersion ?? null, toVersion: c.liveVersion ?? null, at: c.liveUpdatedAt ? new Date(c.liveUpdatedAt) : null, source: c.source ?? null, message: c.message };
      }),
      action: recheckAction,
    });
  }
  if (plan.checkError && plan.state !== "checking") {
    callouts.push({ kind: "check-failed", tone: "destructive", title: "The live-space check failed", body: plainErrorText(plan.checkError) ?? plan.checkError, action: recheckAction });
  } else if (checkJob?.status === "failed") {
    callouts.push({ kind: "check-failed", tone: "destructive", title: "The live-space check failed", body: checkJob.error ?? "The check stopped without an error message.", action: null });
  }
  const failedValidation = validationFailedCount(shownSummary);
  if (failedValidation > 0 && plan.state !== "applied" && plan.state !== "discarded") {
    const firstDraft = items.find((i) => i.validationStatus === "failed" && i.draftId)?.draftId ?? null;
    callouts.push({
      kind: "validation",
      tone: "destructive",
      title: `Validation failed for ${plural(failedValidation, "asset", "assets")}`,
      body: validationFixText(plan.origin.kind, firstDraft !== null),
      action: firstDraft ? { label: "Open draft", draftId: firstDraft } : null,
      planErrors: errorsOf(planValidation),
    });
  }
  const written = items.filter((i) => i.progress === "done" && i.change !== "none").length;
  if (plan.state === "applied") {
    callouts.push({
      kind: "applied",
      tone: "success",
      title: `Applied ${plural(written, "change", "changes")}`,
      body: plan.resultCommit ? `Commit ${plan.resultCommit.slice(0, 7)}` : "No commit was needed.",
      commit: plan.resultCommit,
      release: null,
      action: { label: "View in History" },
    });
  }
  if (plan.state === "failed") {
    const failed = items.filter((i) => i.progress === "failed");
    callouts.push({
      kind: "apply-failed",
      tone: "destructive",
      title: `${plural(failed.length, "change", "changes")} failed`,
      body: "Items already written stay written.",
      items: failed.map((i) => ({ planItemId: i.id, name: itemLabel(i), message: plainErrorText(i.progressMessage) })),
      action: actions.retryFailed ? { label: "Create a plan for the failed items", action: "retry-failed", enabled: actions.retryFailed.enabled, disabledReason: actions.retryFailed.disabledReason } : null,
    });
  }

  const writes = summary?.writes ?? 0;
  const counts = [
    { label: "Creates", n: summary?.creates ?? 0 },
    { label: "Content updates", n: summary?.contentUpdates ?? 0 },
    { label: "Metadata updates", n: summary?.metadataUpdates ?? 0 },
    { label: "Status changes", n: summary?.statusChanges ?? 0 },
    { label: "Deletes", n: summary?.deletes ?? 0 },
  ].filter((c) => c.n > 0);

  return {
    plan: {
      id: plan.id,
      title: plan.title,
      state: plan.state,
      badge: PLAN_STATE_BADGES[plan.state],
      origin: plan.origin,
      originLabel: originLabel(plan.origin),
      originLine: originLine(plan.origin, input.lookups ?? {}),
      retryOf: input.retryOf ?? null,
      author: plan.createdBy,
      authorName: plan.createdByName ?? input.authorName ?? null,
      draftCount: plan.origin.kind === "drafts" ? plan.origin.draftIds.length : 0,
      createdAt: plan.createdAt,
      checkedAt: plan.checkedAt,
      checkError: plan.checkError,
      checkFailed: Boolean(plan.checkError) || checkJob?.status === "failed",
      validationFailed: validationFailedCount(shownSummary) > 0,
      comparedWith: synced ? "synced" : plan.checkedAt && !plan.checkError ? "live" : null,
      reason: plan.reason,
      notes: plan.notes ?? [],
      resultCommit: plan.resultCommit,
    },
    space: {
      id: space.id,
      alias: space.alias,
      name: space.displayName ?? space.alias,
      approvalRequired: settings.approvalRequired,
      changeReasonRequired: settings.changeReasonRequired,
      deletesEnabled: settings.deletesEnabled,
    },
    callouts,
    tiles: {
      contentUpdates: shownSummary?.contentUpdates ?? 0,
      statusChanges: shownSummary?.statusChanges ?? 0,
      metadataUpdates: shownSummary?.metadataUpdates ?? 0,
      skipped: summary?.skipped ?? 0,
      creates: shownSummary?.creates ? shownSummary.creates : null,
      deletes: shownSummary?.deletes ? shownSummary.deletes : null,
      validation: { passed: failedValidation === 0, failed: failedValidation, checks: shownSummary?.validation.checkedAssets ?? 0, warnings: shownSummary?.validation.warnings ?? 0 },
    },
    items: items.map((i) => itemView(i, selectedId, plan.origin)),
    selected: (() => {
      const s = items.find((i) => i.id === selectedId);
      return s ? selectedView(s, Boolean(synced?.has(s.id))) : null;
    })(),
    approval: {
      reasonRequired: settings.changeReasonRequired,
      reason: plan.reason,
      approvalRequired: settings.approvalRequired,
      canApprove: "Publishers and Admins, except the plan's author",
      requested: plan.approvalRequestedAt && plan.approvalRequestedBy ? { by: plan.approvalRequestedBy, at: plan.approvalRequestedAt } : null,
      approved: plan.approvedAt && plan.approvedBy ? { by: plan.approvedBy, name: plan.approvedByName, at: plan.approvedAt } : null,
      rejected: plan.rejectedAt && plan.rejectedBy ? { by: plan.rejectedBy, at: plan.rejectedAt, note: plan.rejectNote } : null,
    },
    actions,
    confirm: {
      title: `${applyLabel(writes)} to ${space.displayName ?? space.alias}?`,
      counts,
      skippedNames: items.filter((i) => i.conflict).map(itemLabel),
      reason: plan.reason,
      button: applyLabel(writes),
    },
    jobs: { checkRunId: plan.checkRunId, applyRunId: plan.applyRunId, showProgress: plan.state === "applying" || items.some((i) => i.progress !== null), check: checkJob },
    applyJob: input.applyJob ?? null,
    lastApply: input.lastApply
      ? {
          id: input.lastApply.id,
          status: input.lastApply.status,
          counts: input.lastApply.counts,
          commits: input.lastApply.commits,
          finalCommit: input.lastApply.finalCommit,
          pushed: input.lastApply.pushed,
          pushError: input.lastApply.pushError,
          error: input.lastApply.error,
          startedAt: input.lastApply.startedAt,
          finishedAt: input.lastApply.finishedAt,
        }
      : null,
    whatApplyDoes: [...WHAT_APPLY_DOES],
  };
}

/** Everything the plan review page shows. Null when the plan is not in this space. */
export async function loadPlanReview(spaceId: string, planId: string, viewer: PlanViewer, opts: { selectedItemId?: string | null } = {}): Promise<PlanReview | null> {
  let plan = await dbPlanStore.getPlan(planId);
  if (!plan || plan.spaceId !== spaceId) return null;
  const space = await getSpaceById(spaceId);
  if (!space) return null;
  // A plan whose apply job gave up would show "Applying" forever; settle it first.
  if (await settleIfApplyGaveUp(plan)) plan = (await dbPlanStore.getPlan(planId)) ?? plan;
  const [items, [lastApply], lookups, applyJob, checkJob, nameOf] = await Promise.all([
    dbPlanStore.getItems(planId),
    db().select().from(applyRuns).where(eq(applyRuns.planId, planId)).orderBy(desc(applyRuns.startedAt)).limit(1),
    originLookupsFor(spaceId, [plan.origin]),
    plan.state === "applying" || plan.state === "failed" ? loadApplyJob(plan.applyRunId) : Promise.resolve(null),
    plan.state === "checking" ? loadJobStatus(plan.checkRunId) : Promise.resolve(null),
    plan.createdByName ? Promise.resolve(null) : displayNames([plan.createdBy]),
  ]);
  const origin = plan.origin;
  const checkFailed = Boolean(plan.checkError) || (plan.state === "checking" && checkJob?.status === "failed");
  const synced = checkFailed && items.some((i) => i.change === null) ? await syncedComparison(space, items) : null;
  const retryOf = origin.kind === "retry" && lookups(origin).retryOfTitle ? { id: origin.planId, title: lookups(origin).retryOfTitle! } : null;
  return buildPlanReview({
    plan,
    items,
    space,
    viewer,
    lastApply: lastApply ?? null,
    selectedItemId: opts.selectedItemId,
    lookups: lookups(origin),
    retryOf,
    applyJob: applyJob ? { runId: applyJob.runId, status: applyJob.status, progress: applyJob.progress, message: applyJob.message, error: plainErrorText(applyJob.error), finishedAt: applyJob.finishedAt } : null,
    checkJob: checkJob ? { status: checkJob.status, waitingForWorker: checkJob.waitingForWorker, error: checkJob.error } : null,
    authorName: nameOf ? nameOf(plan.createdBy) : null,
    synced: synced?.items ?? null,
    syncedPlanValidation: synced?.planValidation,
  });
}
