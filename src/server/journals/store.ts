import { and, asc, eq, sql } from "drizzle-orm";
import type { JournalBundle, RecordContent, StoredExecution, StoredRecord, StoredTask } from "@/lib/journal/types";
import { db, type Db } from "@/server/db/client";
import { journalExecutions, journalRecords, journalTasks } from "@/server/db/schema";
import { recordSizeBytes } from "./normalize";
import type { ExecutionCacheState, JournalStore } from "./walker";

/** Postgres cache for journals. Writes happen in the worker (export and import jobs). */

type TaskRow = typeof journalTasks.$inferSelect;
type ExecRow = typeof journalExecutions.$inferSelect;
type RecordRow = typeof journalRecords.$inferSelect;

const RECORD_CHUNK = 100;

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export function taskValues(spaceId: string, t: StoredTask, extra: { importId?: string | null; importPath?: string | null } = {}) {
  return {
    spaceId,
    taskId: t.taskId,
    incidentId: t.incidentId,
    title: t.title,
    taskType: t.taskType,
    status: t.status,
    priority: t.priority,
    reference: (t.reference ?? null) as object | null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    source: t.source,
    importId: extra.importId ?? null,
    importPath: extra.importPath ?? null,
    raw: (t.raw ?? null) as object | null,
  } satisfies typeof journalTasks.$inferInsert;
}

export function executionValues(spaceId: string, e: StoredExecution) {
  return {
    spaceId,
    executionId: e.executionId,
    taskId: e.taskId,
    parentExecutionId: e.parentExecutionId,
    agentType: e.agentType,
    agentSubTask: e.agentSubTask,
    status: e.status,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    raw: (e.raw ?? null) as object | null,
  } satisfies typeof journalExecutions.$inferInsert;
}

export function recordValues(spaceId: string, r: StoredRecord) {
  return {
    spaceId,
    recordId: r.recordId,
    executionId: r.executionId,
    taskId: r.taskId,
    seq: r.seq,
    recordType: r.recordType,
    createdAt: r.createdAt,
    content: r.content as object,
    raw: (r.raw ?? null) as object | null,
    sizeBytes: recordSizeBytes(r.raw),
  } satisfies typeof journalRecords.$inferInsert;
}

const excluded = (col: string) => sql.raw(`excluded."${col}"`);

/** The store the export walker writes through, for one space. */
export function dbJournalStore(spaceId: string, database: Db = db()): JournalStore {
  return {
    async upsertTask(t) {
      await database
        .insert(journalTasks)
        .values(taskValues(spaceId, t))
        .onConflictDoUpdate({
          target: [journalTasks.spaceId, journalTasks.taskId],
          // A pull from the API refreshes the cache and becomes its source.
          set: {
            incidentId: excluded("incident_id"),
            title: excluded("title"),
            taskType: excluded("task_type"),
            status: excluded("status"),
            priority: excluded("priority"),
            reference: excluded("reference"),
            createdAt: excluded("created_at"),
            updatedAt: excluded("updated_at"),
            source: excluded("source"),
            importId: sql`null`,
            importPath: sql`null`,
            raw: excluded("raw"),
            fetchedAt: sql`now()`,
          },
        });
    },
    async getExecutionState(executionId): Promise<ExecutionCacheState | null> {
      const [row] = await database
        .select({
          recordsComplete: journalExecutions.recordsComplete,
          updatedAt: journalExecutions.updatedAt,
          status: journalExecutions.status,
          recordCount: journalExecutions.recordCount,
        })
        .from(journalExecutions)
        .where(and(eq(journalExecutions.spaceId, spaceId), eq(journalExecutions.executionId, executionId)));
      return row ?? null;
    },
    async upsertExecution(e) {
      await database
        .insert(journalExecutions)
        .values(executionValues(spaceId, e))
        .onConflictDoUpdate({
          target: [journalExecutions.spaceId, journalExecutions.executionId],
          set: {
            taskId: excluded("task_id"),
            parentExecutionId: excluded("parent_execution_id"),
            agentType: excluded("agent_type"),
            agentSubTask: excluded("agent_sub_task"),
            // Keep the cached status and updatedAt until the records are complete,
            // so an interrupted walk is never mistaken for a finished one.
            raw: excluded("raw"),
          },
        });
    },
    async upsertRecords(records) {
      for (const part of chunks(records, RECORD_CHUNK)) {
        await database
          .insert(journalRecords)
          .values(part.map((r) => recordValues(spaceId, r)))
          .onConflictDoUpdate({
            target: [journalRecords.spaceId, journalRecords.recordId],
            set: {
              executionId: excluded("execution_id"),
              taskId: excluded("task_id"),
              seq: excluded("seq"),
              recordType: excluded("record_type"),
              createdAt: excluded("created_at"),
              content: excluded("content"),
              raw: excluded("raw"),
              sizeBytes: excluded("size_bytes"),
            },
          });
      }
    },
    async markExecutionComplete(executionId, recordCount) {
      // Status and updatedAt come from the raw execution stored at the start of this walk.
      await database
        .update(journalExecutions)
        .set({
          recordsComplete: true,
          recordCount,
          recordsFetchedAt: new Date(),
          status: sql`coalesce(${journalExecutions.raw}->>'executionStatus', ${journalExecutions.raw}->>'status')`,
          updatedAt: sql`(${journalExecutions.raw}->>'updatedAt')::timestamptz`,
          createdAt: sql`(${journalExecutions.raw}->>'createdAt')::timestamptz`,
        })
        .where(and(eq(journalExecutions.spaceId, spaceId), eq(journalExecutions.executionId, executionId)));
    },
  };
}

