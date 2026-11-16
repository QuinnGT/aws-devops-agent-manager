import { and, asc, count, desc, eq, inArray, lt, type SQL } from "drizzle-orm";
import { normalizeBundle } from "@/server/analyzers/normalize";
import { getAnalyzer } from "@/server/analyzers/registry";
import { latestRunsForTask, loadJournalBundle } from "@/server/analyzers/store";
import { db } from "@/server/db/client";
import { auditItems, audits, findings, journalTasks, reviews } from "@/server/db/schema";
import { loadJobStatus, type JobStatusView } from "@/server/jobs/status";
import type { AuditProfile } from "@/server/policy/sections/audits";
import type { SpaceRow } from "@/server/spaces/queries";
import { auditActions, findingActions, itemActions, type AuditActions, type AuditViewer, type FindingActions, type ItemActions } from "./actions";
import { citationProblemCounts, hasOpenProblem } from "./citation-state";
import { OPEN_CITATION_PROBLEM } from "./finding-review";
import type { Citation, CitationCheck } from "./contract";
import { enumOf, propertySchemas } from "./edits";
import { loadedPolicyForSpace, profileLabel, readOutputSchema } from "./profiles";
import { summarizeReadiness, type ItemReadiness, type ReadinessSummary } from "./readiness";
import { AUDIT_STATE_LABELS, FINDING_STATE_LABELS, ITEM_STATE_LABELS, isItemFinished, type AuditItemState, type AuditState, type FindingState, type ReviewState } from "./states";
import { currentEvidenceDocs, getAudit, isUuid, listAuditItems, profileOf, readinessOf, type AuditItemRow, type AuditRow, type FindingRow, type ReviewRow } from "./store";

/**
 * Page loaders for the audit screens: the audits list, an audit,
 * one item, and the findings queue. Read-only. The page checks `audits.read`
 * with the DAL first, passes the space row it authorized and the viewer's
 * permissions in that space. Times are Date objects.
 *
 * Everything shown from a review, a journal or a ground-truth document is
 * untrusted text: render markdown only with SafeMarkdown.
 */

export type { AuditViewer };

type Json = Record<string, unknown>;

export interface FindingCounts {
  proposed: number;
  accepted: number;
  rejected: number;
  total: number;
}

const emptyCounts = (): FindingCounts => ({ proposed: 0, accepted: 0, rejected: 0, total: 0 });

function addCount(c: FindingCounts, state: FindingState, n = 1): void {
  c[state] += n;
  c.total += n;
}

/** "primary_failure_mode" -> "Primary failure mode" */
export function humanize(key: string): string {
  const s = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return s ? s[0]!.toUpperCase() + s.slice(1) : key;
}

/** Readable label of a value: a failure mode, fix owner or cohort of the profile, else the value as text. */
export function valueLabel(profile: Pick<AuditProfile, "failureModes" | "fixOwners" | "cohorts">, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") return Array.isArray(value) ? value.map((v) => valueLabel(profile, v)).join(", ") : String(value);
  return profile.failureModes.find((m) => m.id === value)?.label ?? profile.fixOwners.find((o) => o.id === value)?.label ?? profile.cohorts.find((c) => c.id === value)?.label ?? value;
}

type LabelProfile = Pick<AuditProfile, "failureModes" | "fixOwners" | "cohorts" | "findings">;

/** The label of a finding field: the extractor's fieldLabels (any extractor when `kind` is null), else the key in words. */
export function fieldLabel(profile: Pick<AuditProfile, "findings">, field: string, kind?: string | null): string {
  const exs = kind ? profile.findings.filter((x) => x.kind === kind) : profile.findings;
  for (const ex of exs) {
    const l = ex.fieldLabels?.[field];
    if (l) return l;
  }
  return humanize(field);
}

/** The label of a field's value: the extractor's valueLabels for that field, else valueLabel(). */
export function fieldValueLabel(profile: LabelProfile, field: string, value: unknown, kind?: string | null): string {
  if (Array.isArray(value)) return value.map((v) => fieldValueLabel(profile, field, v, kind)).join(", ");
  if (typeof value === "string") {
    const exs = kind ? profile.findings.filter((x) => x.kind === kind) : profile.findings;
    for (const ex of exs) {
      const l = ex.valueLabels?.[field]?.[value];
      if (l) return l;
    }
  }
  return valueLabel(profile, value);
}

/** Where a journal record is shown: the investigation page, on the record's page, at its anchor. */
export function recordHref(alias: string, taskId: string, recordId: string, position: number | null, pageSize: number): string {
  const page = position === null ? 1 : Math.floor(position / pageSize) + 1;
  const base = `/spaces/${encodeURIComponent(alias)}/journals/investigations/${encodeURIComponent(taskId)}`;
  return `${base}${page > 1 ? `?page=${page}` : ""}#rec-${encodeURIComponent(recordId)}`;
}

