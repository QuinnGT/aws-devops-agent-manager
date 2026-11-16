import { and, asc, count, desc, eq, ilike, inArray, or, sql, sum, type SQL } from "drizzle-orm";
import { normalizeBundle } from "@/server/analyzers/normalize";
import { loadJournalBundle } from "@/server/analyzers/store";
import { MODEL_SOURCE_LABELS, resolveAuditModels, type ModelSource } from "@/server/ai/models";
import { db } from "@/server/db/client";
import { auditEvents, auditItems, journalExecutions, journalRecords, journalTasks, modelCalls, reviews } from "@/server/db/schema";
import type { AuditProfile } from "@/server/policy/sections/audits";
import { recordText } from "@/server/review/records";
import type { SpaceRow } from "@/server/spaces/queries";
import { AuditRequestError } from "./errors";
import { loadAuditList, recordHref, type AuditListRow } from "./loaders";
import { loadedPolicyForSpace } from "./profiles";
import { resolveSelection, type Selection } from "./selection";
import type { AuditState } from "./states";
import { currentEvidenceDocs, isUuid, listAuditItems, profileOf, type AuditRow } from "./store";

/**
 * Page data for the audit screens that the loaders in loaders.ts don't
 * return: the list with its filters, where an audit's models came from, who
 * started or cancelled it, token use, one journal record as text, a preview
 * of a selection, and the ground truth a draft has per incident. Read-only;
 * the caller checks `audits.read` (or `audits.run` for the preview) first.
 */

// ---------------------------------------------------------------- list

export type AuditStateFilter = "open" | "finalized" | "cancelled" | "all";

export const AUDIT_STATE_FILTERS: Record<AuditStateFilter, readonly AuditState[] | null> = {
  open: ["draft", "running", "reviewing"],
  finalized: ["finalized"],
  cancelled: ["cancelled"],
  all: null,
};

export interface AuditListPageRow extends AuditListRow {
  /** While running: reviews finished (reviewed or failed) of the items that will be reviewed */
  progress: { done: number; total: number } | null;
}

export interface AuditListPage {
  rows: AuditListPageRow[];
  /** Rows beyond `limit` exist */
  more: boolean;
  /** Audits in each state filter, ignoring the state filter but not the others */
  counts: Record<AuditStateFilter, number>;
  /** Any audit at all in the space */
  any: boolean;
}

export async function loadAuditListPage(
  space: Pick<SpaceRow, "id">,
  f: { state: AuditStateFilter; profileId?: string | null; q?: string | null; limit: number },
): Promise<AuditListPage> {
  const all = await loadAuditList(space, { limit: 500 });
  const q = (f.q ?? "").trim().toLowerCase();
  const others = all.filter((r) => (!f.profileId || r.profileId === f.profileId) && (!q || r.name.toLowerCase().includes(q)));
  const inState = (s: AuditStateFilter, r: AuditListRow) => !AUDIT_STATE_FILTERS[s] || AUDIT_STATE_FILTERS[s]!.includes(r.state);
  const matching = others.filter((r) => inState(f.state, r));
  const shown = matching.slice(0, f.limit);
  const running = shown.filter((r) => r.state === "running").map((r) => r.id);
  const progress = new Map<string, { done: number; total: number }>();
  if (running.length) {
    const rows = await db()
      .select({ auditId: auditItems.auditId, state: auditItems.state, n: count() })
      .from(auditItems)
      .where(inArray(auditItems.auditId, running))
      .groupBy(auditItems.auditId, auditItems.state);
    for (const r of rows) {
      const p = progress.get(r.auditId) ?? { done: 0, total: 0 };
      if (r.state !== "skipped") p.total += Number(r.n);
      if (r.state === "reviewed" || r.state === "failed") p.done += Number(r.n);
      progress.set(r.auditId, p);
    }
  }
  const counts = { open: 0, finalized: 0, cancelled: 0, all: others.length } as Record<AuditStateFilter, number>;
  for (const r of others) for (const s of ["open", "finalized", "cancelled"] as const) if (inState(s, r)) counts[s]++;
  return { rows: shown.map((r) => ({ ...r, progress: progress.get(r.id) ?? null })), more: matching.length > f.limit, counts, any: all.length > 0 };
}