/** Insert an imported investigation. Returns false (and writes nothing) when the task is already cached. */
export async function insertImportedJournal(
  spaceId: string,
  journal: { task: StoredTask; executions: StoredExecution[]; records: StoredRecord[] },
  meta: { importId: string; importPath: string },
): Promise<boolean> {
  return db().transaction(async (tx) => {
    const inserted = await tx
      .insert(journalTasks)
      .values(taskValues(spaceId, journal.task, meta))
      .onConflictDoNothing()
      .returning({ taskId: journalTasks.taskId });
    if (inserted.length === 0) return false;
    const counts = new Map<string, number>();
    for (const r of journal.records) counts.set(r.executionId, (counts.get(r.executionId) ?? 0) + 1);
    if (journal.executions.length) {
      await tx
        .insert(journalExecutions)
        .values(
          journal.executions.map((e) => ({
            ...executionValues(spaceId, e),
            recordsComplete: true,
            recordCount: counts.get(e.executionId) ?? 0,
            recordsFetchedAt: new Date(),
          })),
        )
        .onConflictDoNothing();
    }
    for (const part of chunks(journal.records, RECORD_CHUNK)) {
      await tx
        .insert(journalRecords)
        .values(part.map((r) => recordValues(spaceId, r)))
        .onConflictDoNothing();
    }
    return true;
  });
}

export function rowToTask(row: TaskRow): StoredTask {
  const raw = row.raw as Record<string, unknown> | null;
  return {
    taskId: row.taskId,
    incidentId: row.incidentId,
    title: row.title,
    description: typeof raw?.description === "string" ? raw.description : null,
    taskType: row.taskType,
    status: row.status,
    priority: row.priority,
    reference: row.reference,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    source: row.source,
    raw: row.raw,
  };
}

export function rowToExecution(row: ExecRow): StoredExecution {
  return {
    executionId: row.executionId,
    taskId: row.taskId,
    parentExecutionId: row.parentExecutionId,
    agentType: row.agentType,
    agentSubTask: row.agentSubTask,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    raw: row.raw,
  };
}

export function rowToRecord(row: RecordRow): StoredRecord {
  return {
    recordId: row.recordId,
    executionId: row.executionId,
    taskId: row.taskId,
    seq: row.seq,
    recordType: row.recordType,
    createdAt: row.createdAt,
    content: (row.content ?? { kind: "text", text: "" }) as RecordContent,
    raw: row.raw,
  };
}

/** One cached investigation with its executions (oldest first) and all records (per execution, ascending). */
export async function loadBundle(spaceId: string, taskId: string): Promise<JournalBundle | null> {
  const [task] = await db()
    .select()
    .from(journalTasks)
    .where(and(eq(journalTasks.spaceId, spaceId), eq(journalTasks.taskId, taskId)));
  if (!task) return null;
  const execs = await db()
    .select()
    .from(journalExecutions)
    .where(and(eq(journalExecutions.spaceId, spaceId), eq(journalExecutions.taskId, taskId)))
    .orderBy(asc(journalExecutions.createdAt), asc(journalExecutions.executionId));
  const records = await db()
    .select()
    .from(journalRecords)
    .where(and(eq(journalRecords.spaceId, spaceId), eq(journalRecords.taskId, taskId)))
    .orderBy(asc(journalRecords.executionId), asc(journalRecords.seq));
  const order = new Map(execs.map((e, i) => [e.executionId, i]));
  records.sort((a, b) => (order.get(a.executionId) ?? 0) - (order.get(b.executionId) ?? 0) || a.seq - b.seq);
  return { spaceId, task: rowToTask(task), executions: execs.map(rowToExecution), records: records.map(rowToRecord) };
}
