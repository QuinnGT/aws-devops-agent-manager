import { parseRecordContent, type JournalSource, type StoredExecution, type StoredRecord, type StoredTask } from "@/lib/journal/types";

/**
 * Converts API objects (ListBacklogTasks / GetBacklogTask items, ListExecutions
 * items, ListJournalRecords items) into the canonical stored shapes. The same
 * functions run on pulled journals and on the raw JSON inside an app export
 * zip, which is what makes an export import back losslessly.
 */

export type RawObject = Record<string, unknown>;

/** JSON-safe deep copy: Dates become ISO strings, undefined is dropped (what jsonb stores anyway). */
export function jsonSafe<T>(v: T): unknown {
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}

export function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function isRawObject(v: unknown): v is RawObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function toStoredTask(raw: RawObject, incidentId: string | null, source: JournalSource): StoredTask {
  const taskId = str(raw.taskId);
  if (!taskId) throw new Error("task has no taskId");
  return {
    taskId,
    incidentId,
    title: str(raw.title),
    description: str(raw.description),
    taskType: str(raw.taskType),
    status: str(raw.status),
    priority: str(raw.priority),
    reference: raw.reference === undefined ? null : jsonSafe(raw.reference),
    createdAt: toDate(raw.createdAt),
    updatedAt: toDate(raw.updatedAt),
    source,
    raw: jsonSafe(raw),
  };
}

export function toStoredExecution(raw: RawObject, taskId: string): StoredExecution {
  const executionId = str(raw.executionId);
  if (!executionId) throw new Error(`an execution of task ${taskId} has no executionId`);
  return {
    executionId,
    taskId,
    parentExecutionId: str(raw.parentExecutionId),
    agentType: str(raw.agentType),
    agentSubTask: str(raw.agentSubTask),
    // ListExecutions calls it executionStatus.
    status: str(raw.executionStatus) ?? str(raw.status),
    createdAt: toDate(raw.createdAt),
    updatedAt: toDate(raw.updatedAt),
    raw: jsonSafe(raw),
  };
}

export function toStoredRecord(raw: RawObject, taskId: string, seq: number, fallbackExecutionId?: string): StoredRecord {
  const recordId = str(raw.recordId);
  const executionId = str(raw.executionId) ?? fallbackExecutionId ?? null;
  const createdAt = toDate(raw.createdAt);
  if (!recordId || !executionId || !createdAt) throw new Error(`record ${seq} of task ${taskId} is missing recordId, executionId or createdAt`);
  return {
    recordId,
    executionId,
    taskId,
    seq,
    recordType: str(raw.recordType) ?? "unknown",
    createdAt,
    content: parseRecordContent(raw.content),
    raw: jsonSafe(raw),
  };
}

/** Size of a record as the API sent it: the content string in UTF-8 bytes, or its JSON. */
export function recordSizeBytes(raw: unknown): number {
  const content = isRawObject(raw) ? raw.content : raw;
  const s = typeof content === "string" ? content : (JSON.stringify(content ?? null) ?? "");
  return Buffer.byteLength(s, "utf8");
}
