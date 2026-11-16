import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentSpaces } from "./core";

/**
 * Journal cache, exports and imports.
 * Pulled (API) and imported (markdown/zip) journals share these tables.
 */

export const journalImports = pgTable(
  "journal_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => agentSpaces.id, { onDelete: "cascade" }),
    /** Name of the uploaded file, as the user's browser sent it (display only) */
    fileName: text("file_name").notNull(),
    sha256: text("sha256").notNull(),
    /** "markdown" | "zip" | "export-zip" */
    format: text("format").notNull(),
    /** queued | running | succeeded | partial | failed | duplicate */
    status: text("status").notNull().default("pending"),
    parseReport: jsonb("parse_report"),
    importedBy: text("imported_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Saved upload, relative to DAM_DATA_DIR/imports */
    storedPath: text("stored_path"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    jobRunId: uuid("job_run_id"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("journal_imports_sha_idx").on(t.spaceId, t.sha256), index("journal_imports_space_idx").on(t.spaceId, t.createdAt)],
);

export const journalTasks = pgTable(
  "journal_tasks",
  {
    spaceId: uuid("space_id")
      .notNull()
      .references(() => agentSpaces.id, { onDelete: "cascade" }),
    taskId: text("task_id").notNull(),
    incidentId: text("incident_id"),
    title: text("title"),
    taskType: text("task_type"),
    status: text("status"),
    priority: text("priority"),
    reference: jsonb("reference"),
    createdAt: timestamp("created_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    source: text("source", { enum: ["api", "import"] }).notNull(),
    importId: uuid("import_id").references(() => journalImports.id),
    /** Path of the source file inside the uploaded zip (or the uploaded file name) */
    importPath: text("import_path"),
    /** Exactly as the API returned it (GetBacklogTask / ListBacklogTasks item) */
    raw: jsonb("raw"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.taskId] }), index("journal_tasks_incident_idx").on(t.spaceId, t.incidentId)],
);

export const journalExecutions = pgTable(
  "journal_executions",
  {
    spaceId: uuid("space_id")
      .notNull()
      .references(() => agentSpaces.id, { onDelete: "cascade" }),
    executionId: text("execution_id").notNull(),
    taskId: text("task_id").notNull(),
    parentExecutionId: text("parent_execution_id"),
    agentType: text("agent_type"),
    agentSubTask: text("agent_sub_task"),
    status: text("status"),
    createdAt: timestamp("created_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    raw: jsonb("raw"),
    /** True once every record page was cached; a resumed export skips the execution */
    recordsComplete: boolean("records_complete").notNull().default(false),
    recordCount: integer("record_count"),
    recordsFetchedAt: timestamp("records_fetched_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.executionId] }), index("journal_exec_task_idx").on(t.spaceId, t.taskId)],
);

export const journalRecords = pgTable(
  "journal_records",
  {
    spaceId: uuid("space_id")
      .notNull()
      .references(() => agentSpaces.id, { onDelete: "cascade" }),
    recordId: text("record_id").notNull(),
    executionId: text("execution_id").notNull(),
    taskId: text("task_id").notNull(),
    /** Position in ascending order within the execution, starting at 1 */
    seq: integer("seq").notNull(),
    recordType: text("record_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    /** Parsed content (see src/lib/journal/types.ts, RecordContent) */
    content: jsonb("content"),
    /** Exactly as the API returned it, or the imported source block */
    raw: jsonb("raw"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.recordId] }),
    index("journal_records_exec_idx").on(t.spaceId, t.executionId, t.seq),
    index("journal_records_task_idx").on(t.spaceId, t.taskId),
  ],
);

export const exportJobs = pgTable(
  "export_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => agentSpaces.id, { onDelete: "cascade" }),
    /** Selection: date range, task type, status, task IDs or incident IDs (exportSelectionSchema) */
    selection: jsonb("selection").notNull(),
    /** queued | running | succeeded | failed | cancelled | expired */
    status: text("status").notNull().default("queued"),
    jobRunId: uuid("job_run_id"),
    taskCount: integer("task_count"),
    recordCount: integer("record_count"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Short summary of what the walk did (fetched vs cached executions, IDs not found) */
    summary: jsonb("summary"),
    error: text("error"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("export_jobs_space_idx").on(t.spaceId, t.createdAt)],
);

export const exportFiles = pgTable("export_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  exportJobId: uuid("export_job_id")
    .notNull()
    .references(() => exportJobs.id, { onDelete: "cascade" }),
  /** Path under DAM_DATA_DIR/exports */
  path: text("path").notNull(),
  fileName: text("file_name").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Set when the expiry job deleted the file; the row stays as a record of the export */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