// ---------------------------------------------------------------- models and events

export interface AuditModelView {
  id: string | null;
  source: ModelSource | null;
  /** MODEL_SOURCE_LABELS[source], or null when the record of the choice is missing */
  sourceLabel: string | null;
}

const modelView = (id: string | null, source: ModelSource | null): AuditModelView => ({ id, source, sourceLabel: source ? MODEL_SOURCE_LABELS[source] : null });

const isSource = (v: unknown): v is ModelSource => typeof v === "string" && v in MODEL_SOURCE_LABELS;

/**
 * The audit's review and report models and where each came from. The IDs are
 * the ones in the profile snapshot (what the run uses); the sources come from
 * the last audit.create or audit.models.set event, when it names the same ID.
 */
export async function auditModels(audit: Pick<AuditRow, "id" | "profileSnapshot">): Promise<{ review: AuditModelView; report: AuditModelView }> {
  const profile = profileOf(audit);
  const [ev] = await db()
    .select({ details: auditEvents.details })
    .from(auditEvents)
    .where(and(eq(auditEvents.targetType, "audit"), eq(auditEvents.targetId, audit.id), inArray(auditEvents.action, ["audit.create", "audit.models.set"])))
    .orderBy(desc(auditEvents.at), desc(auditEvents.id))
    .limit(1);
  const d = (ev?.details ?? {}) as Record<string, unknown>;
  const reviewId = profile.review.modelId ?? null;
  const reportId = profile.report.modelId ?? reviewId;
  const reviewSource = reviewId && d.reviewModelId === reviewId && isSource(d.reviewModelSource) ? d.reviewModelSource : null;
  let reportSource: ModelSource | null = reportId && d.reportModelId === reportId && isSource(d.reportModelSource) ? d.reportModelSource : null;
  if (!profile.report.modelId && reviewId) reportSource = "review-model";
  return { review: modelView(reviewId, reviewSource), report: modelView(reportId, reportSource) };
}

/** What New audit shows for an empty model field: the space default, or the profile's fallback, or nothing. */
export function defaultModels(
  profile: Pick<AuditProfile, "review" | "report">,
  settings: Parameters<typeof resolveAuditModels>[1],
): { review: AuditModelView; report: AuditModelView } {
  const r = resolveAuditModels(profile, settings);
  return { review: modelView(r.review.id, r.review.source), report: modelView(r.report.id, r.report.source) };
}

export interface ActorAt {
  by: string;
  at: Date;
}

/** The latest event of each action for the audit: who started it, cancelled it, and so on. */
export async function auditEventTimes(auditId: string, actions: readonly string[]): Promise<Record<string, ActorAt | null>> {
  const out: Record<string, ActorAt | null> = Object.fromEntries(actions.map((a) => [a, null]));
  if (!isUuid(auditId) || !actions.length) return out;
  const rows = await db()
    .select({ action: auditEvents.action, by: auditEvents.actorEmail, at: auditEvents.at })
    .from(auditEvents)
    .where(and(eq(auditEvents.targetType, "audit"), eq(auditEvents.targetId, auditId), inArray(auditEvents.action, [...actions])))
    .orderBy(desc(auditEvents.at), desc(auditEvents.id));
  for (const r of rows) if (!out[r.action]) out[r.action] = { by: r.by, at: r.at };
  return out;
}

/** Tokens of the audit's review calls. */
export async function auditUsage(auditId: string): Promise<{ inputTokens: number; outputTokens: number; calls: number }> {
  if (!isUuid(auditId)) return { inputTokens: 0, outputTokens: 0, calls: 0 };
  const [r] = await db()
    .select({ input: sum(modelCalls.inputTokens), output: sum(modelCalls.outputTokens), calls: count() })
    .from(modelCalls)
    .where(and(eq(modelCalls.auditId, auditId), eq(modelCalls.purpose, "review")));
  return { inputTokens: Number(r?.input ?? 0), outputTokens: Number(r?.output ?? 0), calls: Number(r?.calls ?? 0) };
}

// ---------------------------------------------------------------- one record

export interface RecordTextView {
  /** 1-based record number (NormRecord.n), as citations use it */
  n: number;
  /** Records in the journal */
  total: number;
  recordId: string;
  recordType: string;
  createdAt: Date;
  /** The record as the reviewer saw it; untrusted, show as plain text */
  text: string;
  /** The record on the investigation page */
  href: string;
}

