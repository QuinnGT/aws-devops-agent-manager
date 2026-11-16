import { parseRecordContent, type JournalBundle, type StoredRecord } from "@/lib/journal/types";
import { parseJournalMarkdown } from "@/server/journals/markdown-import";
import type { Policy } from "@/server/policy";
import { apiFixture } from "../../../test/helpers/fixtures";

/** Test helpers: journal bundles built from the captured API fixtures or from markdown. Not used by app code. */

interface ApiRecord {
  recordId: string;
  executionId: string;
  createdAt: string;
  recordType: string;
  content: unknown;
}

interface ApiTask {
  taskId: string;
  title: string;
  taskType: string;
  status: string;
  priority: string;
  createdAt: string;
  updatedAt: string;
  executionId: string;
  description?: string;
  reference?: unknown;
}

interface ApiExecution {
  executionId: string;
  parentExecutionId?: string;
  agentType?: string;
  agentSubTask?: string;
  executionStatus?: string;
  createdAt: string;
  updatedAt: string;
}

/** The test space's one captured investigation (GetBacklogTask, ListExecutions, ListJournalRecords pages 0 and 1). */
export function apiFixtureBundle(spaceId = "00000000-0000-0000-0000-000000000001"): JournalBundle {
  const task = apiFixture<{ task: ApiTask }>("GetBacklogTask").response.task;
  const execs = apiFixture<{ executions: ApiExecution[] }>("ListExecutions").response.executions;
  const records = [
    ...apiFixture<{ records: ApiRecord[] }>("ListJournalRecords.exec0.page0").response.records,
    ...apiFixture<{ records: ApiRecord[] }>("ListJournalRecords.exec0.page1").response.records,
  ];
  return {
    spaceId,
    task: {
      taskId: task.taskId,
      incidentId: null,
      title: task.title,
      description: task.description ?? null,
      taskType: task.taskType,
      status: task.status,
      priority: task.priority,
      reference: task.reference ?? null,
      createdAt: new Date(task.createdAt),
      updatedAt: new Date(task.updatedAt),
      source: "api",
      raw: task,
    },
    executions: execs.map((e) => ({
      executionId: e.executionId,
      taskId: task.taskId,
      parentExecutionId: e.parentExecutionId ?? null,
      agentType: e.agentType ?? null,
      agentSubTask: e.agentSubTask ?? null,
      status: e.executionStatus ?? null,
      createdAt: new Date(e.createdAt),
      updatedAt: new Date(e.updatedAt),
      raw: e,
    })),
    records: records.map(
      (r, i): StoredRecord => ({
        recordId: r.recordId,
        executionId: r.executionId,
        taskId: task.taskId,
        seq: i + 1,
        recordType: r.recordType,
        createdAt: new Date(r.createdAt),
        content: parseRecordContent(r.content),
        raw: r,
      }),
    ),
  };
}

/** A bundle from markdown text, as the import job would store it. */
export function markdownBundle(text: string, policy: Pick<Policy, "journalImport">, sourceSha256: string, spaceId = "00000000-0000-0000-0000-000000000001"): JournalBundle {
  const p = parseJournalMarkdown(text, policy, { sourceSha256, fileName: "test.md" });
  return { spaceId, task: { ...p.task, source: "import" }, executions: p.executions, records: p.records };
}
