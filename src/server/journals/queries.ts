import { existsSync } from "node:fs";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { StoredExecution } from "@/lib/journal/types";
import { db } from "@/server/db/client";
import { exportFiles, exportJobs, journalExecutions, journalImports, journalRecords, journalTasks, jobRuns } from "@/server/db/schema";
import { resolveInArea } from "./paths";
import { rowToExecution, rowToRecord } from "./store";

/** Read queries for the journals UI. Callers check `journals.read` (or the export/import permission) first. */

export const investigationFiltersSchema = z.object({
  q: z.string().trim().max(200).optional().catch(undefined),
  status: z.string().trim().max(64).optional().catch(undefined),
  taskType: z.string().trim().max(64).optional().catch(undefined),
  source: z.enum(["api", "import"]).optional().catch(undefined),
  from: z.iso.date().optional().catch(undefined),
  to: z.iso.date().optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(100_000).default(1).catch(1),
});
export type InvestigationFilters = z.output<typeof investigationFiltersSchema>;

/**
 * Optional filters on top of `InvestigationFilters`: several values per
 * field (any of them matches), and a created range as instants, so the UI can
 * use the viewer's time zone instead of UTC days.
 */
export interface InvestigationListFilters extends Partial<InvestigationFilters> {
  page: number;
  statuses?: string[];
  taskTypes?: string[];
  sources?: ("api" | "import")[];
  /** Inclusive */
  createdFrom?: Date;
  /** Exclusive */
  createdBefore?: Date;
}

/** Escape LIKE wildcards in user input. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function listInvestigations(spaceId: string, f: InvestigationListFilters, pageSize: number) {
  const where: SQL[] = [eq(journalTasks.spaceId, spaceId)];
  if (f.q) {
    const p = likePattern(f.q);
    where.push(or(ilike(journalTasks.taskId, p), ilike(journalTasks.incidentId, p), ilike(journalTasks.title, p))!);
  }
  if (f.status) where.push(eq(journalTasks.status, f.status));
  if (f.taskType) where.push(eq(journalTasks.taskType, f.taskType));
  if (f.source) where.push(eq(journalTasks.source, f.source));
  if (f.statuses?.length) where.push(inArray(journalTasks.status, f.statuses));
  if (f.taskTypes?.length) where.push(inArray(journalTasks.taskType, f.taskTypes));
  if (f.sources?.length) where.push(inArray(journalTasks.source, f.sources));
  if (f.from) where.push(gte(journalTasks.createdAt, new Date(`${f.from}T00:00:00Z`)));
  if (f.to) {
    const end = new Date(`${f.to}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    where.push(lt(journalTasks.createdAt, end));
  }
  if (f.createdFrom) where.push(gte(journalTasks.createdAt, f.createdFrom));
  if (f.createdBefore) where.push(lt(journalTasks.createdAt, f.createdBefore));
  const cond = and(...where);
  const [{ total } = { total: 0 }] = await db().select({ total: count() }).from(journalTasks).where(cond);
  const rows = await db()
    .select({
      taskId: journalTasks.taskId,
      incidentId: journalTasks.incidentId,
      title: journalTasks.title,
      taskType: journalTasks.taskType,
      status: journalTasks.status,
      priority: journalTasks.priority,
      createdAt: journalTasks.createdAt,
      source: journalTasks.source,
      fetchedAt: journalTasks.fetchedAt,
      // Drizzle renders a column in a single-table select without its table name, so inside these
      // subqueries `${journalTasks.taskId}` would bind to the inner table. Name the outer row explicitly.
      executionCount: sql<number>`(select count(*)::int from ${journalExecutions} e where e.space_id = "journal_tasks"."space_id" and e.task_id = "journal_tasks"."task_id")`,
      recordCount: sql<number>`(select count(*)::int from ${journalRecords} r where r.space_id = "journal_tasks"."space_id" and r.task_id = "journal_tasks"."task_id")`,
    })
    .from(journalTasks)
    .where(cond)
    .orderBy(desc(journalTasks.createdAt), asc(journalTasks.taskId))
    .limit(pageSize)
    .offset((f.page - 1) * pageSize);
  return { rows, total: Number(total) };
}

/** Distinct values for the filter dropdowns. */
export async function investigationFacets(spaceId: string) {
  const statuses = await db().selectDistinct({ v: journalTasks.status }).from(journalTasks).where(eq(journalTasks.spaceId, spaceId));
  const types = await db().selectDistinct({ v: journalTasks.taskType }).from(journalTasks).where(eq(journalTasks.spaceId, spaceId));
  const clean = (xs: { v: string | null }[]) => xs.map((x) => x.v).filter((v): v is string => !!v).sort();
  return { statuses: clean(statuses), taskTypes: clean(types) };
}

