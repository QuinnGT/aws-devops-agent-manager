import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { CitationCheck, FindingValues, ReportDraft } from "@/server/audits/contract";
import { agentSpaces } from "./core";

/**
 * Journal audits.
 * audits-core writes audits, audit_items, evidence_docs, reviews and findings;
 * reports writes audits.report*; every model call lands in model_calls.
 * JSON column shapes are in src/server/audits/contract.ts.
 */

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
};

/** draft: inputs being chosen. running: analyzers and reviews in progress. reviewing: a person reviews findings. finalized: committed to git. */
export const AUDIT_STATES = ["draft", "running", "reviewing", "finalized", "cancelled"] as const;
export const AUDIT_ITEM_STATES = ["pending", "analyzing", "reviewing", "reviewed", "failed", "skipped"] as const;
export const REVIEW_STATES = ["running", "succeeded", "failed"] as const;
export const FINDING_STATES = ["proposed", "accepted", "rejected"] as const;

export const audits = pgTable(
  "audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => agentSpaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Key of policy audits.profiles */
    profileId: text("profile_id").notNull(),
    /** The profile as it was when the audit started, so a later policy edit does not change a running audit */
    profileSnapshot: jsonb("profile_snapshot").notNull(),
    /** LoadedPolicy.digest when the audit started */
    policyDigest: text("policy_digest").notNull(),
    state: text("state", { enum: AUDIT_STATES }).notNull().default("draft"),
    note: text("note"),
    /** job_runs.id of the latest audits.run job */
    runId: uuid("run_id"),
    /** Report narrative and section edits (ReportDraft); null until the report is first built */
    report: jsonb("report").$type<ReportDraft>(),
    reportUpdatedBy: text("report_updated_by"),
    reportUpdatedAt: timestamp("report_updated_at", { withTimezone: true }),
    /** Commit that added audit.json, findings.json and report.md */
    finalizedCommit: text("finalized_commit"),
    finalizedBy: text("finalized_by"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    ...timestamps,
  },
  (t) => [index("audits_space_idx").on(t.spaceId, t.createdAt), index("audits_state_idx").on(t.spaceId, t.state)],
);

/** One investigation in an audit. */
export const auditItems = pgTable(
  "audit_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    auditId: uuid("audit_id")
      .notNull()
      .references(() => audits.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id").notNull(),
    taskId: text("task_id").notNull(),
    incidentId: text("incident_id"),
    /** Profile cohort ("before", "after") for profiles that compare groups; null otherwise */
    cohort: text("cohort"),
    /** SHA-256 over the journal the audit read (analyzers bundleDigest), recorded in audit.json */
    journalSha256: text("journal_sha256"),
    state: text("state", { enum: AUDIT_ITEM_STATES }).notNull().default("pending"),
    /** Why the item failed or was skipped (missing ground truth, missing journal) */
    stateReason: text("state_reason"),
    /** The review whose findings are current */
    currentReviewId: uuid("current_review_id"),
    /** (audits-core) When the audit's analyzers last finished for this item; a pending item with this set waits for a review slot */
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
    /** (audits-core) Analyzers that failed on this item in the last run */
    analyzerErrors: jsonb("analyzer_errors").$type<{ analyzer: string; message: string }[]>().notNull().default(sql`'[]'::jsonb`),
    /** (audits-core) job_runs.id of the item's latest audits.review-item job */
    reviewJobRunId: uuid("review_job_run_id"),
    ...timestamps,
  },
  (t) => [uniqueIndex("audit_items_task_uq").on(t.auditId, t.taskId), index("audit_items_state_idx").on(t.auditId, t.state)],
);