/**
 * One journal record of one investigation as plain text, by its number. Reads
 * only that investigation's journal. Null when the journal is not cached; a
 * number outside the journal gives `{ missing: true, total }`.
 */
export async function getRecordText(
  space: Pick<SpaceRow, "id" | "alias">,
  taskId: string,
  n: number,
): Promise<RecordTextView | { missing: true; total: number } | null> {
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) return null;
  const bundle = await loadJournalBundle(space.id, taskId);
  if (!bundle) return null;
  const norm = normalizeBundle(bundle);
  const rec = norm.records[n - 1];
  if (!rec) return { missing: true, total: norm.records.length };
  const position = bundle.records.findIndex((r) => r.recordId === rec.recordId);
  const pageSize = (await loadedPolicyForSpace(space.id)).policy.journals.ui.recordsPageSize;
  return {
    n,
    total: norm.records.length,
    recordId: rec.recordId,
    recordType: rec.recordType,
    createdAt: rec.createdAt,
    text: recordText(rec),
    href: recordHref(space.alias, taskId, rec.recordId, position < 0 ? null : position, pageSize),
  };
}

// ---------------------------------------------------------------- selection preview

export interface SelectionPreview {
  found: {
    taskId: string;
    incidentId: string | null;
    title: string | null;
    createdAt: Date | null;
    executions: number;
    /** Ground-truth kinds with a current document for the incident (of the kinds asked for) */
    docKinds: string[];
  }[];
  /** Incident or task IDs the selection named that have no cached journal */
  missing: string[];
  /** Found investigations with more than one execution */
  multiExecution: number;
  /** More investigations than an audit holds */
  overLimit: boolean;
  maxItems: number;
}

/**
 * What a selection would add, without creating anything. IDs without a cached
 * journal are listed, not refused. With `docKinds`, each investigation says
 * which of those ground-truth kinds the space already holds for its incident.
 */
export async function previewSelection(spaceId: string, s: Selection, docKinds: readonly string[] = []): Promise<SelectionPreview> {
  const max = (await loadedPolicyForSpace(spaceId)).policy.audits.maxItemsPerAudit;
  const cols = { taskId: journalTasks.taskId, incidentId: journalTasks.incidentId, title: journalTasks.title, createdAt: journalTasks.createdAt };
  let rows: { taskId: string; incidentId: string | null; title: string | null; createdAt: Date | null }[] = [];
  let missing: string[] = [];
  if (s.by === "incidents" || s.by === "tasks") {
    const ids = [...new Set(s.by === "incidents" ? s.incidentIds : s.taskIds)];
    const col = s.by === "incidents" ? journalTasks.incidentId : journalTasks.taskId;
    rows = await db()
      .select(cols)
      .from(journalTasks)
      .where(and(eq(journalTasks.spaceId, spaceId), inArray(col, ids)))
      .orderBy(asc(journalTasks.createdAt), asc(journalTasks.taskId));
    const found = new Set(rows.map((r) => (s.by === "incidents" ? r.incidentId : r.taskId)));
    missing = ids.filter((i) => !found.has(i));
  } else {
    try {
      rows = await resolveSelection(spaceId, s, max).then(async (tasks) => {
        const ids = tasks.map((t) => t.taskId);
        return ids.length
          ? db()
              .select(cols)
              .from(journalTasks)
              .where(and(eq(journalTasks.spaceId, spaceId), inArray(journalTasks.taskId, ids)))
              .orderBy(asc(journalTasks.createdAt), asc(journalTasks.taskId))
          : [];
      });
    } catch (err) {
      if (err instanceof AuditRequestError && typeof err.details?.matched === "number") {
        return { found: [], missing: [], multiExecution: 0, overLimit: true, maxItems: max };
      }
      if (err instanceof AuditRequestError && err.code === "invalid") return { found: [], missing: [], multiExecution: 0, overLimit: false, maxItems: max };
      throw err;
    }
  }
  const execCounts = rows.length
    ? await db()
        .select({ taskId: journalExecutions.taskId, n: count() })
        .from(journalExecutions)
        .where(and(eq(journalExecutions.spaceId, spaceId), inArray(journalExecutions.taskId, rows.map((r) => r.taskId))))
        .groupBy(journalExecutions.taskId)
    : [];
  const execBy = new Map(execCounts.map((e) => [e.taskId, Number(e.n)]));
  const docs = docKinds.length
    ? await currentEvidenceDocs(
        spaceId,
        rows.flatMap((r) => (r.incidentId ? [r.incidentId] : [])),
        [...docKinds],
      )
    : [];
  const kindsBy = new Map<string, string[]>();
  for (const d of docs) kindsBy.set(d.incidentId, [...(kindsBy.get(d.incidentId) ?? []), d.kind]);
  const found = rows.map((r) => ({ ...r, executions: execBy.get(r.taskId) ?? 0, docKinds: (r.incidentId && kindsBy.get(r.incidentId)) || [] }));
  return { found, missing, multiExecution: found.filter((f) => f.executions > 1).length, overLimit: found.length > max, maxItems: max };
}