/** Counts for the Investigations, Exports and Imports tabs. */
export async function journalCounts(spaceId: string): Promise<{ investigations: number; exports: number; imports: number }> {
  const one = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
  const [investigations, exports, imports] = await Promise.all([
    one(db().select({ n: count() }).from(journalTasks).where(eq(journalTasks.spaceId, spaceId))),
    one(db().select({ n: count() }).from(exportJobs).where(eq(exportJobs.spaceId, spaceId))),
    one(db().select({ n: count() }).from(journalImports).where(eq(journalImports.spaceId, spaceId))),
  ]);
  return { investigations, exports, imports };
}

export async function getInvestigation(spaceId: string, taskId: string) {
  const [task] = await db()
    .select()
    .from(journalTasks)
    .where(and(eq(journalTasks.spaceId, spaceId), eq(journalTasks.taskId, taskId)));
  if (!task) return null;
  const execRows = await db()
    .select()
    .from(journalExecutions)
    .where(and(eq(journalExecutions.spaceId, spaceId), eq(journalExecutions.taskId, taskId)))
    .orderBy(asc(journalExecutions.createdAt), asc(journalExecutions.executionId));
  const typeCounts = await db()
    .select({ recordType: journalRecords.recordType, n: count() })
    .from(journalRecords)
    .where(and(eq(journalRecords.spaceId, spaceId), eq(journalRecords.taskId, taskId)))
    .groupBy(journalRecords.recordType)
    .orderBy(journalRecords.recordType);
  const perExec = await db()
    .select({ executionId: journalRecords.executionId, n: count() })
    .from(journalRecords)
    .where(and(eq(journalRecords.spaceId, spaceId), eq(journalRecords.taskId, taskId)))
    .groupBy(journalRecords.executionId);
  let importFile: { fileName: string; sha256: string } | null = null;
  if (task.importId) {
    const [imp] = await db().select({ fileName: journalImports.fileName, sha256: journalImports.sha256 }).from(journalImports).where(eq(journalImports.id, task.importId));
    importFile = imp ?? null;
  }
  return {
    task,
    importFile,
    executions: execRows.map(rowToExecution),
    recordCounts: new Map(perExec.map((r) => [r.executionId, Number(r.n)])),
    typeCounts: typeCounts.map((r) => ({ recordType: r.recordType, n: Number(r.n) })),
  };
}

export interface ExecutionNode {
  execution: StoredExecution;
  children: ExecutionNode[];
}

/** Executions nested by parentExecutionId; an execution whose parent is not cached sits at the top level. */
export function buildExecutionTree(executions: StoredExecution[]): ExecutionNode[] {
  const nodes = new Map(executions.map((e) => [e.executionId, { execution: e, children: [] as ExecutionNode[] }]));
  const roots: ExecutionNode[] = [];
  for (const n of nodes.values()) {
    const parentId = n.execution.parentExecutionId;
    const parent = parentId && parentId !== n.execution.executionId ? nodes.get(parentId) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  // Break any cycle in the data: nodes unreachable from a root are listed at the top level.
  const reachable = new Set<string>();
  const mark = (n: ExecutionNode) => {
    if (reachable.has(n.execution.executionId)) return;
    reachable.add(n.execution.executionId);
    n.children.forEach(mark);
  };
  roots.forEach(mark);
  for (const n of nodes.values()) if (!reachable.has(n.execution.executionId)) roots.push({ execution: n.execution, children: [] });
  return roots;
}

export async function listRecords(
  spaceId: string,
  taskId: string,
  opts: { executionId?: string; recordType?: string; page: number; pageSize: number },
) {
  const where: SQL[] = [eq(journalRecords.spaceId, spaceId), eq(journalRecords.taskId, taskId)];
  if (opts.executionId) where.push(eq(journalRecords.executionId, opts.executionId));
  if (opts.recordType) where.push(eq(journalRecords.recordType, opts.recordType));
  const cond = and(...where);
  const [{ total } = { total: 0 }] = await db().select({ total: count() }).from(journalRecords).where(cond);
  const rows = await db()
    .select()
    .from(journalRecords)
    .where(cond)
    .orderBy(asc(journalRecords.createdAt), asc(journalRecords.executionId), asc(journalRecords.seq))
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);
  return { records: rows.map(rowToRecord), total: Number(total) };
}