/** Ground-truth documents per incident (actual RCA, scorecard). Kept per space so later audits reuse them. */
export const evidenceDocs = pgTable(
  "evidence_docs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => agentSpaces.id, { onDelete: "cascade" }),
    incidentId: text("incident_id").notNull(),
    /** Profile input kind, e.g. "actual_rca" or "scorecard" */
    kind: text("kind").notNull(),
    fileName: text("file_name").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    /** Document text (markdown); untrusted, render with SafeMarkdown */
    body: text("body").notNull(),
    /** Fields read with the profile's patterns, e.g. { score: "2/5" } */
    fields: jsonb("fields").$type<Record<string, string | null>>().notNull().default(sql`'{}'::jsonb`),
    uploadedBy: text("uploaded_by").notNull(),
    /** Replaced by a newer upload of the same incident and kind */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("evidence_docs_incident_idx").on(t.spaceId, t.incidentId, t.kind),
    uniqueIndex("evidence_docs_current_uq")
      .on(t.spaceId, t.incidentId, t.kind)
      .where(sql`${t.supersededAt} is null`),
  ],
);

/** One model review of one audit item. A rerun adds a row; audit_items.current_review_id names the one in use. */
export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    auditId: uuid("audit_id")
      .notNull()
      .references(() => audits.id, { onDelete: "cascade" }),
    auditItemId: uuid("audit_item_id")
      .notNull()
      .references(() => auditItems.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id").notNull(),
    runner: text("runner").notNull(),
    modelId: text("model_id").notNull(),
    /** SHA-256 over the system prompt, filled prompt and output schema */
    promptDigest: text("prompt_digest").notNull(),
    state: text("state", { enum: REVIEW_STATES }).notNull().default("running"),
    /** The structured output as returned (untrusted) */
    output: jsonb("output"),
    schemaValid: boolean("schema_valid"),
    schemaErrors: jsonb("schema_errors").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    citationCheck: jsonb("citation_check").$type<CitationCheck>(),
    error: text("error"),
    steps: integer("steps"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    durationMs: integer("duration_ms"),
    jobRunId: uuid("job_run_id"),
    startedBy: text("started_by").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("reviews_item_idx").on(t.auditItemId, t.startedAt), index("reviews_audit_idx").on(t.auditId)],
);

/** A finding extracted from a review by the profile's extractors. A person accepts, edits or rejects it. */
export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    auditId: uuid("audit_id")
      .notNull()
      .references(() => audits.id, { onDelete: "cascade" }),
    auditItemId: uuid("audit_item_id")
      .notNull()
      .references(() => auditItems.id, { onDelete: "cascade" }),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id").notNull(),
    incidentId: text("incident_id"),
    /** Extractor kind from the profile, e.g. "diagnosis" or "fix" */
    kind: text("kind").notNull(),
    /** Position within its kind in the review (0 for a "$" extractor) */
    ordinal: integer("ordinal").notNull(),
    title: text("title").notNull(),
    /** Values as the model proposed them */
    proposed: jsonb("proposed").$type<FindingValues>().notNull(),
    /** Values after a person's edits (equals proposed until edited) */
    current: jsonb("current").$type<FindingValues>().notNull(),
    /** Record citations for this finding, with their check result */
    citations: jsonb("citations").$type<CitationCheck["citations"]>().notNull().default(sql`'[]'::jsonb`),
    state: text("state", { enum: FINDING_STATES }).notNull().default("proposed"),
    edited: boolean("edited").notNull().default(false),
    reviewNote: text("review_note"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    /** (audits-core) The finding of an earlier review whose decision was carried to this one (same kind, position and proposed values) */
    carriedFromId: uuid("carried_from_id"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("findings_review_uq").on(t.reviewId, t.kind, t.ordinal),
    index("findings_audit_idx").on(t.auditId, t.kind, t.state),
    index("findings_space_state_idx").on(t.spaceId, t.state),
    index("findings_item_idx").on(t.auditItemId, t.reviewId),
  ],
);

/** One model call (review or report narrative): model, tokens, duration. */
export const modelCalls = pgTable(
  "model_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => agentSpaces.id, { onDelete: "cascade" }),
    auditId: uuid("audit_id"),
    reviewId: uuid("review_id"),
    /** "review" or "report-narrative" */
    purpose: text("purpose").notNull(),
    runner: text("runner").notNull(),
    modelId: text("model_id").notNull(),
    region: text("region").notNull(),
    steps: integer("steps"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    durationMs: integer("duration_ms").notNull(),
    /** Error text when the call failed */
    error: text("error"),
    actor: text("actor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("model_calls_space_idx").on(t.spaceId, t.createdAt), index("model_calls_audit_idx").on(t.auditId)],
);
