import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agentSpaces } from "./core";

/** Analyzer output per incident (task). */
export const analyzerRuns = pgTable(
  "analyzer_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => agentSpaces.id, { onDelete: "cascade" }),
    taskId: text("task_id").notNull(),
    analyzer: text("analyzer").notNull(),
    analyzerVersion: text("analyzer_version").notNull(),
    /** SHA-256 over the records the analyzer read, so a rerun on the same input can be skipped */
    inputDigest: text("input_digest").notNull(),
    output: jsonb("output").notNull(),
    /** job_runs.id of the run that produced this row, when it came from a job */
    jobRunId: uuid("job_run_id"),
    /** Records the analyzer read */
    recordCount: integer("record_count"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("analyzer_runs_task_idx").on(t.spaceId, t.taskId, t.analyzer),
    uniqueIndex("analyzer_runs_input_uq").on(t.spaceId, t.taskId, t.analyzer, t.analyzerVersion, t.inputDigest),
  ],
);