export async function listExportJobs(spaceId: string, limit = 50) {
  return db()
    .select({
      id: exportJobs.id,
      selection: exportJobs.selection,
      status: exportJobs.status,
      jobRunId: exportJobs.jobRunId,
      taskCount: exportJobs.taskCount,
      recordCount: exportJobs.recordCount,
      createdBy: exportJobs.createdBy,
      createdAt: exportJobs.createdAt,
      expiresAt: exportJobs.expiresAt,
      summary: exportJobs.summary,
      error: exportJobs.error,
      runStatus: jobRuns.status,
      fileName: exportFiles.fileName,
      sizeBytes: exportFiles.sizeBytes,
      sha256: exportFiles.sha256,
      fileDeletedAt: exportFiles.deletedAt,
    })
    .from(exportJobs)
    .leftJoin(exportFiles, eq(exportFiles.exportJobId, exportJobs.id))
    .leftJoin(jobRuns, eq(jobRuns.id, exportJobs.jobRunId))
    .where(eq(exportJobs.spaceId, spaceId))
    .orderBy(desc(exportJobs.createdAt))
    .limit(limit);
}

export async function listImports(spaceId: string, limit = 50) {
  return db()
    .select({
      id: journalImports.id,
      fileName: journalImports.fileName,
      sha256: journalImports.sha256,
      format: journalImports.format,
      status: journalImports.status,
      parseReport: journalImports.parseReport,
      importedBy: journalImports.importedBy,
      createdAt: journalImports.createdAt,
      finishedAt: journalImports.finishedAt,
      sizeBytes: journalImports.sizeBytes,
      jobRunId: journalImports.jobRunId,
      runStatus: jobRuns.status,
    })
    .from(journalImports)
    .leftJoin(jobRuns, eq(jobRuns.id, journalImports.jobRunId))
    .where(eq(journalImports.spaceId, spaceId))
    .orderBy(desc(journalImports.createdAt))
    .limit(limit);
}

export type ExportDownload =
  | { ok: true; absPath: string; fileName: string; sizeBytes: number; sha256: string }
  | { ok: false; status: 404 | 410; reason: string };

/** The export file for a download, scoped to the space that the caller was authorized for. */
export async function getExportDownload(spaceId: string, exportJobId: string, now = new Date()): Promise<ExportDownload> {
  const [row] = await db()
    .select({ path: exportFiles.path, fileName: exportFiles.fileName, sizeBytes: exportFiles.sizeBytes, sha256: exportFiles.sha256, expiresAt: exportJobs.expiresAt })
    .from(exportFiles)
    .innerJoin(exportJobs, eq(exportFiles.exportJobId, exportJobs.id))
    .where(and(eq(exportJobs.id, exportJobId), eq(exportJobs.spaceId, spaceId), isNull(exportFiles.deletedAt)));
  if (!row) return { ok: false, status: 404, reason: "No export file" };
  if (row.expiresAt && row.expiresAt <= now) return { ok: false, status: 410, reason: "The export has expired" };
  const absPath = resolveInArea("exports", row.path);
  if (!existsSync(absPath)) return { ok: false, status: 410, reason: "The export file is no longer available" };
  return { ok: true, absPath, fileName: row.fileName, sizeBytes: row.sizeBytes, sha256: row.sha256 };
}