function profileColumns(profile: AuditProfile): { key: string; label: string; kind: string; field: string }[] {
  return profile.inputs.flatMap((i) =>
    Object.entries(i.fields)
      .filter(([, f]) => f.column)
      .map(([name, f]) => ({ key: `${i.kind}.${name}`, label: f.label, kind: i.kind, field: name })),
  );
}

function primaryExtractor(profile: AuditProfile) {
  return profile.findings.find((f) => f.summaryField) ?? null;
}

// ---------------------------------------------------------------- list

export interface AuditListRow {
  id: string;
  name: string;
  profileId: string;
  profileLabel: string;
  state: AuditState;
  stateLabel: string;
  items: number;
  /** Findings of the items' current reviews */
  findings: FindingCounts;
  /** Items by state, for the state words ("Reviews failed", "Ready to finalize") */
  itemStates: Record<AuditItemState, number>;
  /** Proposed findings of the current reviews with a failed citation no reviewer has checked */
  flaggedProposed: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const emptyItemStates = (): Record<AuditItemState, number> => ({ pending: 0, analyzing: 0, reviewing: 0, reviewed: 0, failed: 0, skipped: 0 });

export async function loadAuditList(space: Pick<SpaceRow, "id">, opts: { states?: readonly AuditState[]; limit?: number; before?: Date } = {}): Promise<AuditListRow[]> {
  const where: SQL[] = [eq(audits.spaceId, space.id)];
  if (opts.states?.length) where.push(inArray(audits.state, [...opts.states]));
  if (opts.before) where.push(lt(audits.createdAt, opts.before));
  const rows = await db()
    .select()
    .from(audits)
    .where(and(...where))
    .orderBy(desc(audits.createdAt))
    .limit(Math.min(opts.limit ?? 100, 500));
  const ids = rows.map((r) => r.id);
  if (!ids.length) return [];
  const [itemCounts, findingCounts, flaggedCounts] = await Promise.all([
    db().select({ auditId: auditItems.auditId, state: auditItems.state, n: count() }).from(auditItems).where(inArray(auditItems.auditId, ids)).groupBy(auditItems.auditId, auditItems.state),
    db()
      .select({ auditId: findings.auditId, state: findings.state, n: count() })
      .from(findings)
      .innerJoin(auditItems, eq(auditItems.currentReviewId, findings.reviewId))
      .where(inArray(findings.auditId, ids))
      .groupBy(findings.auditId, findings.state),
    db()
      .select({ auditId: findings.auditId, n: count() })
      .from(findings)
      .innerJoin(auditItems, eq(auditItems.currentReviewId, findings.reviewId))
      .where(and(inArray(findings.auditId, ids), eq(findings.state, "proposed"), OPEN_CITATION_PROBLEM))
      .groupBy(findings.auditId),
  ]);
  const itemsBy = new Map<string, number>();
  const statesBy = new Map<string, Record<AuditItemState, number>>();
  for (const r of itemCounts) {
    itemsBy.set(r.auditId, (itemsBy.get(r.auditId) ?? 0) + Number(r.n));
    const st = statesBy.get(r.auditId) ?? emptyItemStates();
    st[r.state] += Number(r.n);
    statesBy.set(r.auditId, st);
  }
  const flaggedBy = new Map(flaggedCounts.map((r) => [r.auditId, Number(r.n)]));
  const findingsBy = new Map<string, FindingCounts>();
  for (const r of findingCounts) {
    const c = findingsBy.get(r.auditId) ?? emptyCounts();
    addCount(c, r.state, Number(r.n));
    findingsBy.set(r.auditId, c);
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    profileId: r.profileId,
    profileLabel: profileLabel(r.profileId, r.profileSnapshot),
    state: r.state,
    stateLabel: AUDIT_STATE_LABELS[r.state],
    items: itemsBy.get(r.id) ?? 0,
    findings: findingsBy.get(r.id) ?? emptyCounts(),
    itemStates: statesBy.get(r.id) ?? emptyItemStates(),
    flaggedProposed: flaggedBy.get(r.id) ?? 0,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

// ---------------------------------------------------------------- audit detail

export interface AuditSummary {
  id: string;
  name: string;
  note: string | null;
  profileId: string;
  profileLabel: string;
  state: AuditState;
  stateLabel: string;
  policyDigest: string;
  runId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  finalizedBy: string | null;
  finalizedAt: Date | null;
  finalizedCommit: string | null;
}

function auditSummary(a: AuditRow, profile: AuditProfile): AuditSummary {
  return {
    id: a.id,
    name: a.name,
    note: a.note,
    profileId: a.profileId,
    profileLabel: profile.label,
    state: a.state,
    stateLabel: AUDIT_STATE_LABELS[a.state],
    policyDigest: a.policyDigest,
    runId: a.runId,
    createdBy: a.createdBy,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    finalizedBy: a.finalizedBy,
    finalizedAt: a.finalizedAt,
    finalizedCommit: a.finalizedCommit,
  };
}

export interface CitationSummary {
  ok: boolean;
  checked: number;
  failed: number;
}

const citationSummary = (c: CitationCheck | null | undefined): CitationSummary | null => (c ? { ok: c.ok, checked: c.checked, failed: c.failed } : null);

export interface AuditItemSummary {
  id: string;
  taskId: string;
  incidentId: string | null;
  /** Investigation title from the journal cache (untrusted text) */
  title: string | null;
  cohort: string | null;
  cohortLabel: string | null;
  state: AuditItemState;
  /** "Waiting for review" for a pending item whose analyzers have run */
  stateLabel: string;
  stateReason: string | null;
  /** Ground-truth fields marked as columns in the profile, e.g. the benchmark score */
  columns: { key: string; label: string; value: string | null }[];
  /** The first column's value, for a Score column */
  score: string | null;
  review: { id: string; state: ReviewState; schemaValid: boolean | null; citationCheck: CitationSummary | null; startedAt: Date; finishedAt: Date | null } | null;
  /** The primary finding's summary field, e.g. the primary failure mode */
  primary: { field: string; value: unknown; label: string } | null;
  findings: FindingCounts;
  /** Proposed findings with a failed citation no reviewer has checked */
  flaggedProposed: number;
  journalSha256: string | null;
  analyzerErrors: number;
  /** Draft only */
  readiness: ItemReadiness | null;
}

export interface AuditProgress {
  total: number;
  byState: Record<AuditItemState, number>;
  /** Pending items whose analyzers have run, waiting for a review slot */
  waitingForReview: number;
  finished: number;
  /** finished / total (0 when empty) */
  fraction: number;
}

export interface AuditDetailView {
  audit: AuditSummary;
  profile: {
    label: string;
    description: string;
    cohorts: { id: string; label: string; items: number }[];
    inputs: { kind: string; label: string; required: boolean }[];
    columns: { key: string; label: string }[];
    /** The field the item list shows as the diagnosis */
    primaryField: { kind: string; field: string; label: string } | null;
    reviewConcurrency: number;
    /** Null until a model is chosen for the audit or set as the space default */
    modelId: string | null;
  };
  progress: AuditProgress;
  /** The audits.run job */
  job: JobStatusView | null;
  readiness: ReadinessSummary | null;
  items: AuditItemSummary[];
  findingCounts: { kind: string; label: string; counts: FindingCounts }[];
  actions: AuditActions;
}

export function progressOf(items: readonly Pick<AuditItemRow, "state" | "analyzedAt">[]): AuditProgress {
  const byState = { pending: 0, analyzing: 0, reviewing: 0, reviewed: 0, failed: 0, skipped: 0 } as Record<AuditItemState, number>;
  let waiting = 0;
  for (const i of items) {
    byState[i.state]++;
    if (i.state === "pending" && i.analyzedAt) waiting++;
  }
  const finished = items.filter((i) => isItemFinished(i.state)).length;
  return { total: items.length, byState, waitingForReview: waiting, finished, fraction: items.length ? finished / items.length : 0 };
}

function itemStateLabel(i: Pick<AuditItemRow, "state" | "analyzedAt">): string {
  return i.state === "pending" && i.analyzedAt ? "Waiting for review" : ITEM_STATE_LABELS[i.state];
}

async function currentFindingsOf(auditId: string): Promise<FindingRow[]> {
  return db()
    .select({ f: findings })
    .from(findings)
    .innerJoin(auditItems, eq(auditItems.currentReviewId, findings.reviewId))
    .where(eq(findings.auditId, auditId))
    .orderBy(asc(findings.auditItemId), asc(findings.kind), asc(findings.ordinal))
    .then((rows) => rows.map((r) => r.f));
}

async function taskTitles(spaceId: string, taskIds: string[]): Promise<Map<string, string | null>> {
  if (!taskIds.length) return new Map();
  const rows = await db()
    .select({ taskId: journalTasks.taskId, title: journalTasks.title })
    .from(journalTasks)
    .where(and(eq(journalTasks.spaceId, spaceId), inArray(journalTasks.taskId, taskIds)));
  return new Map(rows.map((r) => [r.taskId, r.title]));
}

export async function loadAuditDetail(space: Pick<SpaceRow, "id">, auditId: string, viewer: AuditViewer): Promise<AuditDetailView | null> {
  const audit = await getAudit(space.id, auditId);
  if (!audit) return null;
  const profile = profileOf(audit);
  const items = await listAuditItems(audit.id);
  const reviewIds = items.flatMap((i) => (i.currentReviewId ? [i.currentReviewId] : []));
  const [titles, current, reviewRows, docs, job, readiness] = await Promise.all([
    taskTitles(
      space.id,
      items.map((i) => i.taskId),
    ),
    currentFindingsOf(audit.id),
    reviewIds.length
      ? db()
          .select({ id: reviews.id, state: reviews.state, schemaValid: reviews.schemaValid, citationCheck: reviews.citationCheck, startedAt: reviews.startedAt, finishedAt: reviews.finishedAt })
          .from(reviews)
          .where(inArray(reviews.id, reviewIds))
      : Promise.resolve([]),
    currentEvidenceDocs(
      space.id,
      items.flatMap((i) => (i.incidentId ? [i.incidentId] : [])),
      profile.inputs.map((i) => i.kind),
    ),
    loadJobStatus(audit.runId),
    audit.state === "draft" ? readinessOf(space.id, items, profile) : Promise.resolve(null),
  ]);
  const reviewBy = new Map(reviewRows.map((r) => [r.id, r]));
  const docBy = new Map(docs.map((d) => [`${d.incidentId}\0${d.kind}`, d]));
  const readinessBy = new Map((readiness ?? []).map((r) => [r.itemId, r]));
  const columns = profileColumns(profile);
  const primaryEx = primaryExtractor(profile);
  const findingsByItem = new Map<string, FindingRow[]>();
  for (const f of current) findingsByItem.set(f.auditItemId, [...(findingsByItem.get(f.auditItemId) ?? []), f]);

  const summaries: AuditItemSummary[] = items.map((i) => {
    const fs = findingsByItem.get(i.id) ?? [];
    const counts = emptyCounts();
    for (const f of fs) addCount(counts, f.state);
    const cols = columns.map((c) => ({ key: c.key, label: c.label, value: (i.incidentId && docBy.get(`${i.incidentId}\0${c.kind}`)?.fields[c.field]) ?? null }));
    const r = i.currentReviewId ? reviewBy.get(i.currentReviewId) : undefined;
    const pf = primaryEx ? fs.find((f) => f.kind === primaryEx.kind) : undefined;
    const pv = pf && primaryEx?.summaryField ? pf.current[primaryEx.summaryField] : undefined;
    return {
      id: i.id,
      taskId: i.taskId,
      incidentId: i.incidentId,
      title: titles.get(i.taskId) ?? null,
      cohort: i.cohort,
      cohortLabel: i.cohort ? (profile.cohorts.find((c) => c.id === i.cohort)?.label ?? i.cohort) : null,
      state: i.state,
      stateLabel: itemStateLabel(i),
      stateReason: i.stateReason,
      columns: cols,
      score: cols[0]?.value ?? null,
      review: r ? { id: r.id, state: r.state, schemaValid: r.schemaValid, citationCheck: citationSummary(r.citationCheck), startedAt: r.startedAt, finishedAt: r.finishedAt } : null,
      primary: primaryEx?.summaryField && pv !== undefined ? { field: primaryEx.summaryField, value: pv, label: fieldValueLabel(profile, primaryEx.summaryField, pv, primaryEx.kind) } : null,
      findings: counts,
      flaggedProposed: fs.filter((f) => f.state === "proposed" && hasOpenProblem(f.citations)).length,
      journalSha256: i.journalSha256,
      analyzerErrors: i.analyzerErrors.length,
      readiness: readinessBy.get(i.id) ?? null,
    };
  });

  const byKind = new Map(profile.findings.map((f) => [f.kind, emptyCounts()]));
  for (const f of current) {
    const c = byKind.get(f.kind) ?? emptyCounts();
    addCount(c, f.state);
    byKind.set(f.kind, c);
  }
  const readinessSummary = readiness ? summarizeReadiness(readiness, profile) : null;
  return {
    audit: auditSummary(audit, profile),
    profile: {
      label: profile.label,
      description: profile.description,
      cohorts: profile.cohorts.map((c) => ({ id: c.id, label: c.label, items: items.filter((i) => i.cohort === c.id).length })),
      inputs: profile.inputs.map((i) => ({ kind: i.kind, label: i.label, required: i.required })),
      columns: columns.map((c) => ({ key: c.key, label: c.label })),
      primaryField: primaryEx?.summaryField ? { kind: primaryEx.kind, field: primaryEx.summaryField, label: fieldLabel(profile, primaryEx.summaryField, primaryEx.kind) } : null,
      reviewConcurrency: profile.review.concurrency,
      modelId: profile.review.modelId ?? null,
    },
    progress: progressOf(items),
    job,
    readiness: readinessSummary,
    items: summaries,
    findingCounts: [...byKind.entries()].map(([kind, counts]) => ({ kind, label: profile.findings.find((f) => f.kind === kind)?.label ?? kind, counts })),
    actions: auditActions(audit.state, readinessSummary ? { total: readinessSummary.total, ready: readinessSummary.ready } : null, viewer),
  };
}

// ---------------------------------------------------------------- item detail

export interface FindingFieldView {
  key: string;
  label: string;
  value: unknown;
  /** Readable form of an enum value (failure mode, owner) */
  valueLabel: string;
  proposed: unknown;
  changed: boolean;
  editable: boolean;
  /** Choices for an enum field (or an array of enum values), for the edit form */
  choices: { value: string; label: string }[] | null;
  /** True when the field holds a list of enum values */
  multiple: boolean;
}

export interface CitationView extends Citation {
  /** The journal record's ID, when the record number exists in the investigation */
  recordId: string | null;
  href: string | null;
}

export interface FindingView {
  id: string;
  kind: string;
  kindLabel: string;
  ordinal: number;
  title: string;
  state: FindingState;
  stateLabel: string;
  edited: boolean;
  linkable: boolean;
  /** From the item's current review; earlier reviews' findings are read-only */
  current: boolean;
  fields: FindingFieldView[];
  citations: CitationView[];
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  /** The earlier finding whose decision was carried to this one */
  carriedFromId: string | null;
  actions: FindingActions;
}

export interface ReviewView {
  id: string;
  state: ReviewState;
  current: boolean;
  runner: string;
  modelId: string;
  promptDigest: string;
  schemaValid: boolean | null;
  schemaErrors: string[];
  citationCheck: CitationSummary | null;
  /** Citations that failed the check */
  failedCitations: CitationView[];
  error: string | null;
  steps: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  startedBy: string;
  startedAt: Date;
  finishedAt: Date | null;
  findings: FindingView[];
  findingCounts: FindingCounts;
}

export interface GroundTruthView {
  kind: string;
  label: string;
  required: boolean;
  doc: {
    id: string;
    fileName: string;
    sha256: string;
    sizeBytes: number;
    /** Untrusted markdown: render with SafeMarkdown */
    body: string;
    /** `description`: what the value means (profile help), when the profile says */
    fields: { key: string; label: string; value: string | null; description: string | null }[];
    uploadedBy: string;
    uploadedAt: Date;
  } | null;
}

export interface AnalyzerView {
  id: string;
  label: string;
  ran: boolean;
  version: string | null;
  ranAt: Date | null;
  /** Values the profile's report shows for this analyzer (metrics-table columns) */
  summary: { key: string; label: string; value: unknown }[];
  error: string | null;
}

export interface AuditItemView {
  audit: AuditSummary;
  item: AuditItemSummary;
  /** The investigation page */
  journalHref: string;
  journalPresent: boolean;
  groundTruth: GroundTruthView[];
  analyzers: AnalyzerView[];
  reviews: ReviewView[];
  actions: ItemActions;
}

function dotted(v: unknown, path: string): unknown {
  let cur = v;
  for (const p of path.split(".")) cur = cur && typeof cur === "object" ? (cur as Json)[p] : undefined;
  return cur;
}

export async function loadAuditItem(space: Pick<SpaceRow, "id" | "alias">, auditId: string, itemId: string, viewer: AuditViewer): Promise<AuditItemView | null> {
  const audit = await getAudit(space.id, auditId);
  if (!audit || !isUuid(itemId)) return null;
  const profile = profileOf(audit);
  const detailItems = await listAuditItems(audit.id);
  const item = detailItems.find((i) => i.id === itemId);
  if (!item) return null;
  const loaded = await loadedPolicyForSpace(space.id);
  const pageSize = loaded.policy.journals.ui.recordsPageSize;
  const [bundle, runs, docs, reviewRows, findingRows, titles] = await Promise.all([
    loadJournalBundle(space.id, item.taskId),
    latestRunsForTask(space.id, item.taskId),
    item.incidentId
      ? currentEvidenceDocs(
          space.id,
          [item.incidentId],
          profile.inputs.map((i) => i.kind),
        )
      : Promise.resolve([]),
    db().select().from(reviews).where(eq(reviews.auditItemId, item.id)).orderBy(desc(reviews.startedAt)),
    db().select().from(findings).where(eq(findings.auditItemId, item.id)).orderBy(asc(findings.kind), asc(findings.ordinal)),
    taskTitles(space.id, [item.taskId]),
  ]);

  // Record number n (NormRecord.n) -> record ID, and its position in the journal page's order.
  const recordIdByN = new Map<number, string>();
  const position = new Map<string, number>();
  if (bundle) {
    bundle.records.forEach((r, i) => position.set(r.recordId, i));
    for (const r of normalizeBundle(bundle).records) recordIdByN.set(r.n, r.recordId);
  }
  const citationView = (c: Citation): CitationView => {
    const recordId = recordIdByN.get(c.record) ?? null;
    return { ...c, recordId, href: recordId ? recordHref(space.alias, item.taskId, recordId, position.get(recordId) ?? null, pageSize) : null };
  };

  const schema = readOutputSchema(profile, loaded.dirs);
  const propsByKind = new Map(profile.findings.map((ex) => [ex.kind, schema ? propertySchemas(schema, ex, ex.fields) : {}]));
  const findingView = (f: FindingRow, isCurrent: boolean): FindingView => {
    const ex = profile.findings.find((x) => x.kind === f.kind);
    const props = propsByKind.get(f.kind) ?? {};
    const keys = ex?.fields ?? Object.keys(f.current);
    return {
      id: f.id,
      kind: f.kind,
      kindLabel: ex?.label ?? f.kind,
      ordinal: f.ordinal,
      title: f.title,
      state: f.state,
      stateLabel: FINDING_STATE_LABELS[f.state],
      edited: f.edited,
      linkable: !!ex?.linkable,
      current: isCurrent,
      fields: keys
        .filter((k) => Object.hasOwn(f.current, k) || Object.hasOwn(f.proposed, k))
        .map((k) => {
          const prop = props[k];
          const choices = enumOf(prop, schema ?? undefined);
          return {
            key: k,
            label: fieldLabel(profile, k, f.kind),
            value: f.current[k],
            valueLabel: fieldValueLabel(profile, k, f.current[k], f.kind),
            proposed: f.proposed[k],
            changed: JSON.stringify(f.current[k]) !== JSON.stringify(f.proposed[k]),
            editable: !!ex?.editable.includes(k),
            choices: choices ? choices.filter((v): v is string => typeof v === "string").map((v) => ({ value: v, label: fieldValueLabel(profile, k, v, f.kind) })) : null,
            multiple: !!prop && !Array.isArray(prop.enum) && !!choices,
          };
        }),
      citations: f.citations.map(citationView),
      reviewNote: f.reviewNote,
      reviewedBy: f.reviewedBy,
      reviewedAt: f.reviewedAt,
      carriedFromId: f.carriedFromId,
      actions: findingActions(audit.state, { state: f.state, current: isCurrent, editable: !!ex?.editable.length }, viewer),
    };
  };

  const reviewViews: ReviewView[] = reviewRows.map((r: ReviewRow) => {
    const isCurrent = r.id === item.currentReviewId;
    const fs = findingRows.filter((f) => f.reviewId === r.id).map((f) => findingView(f, isCurrent));
    const counts = emptyCounts();
    for (const f of fs) addCount(counts, f.state);
    return {
      id: r.id,
      state: r.state,
      current: isCurrent,
      runner: r.runner,
      modelId: r.modelId,
      promptDigest: r.promptDigest,
      schemaValid: r.schemaValid,
      schemaErrors: r.schemaErrors,
      citationCheck: citationSummary(r.citationCheck),
      failedCitations: (r.citationCheck?.citations ?? []).filter((c) => !c.ok).map(citationView),
      error: r.error,
      steps: r.steps,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      durationMs: r.durationMs,
      startedBy: r.startedBy,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      findings: fs,
      findingCounts: counts,
    };
  });

  const current = reviewViews.find((r) => r.current);
  const docBy = new Map(docs.map((d) => [d.kind, d]));
  const columns = profileColumns(profile);
  const primaryEx = primaryExtractor(profile);
  const pf = primaryEx && current ? findingRows.find((f) => f.reviewId === current.id && f.kind === primaryEx.kind) : undefined;
  const pv = pf && primaryEx?.summaryField ? pf.current[primaryEx.summaryField] : undefined;
  const cols = columns.map((c) => ({ key: c.key, label: c.label, value: docBy.get(c.kind)?.fields[c.field] ?? null }));
  const readiness = audit.state === "draft" ? ((await readinessOf(space.id, [item], profile))[0] ?? null) : null;
  const summary: AuditItemSummary = {
    id: item.id,
    taskId: item.taskId,
    incidentId: item.incidentId,
    title: titles.get(item.taskId) ?? null,
    cohort: item.cohort,
    cohortLabel: item.cohort ? (profile.cohorts.find((c) => c.id === item.cohort)?.label ?? item.cohort) : null,
    state: item.state,
    stateLabel: itemStateLabel(item),
    stateReason: item.stateReason,
    columns: cols,
    score: cols[0]?.value ?? null,
    review: current ? { id: current.id, state: current.state, schemaValid: current.schemaValid, citationCheck: current.citationCheck, startedAt: current.startedAt, finishedAt: current.finishedAt } : null,
    primary: primaryEx?.summaryField && pv !== undefined ? { field: primaryEx.summaryField, value: pv, label: fieldValueLabel(profile, primaryEx.summaryField, pv, primaryEx.kind) } : null,
    findings: current?.findingCounts ?? emptyCounts(),
    flaggedProposed: current ? findingRows.filter((f) => f.reviewId === current.id && f.state === "proposed" && hasOpenProblem(f.citations)).length : 0,
    journalSha256: item.journalSha256,
    analyzerErrors: item.analyzerErrors.length,
    readiness,
  };

  const metricColumns = new Map<string, string[]>();
  for (const s of profile.report.sections) if (s.kind === "metrics-table" && s.analyzer) metricColumns.set(s.analyzer, s.columns ?? []);
  const runBy = new Map(runs.map((r) => [r.analyzer, r]));
  const analyzers: AnalyzerView[] = profile.analyzers.map((id) => {
    const run = runBy.get(id);
    let label = id;
    try {
      label = getAnalyzer(id).label;
    } catch {
      /* unknown analyzer in the profile */
    }
    return {
      id,
      label,
      ran: !!run,
      version: run?.analyzerVersion ?? null,
      ranAt: run?.createdAt ?? null,
      summary: run ? (metricColumns.get(id) ?? []).map((k) => ({ key: k, label: humanize(k), value: dotted(run.output, k) ?? null })) : [],
      error: item.analyzerErrors.find((e) => e.analyzer === id)?.message ?? null,
    };
  });

  return {
    audit: auditSummary(audit, profile),
    item: summary,
    journalHref: `/spaces/${encodeURIComponent(space.alias)}/journals/investigations/${encodeURIComponent(item.taskId)}`,
    journalPresent: !!bundle,
    groundTruth: profile.inputs.map((i) => {
      const d = docBy.get(i.kind);
      return {
        kind: i.kind,
        label: i.label,
        required: i.required,
        doc: d
          ? {
              id: d.id,
              fileName: d.fileName,
              sha256: d.sha256,
              sizeBytes: d.sizeBytes,
              body: d.body,
              // An audit keeps the profile it started with; help text added to the policy later still shows.
              fields: Object.entries(i.fields).map(([k, f]) => ({
                key: k,
                label: f.label,
                value: d.fields[k] ?? null,
                description: f.description ?? loaded.policy.audits.profiles[audit.profileId]?.inputs.find((x) => x.kind === i.kind)?.fields[k]?.description ?? null,
              })),
              uploadedBy: d.uploadedBy,
              uploadedAt: d.createdAt,
            }
          : null,
      };
    }),
    analyzers,
    reviews: reviewViews,
    actions: itemActions(audit.state, item.state, current?.findingCounts.proposed ?? 0, viewer),
  };
}

// ---------------------------------------------------------------- findings queue

export interface FindingsQueueFilters {
  kind?: string | null;
  state?: FindingState | null;
  /** A field of the findings, with `value`: an enum value such as a failure mode or an owner */
  field?: string | null;
  value?: string | null;
  cohort?: string | null;
  incidentId?: string | null;
  limit?: number;
  offset?: number;
}

export interface QueueRow {
  id: string;
  itemId: string;
  taskId: string;
  incidentId: string | null;
  cohort: string | null;
  kind: string;
  kindLabel: string;
  title: string;
  state: FindingState;
  stateLabel: string;
  edited: boolean;
  /** Enum fields with readable labels, for the queue's columns */
  tags: { field: string; value: string; label: string }[];
  /** `checked`: citations the check looked at; `failed`: of those, failed; `open`: failed and not yet checked by a reviewer */
  citations: { checked: number; failed: number; open: number };
  reviewedBy: string | null;
  reviewedAt: Date | null;
}

export interface FieldFilter {
  field: string;
  label: string;
  /** Finding kinds that have the field */
  kinds: string[];
  values: { value: string; label: string; count: number }[];
}

export interface FindingsQueueView {
  audit: AuditSummary;
  filters: Required<Omit<FindingsQueueFilters, "limit" | "offset">> & { limit: number; offset: number };
  kinds: { kind: string; label: string; count: number }[];
  states: { state: FindingState; label: string; count: number }[];
  fields: FieldFilter[];
  cohorts: { id: string; label: string; count: number }[];
  rows: QueueRow[];
  /** Rows matching the filters, before paging */
  total: number;
  actions: { review: boolean; reviewReason: string | null };
}

const valuesOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

export async function loadFindingsQueue(space: Pick<SpaceRow, "id">, auditId: string, filters: FindingsQueueFilters, viewer: AuditViewer): Promise<FindingsQueueView | null> {
  const audit = await getAudit(space.id, auditId);
  if (!audit) return null;
  const profile = profileOf(audit);
  const loaded = await loadedPolicyForSpace(space.id);
  const schema = readOutputSchema(profile, loaded.dirs);
  const [rows, items] = await Promise.all([currentFindingsOf(audit.id), listAuditItems(audit.id)]);
  const itemBy = new Map(items.map((i) => [i.id, i]));

  // Filterable fields: enum properties (or arrays of enums) in the output schema.
  const enumFields = new Map<string, { kinds: string[]; values: string[] }>();
  for (const ex of profile.findings) {
    const props = schema ? propertySchemas(schema, ex, ex.fields) : {};
    for (const [k, p] of Object.entries(props)) {
      const e = enumOf(p, schema ?? undefined)?.filter((v): v is string => typeof v === "string");
      if (!e) continue;
      const cur = enumFields.get(k) ?? { kinds: [], values: [] };
      cur.kinds.push(ex.kind);
      for (const v of e) if (!cur.values.includes(v)) cur.values.push(v);
      enumFields.set(k, cur);
    }
  }

  const f = {
    kind: filters.kind && profile.findings.some((x) => x.kind === filters.kind) ? filters.kind : null,
    state: filters.state && (["proposed", "accepted", "rejected"] as const).includes(filters.state) ? filters.state : null,
    field: filters.field && enumFields.has(filters.field) ? filters.field : null,
    value: filters.field && enumFields.has(filters.field) && filters.value ? filters.value : null,
    cohort: filters.cohort && profile.cohorts.some((c) => c.id === filters.cohort) ? filters.cohort : null,
    incidentId: filters.incidentId?.trim() || null,
    limit: Math.min(Math.max(filters.limit ?? 100, 1), 500),
    offset: Math.max(filters.offset ?? 0, 0),
  };

  const matches = (r: FindingRow, skip?: "kind" | "state" | "field" | "cohort") => {
    const item = itemBy.get(r.auditItemId);
    if (skip !== "kind" && f.kind && r.kind !== f.kind) return false;
    if (skip !== "state" && f.state && r.state !== f.state) return false;
    if (skip !== "cohort" && f.cohort && item?.cohort !== f.cohort) return false;
    if (f.incidentId && r.incidentId !== f.incidentId) return false;
    if (skip !== "field" && f.field && f.value && !valuesOf(r.current[f.field]).includes(f.value)) return false;
    return true;
  };

  const filtered = rows.filter((r) => matches(r));
  const kinds = profile.findings.map((ex) => ({ kind: ex.kind, label: ex.label, count: rows.filter((r) => r.kind === ex.kind && matches(r, "kind")).length }));
  const states = (["proposed", "accepted", "rejected"] as const).map((s) => ({ state: s, label: FINDING_STATE_LABELS[s], count: rows.filter((r) => r.state === s && matches(r, "state")).length }));
  const fields: FieldFilter[] = [...enumFields.entries()].map(([field, e]) => {
    const pool = rows.filter((r) => e.kinds.includes(r.kind) && matches(r, "field"));
    return {
      field,
      label: fieldLabel(profile, field),
      kinds: e.kinds,
      values: e.values.map((v) => ({ value: v, label: fieldValueLabel(profile, field, v), count: pool.filter((r) => valuesOf(r.current[field]).includes(v)).length })),
    };
  });
  const cohorts = profile.cohorts.map((c) => ({ id: c.id, label: c.label, count: rows.filter((r) => itemBy.get(r.auditItemId)?.cohort === c.id && matches(r, "cohort")).length }));

  const page = filtered.slice(f.offset, f.offset + f.limit);
  return {
    audit: auditSummary(audit, profile),
    filters: f,
    kinds,
    states,
    fields,
    cohorts,
    rows: page.map((r) => {
      const item = itemBy.get(r.auditItemId);
      const ex = profile.findings.find((x) => x.kind === r.kind);
      return {
        id: r.id,
        itemId: r.auditItemId,
        taskId: item?.taskId ?? "",
        incidentId: r.incidentId,
        cohort: item?.cohort ?? null,
        kind: r.kind,
        kindLabel: ex?.label ?? r.kind,
        title: r.title,
        state: r.state,
        stateLabel: FINDING_STATE_LABELS[r.state],
        edited: r.edited,
        tags: [...enumFields.entries()]
          .filter(([, e]) => e.kinds.includes(r.kind))
          .flatMap(([field]) => valuesOf(r.current[field]).map((v) => ({ field, value: v, label: fieldValueLabel(profile, field, v, r.kind) }))),
        citations: { checked: r.citations.length, failed: r.citations.filter((c) => !c.ok).length, open: citationProblemCounts(r.citations).open },
        reviewedBy: r.reviewedBy,
        reviewedAt: r.reviewedAt,
      };
    }),
    total: filtered.length,
    actions: findingQueueActions(audit.state, viewer),
  };
}

function findingQueueActions(state: AuditState, viewer: AuditViewer): FindingsQueueView["actions"] {
  const a = findingActions(state, { state: "proposed", current: true, editable: true }, viewer).accept;
  return { review: a.enabled, reviewReason: a.disabledReason };
}
