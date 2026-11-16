import { and, asc, count, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import { db } from "@/server/db/client";
import { analyzerRuns, journalExecutions, journalRecords, journalTasks } from "@/server/db/schema";
import type { JournalBundle, RecordContent, StoredRecord } from "@/lib/journal/types";
import { parseRecordContent } from "@/lib/journal/types";

/**
 * Database edge of the analyzers module. Journal tables belong to the
 * journals module and are only read here; analyzer_runs is ours.
 * Callers check permissions before calling.
 */

export type AnalyzerRunRow = typeof analyzerRuns.$inferSelect;

function asRecordContent(content: unknown, raw: unknown): RecordContent {
  if (content && typeof content === "object" && "kind" in content) {
    const k = (content as { kind: unknown }).kind;
    if (k === "json" || k === "text" || k === "markdown") return content as RecordContent;
  }
  if (raw && typeof raw === "object" && "content" in raw) return parseRecordContent((raw as { content: unknown }).content);
  return parseRecordContent(content);
}

/** One investigation with its executions and records, from the journal cache. */
export async function loadJournalBundle(spaceId: string, taskId: string): Promise<JournalBundle | null> {
  const [t] = await db()
    .select()
    .from(journalTasks)
    .where(and(eq(journalTasks.spaceId, spaceId), eq(journalTasks.taskId, taskId)));
  if (!t) return null;
  const execs = await db()
    .select()
    .from(journalExecutions)
    .where(and(eq(journalExecutions.spaceId, spaceId), eq(journalExecutions.taskId, taskId)))
    .orderBy(asc(journalExecutions.createdAt), asc(journalExecutions.executionId));
  const recs = await db()
    .select()
    .from(journalRecords)
    .where(and(eq(journalRecords.spaceId, spaceId), eq(journalRecords.taskId, taskId)))
    .orderBy(asc(journalRecords.createdAt), asc(journalRecords.executionId), asc(journalRecords.seq));
  return {
    spaceId,
    task: {
      taskId: t.taskId,
      incidentId: t.incidentId,
      title: t.title,
      taskType: t.taskType,
      status: t.status,
      priority: t.priority,
      reference: t.reference,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      source: t.source,
      raw: t.raw,
    },
    executions: execs.map((e) => ({
      executionId: e.executionId,
      taskId: e.taskId,
      parentExecutionId: e.parentExecutionId,
      agentType: e.agentType,
      agentSubTask: e.agentSubTask,
      status: e.status,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      raw: e.raw,
    })),
    records: recs.map(
      (r): StoredRecord => ({
        recordId: r.recordId,
        executionId: r.executionId,
        taskId: r.taskId,
        seq: r.seq,
        recordType: r.recordType,
        createdAt: r.createdAt,
        content: asRecordContent(r.content, r.raw),
        raw: r.raw,
      }),
    ),
  };
}

/** Task IDs from `taskIds` that exist in the space. */
export async function existingTaskIds(spaceId: string, taskIds: string[]): Promise<Set<string>> {
  if (!taskIds.length) return new Set();
  const rows = await db()
    .select({ taskId: journalTasks.taskId })
    .from(journalTasks)
    .where(and(eq(journalTasks.spaceId, spaceId), inArray(journalTasks.taskId, taskIds)));
  return new Set(rows.map((r) => r.taskId));
}

export async function hasRun(spaceId: string, taskId: string, analyzer: string, version: string, inputDigest: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: analyzerRuns.id })
    .from(analyzerRuns)
    .where(
      and(
        eq(analyzerRuns.spaceId, spaceId),
        eq(analyzerRuns.taskId, taskId),
        eq(analyzerRuns.analyzer, analyzer),
        eq(analyzerRuns.analyzerVersion, version),
        eq(analyzerRuns.inputDigest, inputDigest),
      ),
    )
    .limit(1);
  return !!row;
}

/** Postgres jsonb cannot hold U+0000; journal text sometimes does. */
export function jsonbSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "string" ? x.replace(/\u0000/g, "") : x))) as T;
}

export async function insertRun(row: {
  spaceId: string;
  taskId: string;
  analyzer: string;
  analyzerVersion: string;
  inputDigest: string;
  output: unknown;
  jobRunId: string | null;
  recordCount: number;
  durationMs: number;
}): Promise<boolean> {
  const inserted = await db()
    .insert(analyzerRuns)
    .values({ ...row, output: jsonbSafe(row.output) as object })
    .onConflictDoNothing()
    .returning({ id: analyzerRuns.id });
  return inserted.length > 0;
}