/** Cached investigations for the "Pick from journals" dialog: newest first, filtered by text and status. */
export async function listPickableInvestigations(
  spaceId: string,
  f: { q?: string | null; status?: string | null; limit?: number },
): Promise<{ rows: { taskId: string; incidentId: string | null; title: string | null; status: string | null; createdAt: Date | null }[]; total: number }> {
  const where: SQL[] = [eq(journalTasks.spaceId, spaceId)];
  const q = (f.q ?? "").trim();
  if (q) {
    const p = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(or(ilike(journalTasks.taskId, p), ilike(journalTasks.incidentId, p), ilike(journalTasks.title, p))!);
  }
  if (f.status) where.push(eq(journalTasks.status, f.status));
  const cond = and(...where);
  const [{ total } = { total: 0 }] = await db().select({ total: count() }).from(journalTasks).where(cond);
  const rows = await db()
    .select({ taskId: journalTasks.taskId, incidentId: journalTasks.incidentId, title: journalTasks.title, status: journalTasks.status, createdAt: journalTasks.createdAt })
    .from(journalTasks)
    .where(cond)
    .orderBy(sql`${journalTasks.createdAt} desc nulls last`, asc(journalTasks.taskId))
    .limit(Math.min(Math.max(f.limit ?? 100, 1), 500));
  return { rows, total: Number(total) };
}

// ---------------------------------------------------------------- draft ground truth

export interface DraftEvidenceRow {
  itemId: string;
  taskId: string;
  incidentId: string | null;
  title: string | null;
  createdAt: Date | null;
  cohort: string | null;
  journalPresent: boolean;
  inputs: {
    kind: string;
    label: string;
    required: boolean;
    doc: {
      fileName: string;
      uploadedBy: string;
      uploadedAt: Date;
      fields: { key: string; label: string; value: string | null }[];
      /** The document was stored before this draft was created */
      reused: boolean;
      /** Reused, and an upload to this draft named the same incident and kind: the same bytes were uploaded again and the earlier copy is used */
      uploadedAgain: boolean;
    } | null;
  }[];
}

/** "<incidentId>\0<kind>" of every document an upload to this audit named (audit.evidence.upload events). */
async function documentsUploadedTo(auditId: string): Promise<Set<string>> {
  const rows = await db()
    .select({ details: auditEvents.details })
    .from(auditEvents)
    .where(and(eq(auditEvents.targetType, "audit"), eq(auditEvents.targetId, auditId), eq(auditEvents.action, "audit.evidence.upload")));
  const out = new Set<string>();
  for (const r of rows) {
    const docs = (r.details as { documents?: unknown } | null)?.documents;
    if (!Array.isArray(docs)) continue;
    for (const d of docs) {
      const x = d as { incidentId?: unknown; kind?: unknown };
      if (typeof x.incidentId === "string" && typeof x.kind === "string") out.add(`${x.incidentId}\0${x.kind}`);
    }
  }
  return out;
}

/**
 * One row per investigation of a draft with the current ground-truth document
 * of each input. A document stored before the draft was created is "reused";
 * when an upload to the draft named it, the same file was uploaded again.
 * Only names and extracted fields, never the document body.
 */
