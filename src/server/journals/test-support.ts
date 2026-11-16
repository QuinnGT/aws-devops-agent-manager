import type { StoredExecution, StoredRecord, StoredTask } from "@/lib/journal/types";
import type { ExecutionCacheState, JournalStore } from "./walker";

/** In-memory JournalStore for unit tests of the walker. */
export function memoryJournalStore() {
  const tasks = new Map<string, StoredTask>();
  const executions = new Map<string, { exec: StoredExecution; complete: boolean; count: number | null; status: string | null; updatedAt: Date | null }>();
  const records = new Map<string, StoredRecord>();
  const store: JournalStore = {
    async upsertTask(t) {
      tasks.set(t.taskId, t);
    },
    async getExecutionState(id): Promise<ExecutionCacheState | null> {
      const e = executions.get(id);
      return e ? { recordsComplete: e.complete, updatedAt: e.updatedAt, status: e.status, recordCount: e.count } : null;
    },
    async upsertExecution(exec) {
      const prev = executions.get(exec.executionId);
      executions.set(exec.executionId, prev ? { ...prev, exec } : { exec, complete: false, count: null, status: exec.status, updatedAt: exec.updatedAt });
    },
    async upsertRecords(rs) {
      for (const r of rs) records.set(r.recordId, r);
    },
    async markExecutionComplete(id, count) {
      const e = executions.get(id);
      if (e) executions.set(id, { ...e, complete: true, count, status: e.exec.status, updatedAt: e.exec.updatedAt });
    },
  };
  return { store, tasks, executions, records };
}
