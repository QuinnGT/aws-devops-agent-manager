import { and, asc, desc, eq, inArray, isNull, max } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db/client";
import { analyzerRuns, auditEvents, auditItems, audits, evidenceDocs, findings } from "@/server/db/schema";
import { AUDIENCES, type ExportRecord, type ReportAnalyzerRun, type ReportItem } from "./types";
import { latestChange, type FindingRecord } from "./view";

/**
 * Database edge of the reports module. Reads the audit tables (audits-core
 * writes them), evidence_docs and analyzer_runs; writes only audits.report*
 * and audits.finalized* (store.ts). Callers check permissions first.
 */

export type AuditRow = typeof audits.$inferSelect;

const uuid = z.string().uuid();

/** The audit, only when it belongs to the space. */
export async function getAuditInSpace(spaceId: string, auditId: string): Promise<AuditRow | null> {
  if (!uuid.safeParse(auditId).success || !uuid.safeParse(spaceId).success) return null;
  const [row] = await db()
    .select()
    .from(audits)
    .where(and(eq(audits.id, auditId), eq(audits.spaceId, spaceId)));
  return row ?? null;
}

export interface AuditData {
  items: ReportItem[];
  findings: FindingRecord[];
  evidence: Record<string, Record<string, string | null>>;
  analyzerRuns: Record<string, Record<string, ReportAnalyzerRun>>;
  /** Latest updated_at over the audit's items and findings */
  inputsChangedAt: Date | null;
}

export async function loadAuditData(audit: Pick<AuditRow, "id" | "spaceId">): Promise<AuditData> {
  const itemRows = await db().select().from(auditItems).where(eq(auditItems.auditId, audit.id)).orderBy(asc(auditItems.createdAt), asc(auditItems.taskId));
  const findingRows = await db()
    .select()
    .from(findings)
    .where(eq(findings.auditId, audit.id))
    .orderBy(asc(findings.kind), asc(findings.ordinal), asc(findings.createdAt));

  const items: ReportItem[] = itemRows.map((i) => ({
    id: i.id,
    taskId: i.taskId,
    incidentId: i.incidentId,
    cohort: i.cohort,
    state: i.state,
    stateReason: i.stateReason,
    journalSha256: i.journalSha256,
    currentReviewId: i.currentReviewId,
  }));
  const findingRecords: FindingRecord[] = findingRows.map((f) => ({
    id: f.id,
    auditItemId: f.auditItemId,
    reviewId: f.reviewId,
    incidentId: f.incidentId,
    kind: f.kind,
    ordinal: f.ordinal,
    title: f.title,
    current: f.current,
    proposed: f.proposed,
    citations: f.citations,
    state: f.state,
    edited: f.edited,
    reviewNote: f.reviewNote,
    reviewedBy: f.reviewedBy,
    reviewedAt: f.reviewedAt,
    updatedAt: f.updatedAt,
  }));

  const incidentIds = [...new Set(items.map((i) => i.incidentId).filter((x): x is string => !!x))];
  const evidence: AuditData["evidence"] = {};
  if (incidentIds.length) {
    const docs = await db()
      .select({ incidentId: evidenceDocs.incidentId, kind: evidenceDocs.kind, fields: evidenceDocs.fields })
      .from(evidenceDocs)
      .where(and(eq(evidenceDocs.spaceId, audit.spaceId), inArray(evidenceDocs.incidentId, incidentIds), isNull(evidenceDocs.supersededAt)))
      .orderBy(asc(evidenceDocs.kind), asc(evidenceDocs.createdAt));
    for (const d of docs) evidence[d.incidentId] = { ...(evidence[d.incidentId] ?? {}), ...(d.fields ?? {}) };
  }

  const taskIds = [...new Set(items.map((i) => i.taskId))];
  const runs: AuditData["analyzerRuns"] = {};
  if (taskIds.length) {
    const rows = await db()
      .selectDistinctOn([analyzerRuns.taskId, analyzerRuns.analyzer], {
        taskId: analyzerRuns.taskId,
        analyzer: analyzerRuns.analyzer,
        version: analyzerRuns.analyzerVersion,
        output: analyzerRuns.output,
        createdAt: analyzerRuns.createdAt,
      })
      .from(analyzerRuns)
      .where(and(eq(analyzerRuns.spaceId, audit.spaceId), inArray(analyzerRuns.taskId, taskIds)))
      .orderBy(analyzerRuns.taskId, analyzerRuns.analyzer, desc(analyzerRuns.createdAt));
    for (const r of rows) {
      (runs[r.taskId] ??= {})[r.analyzer] = { analyzer: r.analyzer, version: r.version, output: r.output, createdAt: r.createdAt.toISOString() };
    }
  }

  return {
    items,
    findings: findingRecords,
    evidence,
    analyzerRuns: runs,
    inputsChangedAt: latestChange([...itemRows.map((i) => i.updatedAt), ...findingRows.map((f) => f.updatedAt)]),
  };
}

/** Recent export attempts of the audit, from the audit log (action audit.report.export). */
export async function loadExportRecords(spaceId: string, auditId: string, limit = 50): Promise<ExportRecord[]> {
  const rows = await db()
    .select({ at: auditEvents.at, actor: auditEvents.actorEmail, result: auditEvents.result, details: auditEvents.details })
    .from(auditEvents)
    .where(and(eq(auditEvents.spaceId, spaceId), eq(auditEvents.action, EXPORT_ACTION), eq(auditEvents.targetId, auditId)))
    .orderBy(desc(auditEvents.at))
    .limit(limit);
  const out: ExportRecord[] = [];
  for (const r of rows) {
    const d = (r.details ?? {}) as { audience?: unknown; fileName?: unknown; violations?: unknown; warnings?: unknown };
    const audience = AUDIENCES.find((a) => a === d.audience);
    if (!audience) continue;
    const ruleIds = Array.isArray(d.violations) ? [...new Set(d.violations.map((v) => (v as { ruleId?: unknown }).ruleId).filter((x): x is string => typeof x === "string"))] : [];
    out.push({
      at: r.at.toISOString(),
      actor: r.actor,
      audience,
      result: r.result,
      fileName: typeof d.fileName === "string" ? d.fileName : null,
      ruleIds,
      errorCount: Array.isArray(d.violations) ? d.violations.length : 0,
      warningCount: Array.isArray(d.warnings) ? d.warnings.length : 0,
    });
  }
  return out;
}

export const EXPORT_ACTION = "audit.report.export";

/** Latest updated_at over the audit's findings and items, without loading them. */
export async function latestInputChange(auditId: string): Promise<Date | null> {
  const [f] = await db().select({ m: max(findings.updatedAt) }).from(findings).where(eq(findings.auditId, auditId));
  const [i] = await db().select({ m: max(auditItems.updatedAt) }).from(auditItems).where(eq(auditItems.auditId, auditId));
  return latestChange([f?.m, i?.m]);
}

/**
 * The builtAt to store for a build made now: never earlier than the latest
 * change it has seen. Row timestamps come from the database clock or another
 * process's clock, which can run slightly ahead of this one.
 */
export function buildTime(now: Date, seen: Date | null): Date {
  return seen && seen > now ? seen : now;
}
