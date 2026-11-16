import type { JournalBundle, StoredRecord } from "@/lib/journal/types";

/**
 * Test support: synthetic journals shaped like the API's records (assistant
 * messages with fs_read tool calls, user messages with numbered tool results,
 * as in test/fixtures/api/test-space). Only used by tests.
 */

export interface SyntheticRead {
  /** Deployed path the agent requests */
  path: string;
  /** Body returned; null for a request without a returned body */
  body: string | null;
}

/** "     1\tline" numbering, as fs_read returns it. */
export function numbered(body: string): string {
  return body
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(6, " ")}\t${l}`)
    .join("\n");
}

export function syntheticBundle(o: { spaceId: string; taskId: string; incidentId?: string | null; createdAt: Date; reads: SyntheticRead[] }): JournalBundle {
  const executionId = `exe-${o.taskId}`;
  const records: StoredRecord[] = [];
  const at = (i: number) => new Date(o.createdAt.getTime() + (i + 1) * 1000);
  const push = (value: unknown) => {
    const i = records.length;
    records.push({
      recordId: `${o.taskId}-rec-${i + 1}`,
      executionId,
      taskId: o.taskId,
      seq: i + 1,
      recordType: "message",
      createdAt: at(i),
      content: { kind: "json", value },
      raw: { recordId: `${o.taskId}-rec-${i + 1}`, content: JSON.stringify(value) },
    });
  };
  push({ role: "user", content: [{ type: "text", text: `TITLE: ${o.incidentId ?? o.taskId}` }] });
  o.reads.forEach((r, n) => {
    const id = `tooluse_${n}`;
    push({ role: "assistant", content: [{ type: "tool_use", id, tool_name: "fs_read", input: { file_path: r.path } }] });
    if (r.body !== null) push({ role: "user", content: [{ type: "tool_result", id, content: [{ text: numbered(r.body) }], status: "success" }] });
  });
  return {
    spaceId: o.spaceId,
    task: {
      taskId: o.taskId,
      incidentId: o.incidentId ?? null,
      title: o.incidentId ?? o.taskId,
      taskType: "INVESTIGATION",
      status: "COMPLETED",
      priority: "HIGH",
      reference: null,
      createdAt: o.createdAt,
      updatedAt: o.createdAt,
      source: "api",
      raw: { taskId: o.taskId, executionId },
    },
    executions: [
      { executionId, taskId: o.taskId, parentExecutionId: null, agentType: "INCIDENT_RCA", agentSubTask: null, status: "COMPLETED", createdAt: o.createdAt, updatedAt: o.createdAt, raw: {} },
    ],
    records,
  };
}

/** A memory body with lines long enough for the analyzer to compare (25 characters or more). */
export function memoryText(title: string, lines: string[]): string {
  return [`---`, `name: ${title}`, `description: ${title} notes for tests.`, `---`, ``, `# ${title} notes used by the verification tests`, ...lines].join("\n") + "\n";
}