export async function loadDraftEvidence(spaceId: string, audit: Pick<AuditRow, "id" | "createdAt" | "profileSnapshot">): Promise<DraftEvidenceRow[]> {
  const profile = profileOf(audit);
  const items = await listAuditItems(audit.id);
  const taskIds = items.map((i) => i.taskId);
  const [docs, tasks, uploaded] = await Promise.all([
    currentEvidenceDocs(
      spaceId,
      items.flatMap((i) => (i.incidentId ? [i.incidentId] : [])),
      profile.inputs.map((i) => i.kind),
    ),
    taskIds.length
      ? db()
          .select({ taskId: journalTasks.taskId, title: journalTasks.title, createdAt: journalTasks.createdAt })
          .from(journalTasks)
          .where(and(eq(journalTasks.spaceId, spaceId), inArray(journalTasks.taskId, taskIds)))
      : Promise.resolve([]),
    documentsUploadedTo(audit.id),
  ]);
  const docBy = new Map(docs.map((d) => [`${d.incidentId}\0${d.kind}`, d]));
  const taskBy = new Map(tasks.map((t) => [t.taskId, t]));
  return items
    .map((i) => ({
      itemId: i.id,
      taskId: i.taskId,
      incidentId: i.incidentId,
      title: taskBy.get(i.taskId)?.title ?? null,
      createdAt: taskBy.get(i.taskId)?.createdAt ?? null,
      cohort: i.cohort,
      journalPresent: taskBy.has(i.taskId),
      inputs: profile.inputs.map((inp) => {
        const d = i.incidentId ? docBy.get(`${i.incidentId}\0${inp.kind}`) : undefined;
        return {
          kind: inp.kind,
          label: inp.label,
          required: inp.required,
          doc: d
            ? {
                fileName: d.fileName,
                uploadedBy: d.uploadedBy,
                uploadedAt: d.createdAt,
                fields: Object.entries(inp.fields).map(([k, fd]) => ({ key: k, label: fd.label, value: d.fields[k] ?? null })),
                reused: d.createdAt < audit.createdAt,
                uploadedAgain: d.createdAt < audit.createdAt && uploaded.has(`${d.incidentId}\0${d.kind}`),
              }
            : null,
        };
      }),
    }))
    .sort((a, b) => (a.incidentId ?? a.taskId).localeCompare(b.incidentId ?? b.taskId, undefined, { numeric: true }));
}

// ---------------------------------------------------------------- incident page

/** Records in an investigation's journal cache. */
export async function journalRecordCount(spaceId: string, taskId: string): Promise<number> {
  const [r] = await db()
    .select({ n: count() })
    .from(journalRecords)
    .where(and(eq(journalRecords.spaceId, spaceId), eq(journalRecords.taskId, taskId)));
  return Number(r?.n ?? 0);
}

export interface ReviewHighlights {
  /** The review says the ground truth is partly uncertain */
  groundTruthUncertain: boolean;
  /** The investigation's final answer as the review read it (untrusted text) */
  agentFinalAnswer: string | null;
  /** The summary record the benchmark scored */
  scoredSummaryRecord: number | null;
}

/**
 * Values of a review's output the incident page shows outside the finding
 * cards, when the profile's output has them (the benchmark profile does).
 * The review must belong to the item.
 */
export async function reviewHighlights(itemId: string, reviewId: string): Promise<ReviewHighlights> {
  const none: ReviewHighlights = { groundTruthUncertain: false, agentFinalAnswer: null, scoredSummaryRecord: null };
  if (!isUuid(itemId) || !isUuid(reviewId)) return none;
  const [r] = await db()
    .select({ output: reviews.output })
    .from(reviews)
    .where(and(eq(reviews.id, reviewId), eq(reviews.auditItemId, itemId)));
  const o = r?.output && typeof r.output === "object" && !Array.isArray(r.output) ? (r.output as Record<string, unknown>) : null;
  if (!o) return none;
  const rec = o.scored_summary_record;
  return {
    groundTruthUncertain: o.ground_truth_uncertain === true,
    agentFinalAnswer: typeof o.agent_final_answer === "string" && o.agent_final_answer.trim() ? o.agent_final_answer : null,
    scoredSummaryRecord: typeof rec === "number" && Number.isInteger(rec) && rec > 0 ? rec : null,
  };
}
