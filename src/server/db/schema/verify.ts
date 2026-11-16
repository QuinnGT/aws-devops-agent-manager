import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentSpaces } from "./core";
import { releases } from "./releases";

/**
 * Release verification, checks 1 and 2. One row per check run: whether the live space
 * matches a release (`live`), or whether the agent read the release's
 * instruction, skill and memory bodies (`reads`). Rebuildable: a rerun of the
 * same check produces the same result from git, the index and the journal cache.
 */
export const verificationRuns = pgTable(
  "verification_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => agentSpaces.id, { onDelete: "cascade" }),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => releases.id, { onDelete: "cascade" }),
    /** live | reads */
    kind: text("kind", { enum: ["live", "reads"] }).notNull(),
    /** queued | running | succeeded | blocked (the check couldn't run, see blockedReason) | failed | cancelled */
    state: text("state", { enum: ["queued", "running", "succeeded", "blocked", "failed", "cancelled"] })
      .notNull()
      .default("queued"),
    /** manual: a person started it; journals: queued after a journal export or import (policy verify.reads.auto) */
    trigger: text("trigger", { enum: ["manual", "journals"] }).notNull(),
    /** The user who started it, or "system:<job>" */
    requestedBy: text("requested_by").notNull(),
    /** LiveCheckResult or ReadsCheckResult (src/server/verify/types.ts) */
    result: jsonb("result"),
    /** Why a blocked check couldn't run (BlockedReason) */
    blockedReason: text("blocked_reason"),
    /** Plain sentence for a blocked or failed check */
    message: text("message"),
    /** Task IDs of the investigations the check covered (reads only) */
    investigations: jsonb("investigations").$type<string[]>().notNull().default([]),
    investigationCount: integer("investigation_count").notNull().default(0),
    /** job_runs.id of the job that runs the check */
    jobRunId: uuid("job_run_id"),
    /** job_runs.id of the journal export or import that queued it (trigger journals) */
    triggeredByRunId: uuid("triggered_by_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("verification_runs_release_idx").on(t.spaceId, t.releaseId, t.kind, t.createdAt),
    index("verification_runs_space_idx").on(t.spaceId, t.createdAt),
  ],
);
