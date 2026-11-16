/**
 * Canonical journal shapes shared by export, import, analyzers, audits and
 * replays. Pulled journals come from ListBacklogTasks /
 * ListExecutions / ListJournalRecords; imported journals are parsed from
 * markdown exports into the same shapes.
 *
 * API facts (from test/fixtures/api/test-space):
 * - ListJournalRecords returns `records[]` with recordId, executionId,
 *   recordType, createdAt and `content`, which arrives as a JSON-encoded
 *   string (for messages: {"id","role","content":[{text|thinking|toolUse|toolResult...}]}).
 * - ListExecutions returns `executions[]` with parentExecutionId, agentType, agentSubTask.
 * - ListBacklogTasks returns `tasks[]` with taskId, title, taskType, status, priority,
 *   executionId, description, reference (optional).
 */

export type JournalSource = "api" | "import";

export interface StoredTask {
  taskId: string;
  incidentId: string | null;
  title: string | null;
  description?: string | null;
  taskType: string | null;
  status: string | null;
  priority: string | null;
  reference: unknown;
  createdAt: Date | null;
  updatedAt: Date | null;
  source: JournalSource;
  raw: unknown;
}

export interface StoredExecution {
  executionId: string;
  taskId: string;
  parentExecutionId: string | null;
  agentType: string | null;
  agentSubTask: string | null;
  status: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  raw: unknown;
}

/**
 * Parsed record content.
 * - API records: `{ kind: "json", value }` where value is the parsed JSON content
 *   (or `{ kind: "text", text }` when the content isn't JSON).
 * - Imported markdown records: `{ kind: "markdown", text, role?, json? }` with
 *   whatever structure the importer could recover.
 */
export type RecordContent =
  | { kind: "json"; value: unknown }
  | { kind: "text"; text: string }
  | { kind: "markdown"; text: string; role?: string | null; json?: unknown };

export interface StoredRecord {
  recordId: string;
  executionId: string;
  taskId: string;
  /** 1-based position in ascending order within its execution */
  seq: number;
  recordType: string;
  createdAt: Date;
  content: RecordContent;
  raw: unknown;
}

/** One investigation with its execution tree and all records, ascending. */
export interface JournalBundle {
  spaceId: string;
  task: StoredTask;
  executions: StoredExecution[];
  records: StoredRecord[];
}

/** Parse the API's `content` field (JSON string, object, or plain text). */
export function parseRecordContent(content: unknown): RecordContent {
  if (typeof content === "string") {
    const t = content.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return { kind: "json", value: JSON.parse(t) };
      } catch {
        /* fall through */
      }
    }
    return { kind: "text", text: content };
  }
  if (content === null || content === undefined) return { kind: "text", text: "" };
  return { kind: "json", value: content };
}