/** Latest stored output per analyzer for one investigation. */
export async function latestRunsForTask(spaceId: string, taskId: string): Promise<AnalyzerRunRow[]> {
  return db()
    .selectDistinctOn([analyzerRuns.analyzer])
    .from(analyzerRuns)
    .where(and(eq(analyzerRuns.spaceId, spaceId), eq(analyzerRuns.taskId, taskId)))
    .orderBy(analyzerRuns.analyzer, desc(analyzerRuns.createdAt));
}

export interface InvestigationRow {
  taskId: string;
  incidentId: string | null;
  title: string | null;
  source: "api" | "import";
  status: string | null;
  createdAt: Date | null;
  records: number;
  metrics: Record<string, unknown> | null;
  metricsAt: Date | null;
  metricsVersion: string | null;
}

/** Investigations in a space, newest first, with their latest run metrics. `q` and `sources` narrow the list. */
export async function listInvestigations(
  spaceId: string,
  opts: { limit: number; offset: number; q?: string; sources?: ("api" | "import")[] },
): Promise<{ rows: InvestigationRow[]; total: number }> {
  const where: SQL[] = [eq(journalTasks.spaceId, spaceId)];
  if (opts.q) {
    const p = `%${opts.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(or(ilike(journalTasks.taskId, p), ilike(journalTasks.incidentId, p), ilike(journalTasks.title, p))!);
  }
  if (opts.sources?.length) where.push(inArray(journalTasks.source, opts.sources));
  const cond = and(...where);
  const [{ total } = { total: 0 }] = await db().select({ total: count() }).from(journalTasks).where(cond);
  const tasks = await db()
    .select({
      taskId: journalTasks.taskId,
      incidentId: journalTasks.incidentId,
      title: journalTasks.title,
      source: journalTasks.source,
      status: journalTasks.status,
      createdAt: journalTasks.createdAt,
    })
    .from(journalTasks)
    .where(cond)
    .orderBy(desc(journalTasks.createdAt), asc(journalTasks.taskId))
    .limit(opts.limit)
    .offset(opts.offset);
  const ids = tasks.map((t) => t.taskId);
  if (!ids.length) return { rows: [], total };
  const counts = await db()
    .select({ taskId: journalRecords.taskId, n: count() })
    .from(journalRecords)
    .where(and(eq(journalRecords.spaceId, spaceId), inArray(journalRecords.taskId, ids)))
    .groupBy(journalRecords.taskId);
  const metrics = await db()
    .selectDistinctOn([analyzerRuns.taskId], {
      taskId: analyzerRuns.taskId,
      output: analyzerRuns.output,
      createdAt: analyzerRuns.createdAt,
      version: analyzerRuns.analyzerVersion,
    })
    .from(analyzerRuns)
    .where(and(eq(analyzerRuns.spaceId, spaceId), eq(analyzerRuns.analyzer, "run-metrics"), inArray(analyzerRuns.taskId, ids)))
    .orderBy(analyzerRuns.taskId, desc(analyzerRuns.createdAt));
  const countBy = new Map(counts.map((c) => [c.taskId, c.n]));
  const metricsBy = new Map(metrics.map((m) => [m.taskId, m]));
  return {
    total,
    rows: tasks.map((t) => {
      const m = metricsBy.get(t.taskId);
      return {
        ...t,
        records: countBy.get(t.taskId) ?? 0,
        metrics: (m?.output as Record<string, unknown> | undefined) ?? null,
        metricsAt: m?.createdAt ?? null,
        metricsVersion: m?.version ?? null,
      };
    }),
  };
}

export async function getInvestigationTask(spaceId: string, taskId: string) {
  const [t] = await db()
    .select()
    .from(journalTasks)
    .where(and(eq(journalTasks.spaceId, spaceId), eq(journalTasks.taskId, taskId)));
  if (!t) return null;
  const [{ n } = { n: 0 }] = await db()
    .select({ n: count() })
    .from(journalRecords)
    .where(and(eq(journalRecords.spaceId, spaceId), eq(journalRecords.taskId, taskId)));
  return { ...t, records: n };
}
