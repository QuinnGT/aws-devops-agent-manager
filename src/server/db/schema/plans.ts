import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { DesiredAsset } from "@/server/packages/types";
import type { PlanOrigin } from "@/server/plans/contract";
import { agentSpaces } from "./core";

/**
 * Drafts, plans, plan items and apply runs.
 * Every write to an Agent Space goes through a plan.
 * JSON column shapes are documented in src/server/plans/types.ts.
 */

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
};

export const DRAFT_STATUSES = ["open", "planned", "applied", "discarded"] as const;
export const DRAFT_ORIGINS = ["live", "committed", "new"] as const;
export const PLAN_STATES = ["checking", "ready", "waiting", "approved", "applying", "applied", "failed", "discarded"] as const;
export const ITEM_CHANGES = ["create", "content", "metadata", "status", "none", "delete"] as const;
export const ITEM_PROGRESS = ["waiting", "writing", "verifying", "done", "skipped", "failed"] as const;
export const APPLY_RUN_STATUSES = ["running", "succeeded", "failed"] as const;

/** An edited asset, saved in the app. It does not touch the space until a plan with it is applied. */
export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => agentSpaces.id, { onDelete: "cascade" }),
    assetType: text("asset_type").notNull(),
    /** The live asset the draft edits; null for a new asset */
    assetId: text("asset_id"),
    /** Identity key within the type (DesiredAsset.key) */
    assetKey: text("asset_key").notNull(),
    /** Display name */
    name: text("name").notNull(),
    /** Where the starting state came from: the live space, the last git commit, or a new asset */
    origin: text("origin", { enum: DRAFT_ORIGINS }).notNull(),
    /** Live version and updatedAt the draft was derived from; the plan check flags the item when live has moved past it */
    baseVersion: integer("base_version"),
    baseUpdatedAt: timestamp("base_updated_at", { withTimezone: true }),
    /** History repository commit the draft was read from (origin "committed") */
    baseCommit: text("base_commit"),
    /** Metadata at the base, to tell which keys the draft changed */
    baseMetadata: jsonb("base_metadata").$type<Record<string, unknown>>(),
    /** assetContentHash of the base files */
    baseContentHash: text("base_content_hash"),
    desired: jsonb("desired").$type<DesiredAsset>().notNull(),
    /** ValidationResult[] from the last save */
    validation: jsonb("validation").notNull().default(sql`'[]'::jsonb`),
    status: text("status", { enum: DRAFT_STATUSES }).notNull().default("open"),
    /** The plan the draft is in (status planned or applied) */
    planId: uuid("plan_id"),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    discardedBy: text("discarded_by"),
    discardedAt: timestamp("discarded_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("drafts_space_idx").on(t.spaceId, t.status, t.updatedAt),
    index("drafts_user_idx").on(t.spaceId, t.createdBy, t.status),
    // One open or planned draft per user and asset.
    uniqueIndex("drafts_open_asset_uq")
      .on(t.spaceId, t.assetId, t.createdBy)
      .where(sql`${t.assetId} is not null and ${t.status} in ('open', 'planned')`),
  ],
);

export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => agentSpaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    origin: jsonb("origin").$type<PlanOrigin>().notNull(),
    /** origin.kind, for filtering */
    originKind: text("origin_kind", { enum: ["drafts", "rollback", "package", "revision", "retry"] }).notNull(),
    state: text("state", { enum: PLAN_STATES }).notNull().default("checking"),
    /** Change reason; saved with the git commit and shown in History */
    reason: text("reason"),
    /** Plan-level notes from the caller (CreatePlanInput.notes), for things that are not items */
    notes: jsonb("notes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name"),
    /** job_runs.id of the latest live-space check */
    checkRunId: uuid("check_run_id"),
    checkRequestedBy: text("check_requested_by"),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    /** Why the last check could not finish (API error); the plan can't be applied until a check succeeds */
    checkError: text("check_error"),
    /** PlanSummary from the last check */
    summary: jsonb("summary"),
    /** Plan-level validation results (not tied to one item) */
    validation: jsonb("validation").notNull().default(sql`'[]'::jsonb`),
    approvalRequestedBy: text("approval_requested_by"),
    approvalRequestedAt: timestamp("approval_requested_at", { withTimezone: true }),
    approvedBy: text("approved_by"),
    approvedByName: text("approved_by_name"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedBy: text("rejected_by"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectNote: text("reject_note"),
    /** job_runs.id of the apply job */
    applyRunId: uuid("apply_run_id"),
    /** The user who started apply: the actor of the write calls and the commit author */
    applyStartedBy: text("apply_started_by"),
    applyStartedAt: timestamp("apply_started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** Last history commit written by the apply */
    resultCommit: text("result_commit"),
    discardedBy: text("discarded_by"),
    discardedAt: timestamp("discarded_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("plans_space_idx").on(t.spaceId, t.createdAt), index("plans_state_idx").on(t.spaceId, t.state)],
);

/** One asset in a plan. Its ID is the clientToken of the write calls (see plans/client-token.ts). */
export const planItems = pgTable(
  "plan_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** upsert: create or update to `desired`; delete: delete `assetId` */
    kind: text("kind", { enum: ["upsert", "delete"] }).notNull(),
    assetType: text("asset_type").notNull(),
    assetKey: text("asset_key").notNull(),
    name: text("name").notNull(),
    /** Target asset; set by the check when matched by identity, and by apply after a create */
    assetId: text("asset_id"),
    desired: jsonb("desired").$type<DesiredAsset>(),
    baseVersion: integer("base_version"),
    baseUpdatedAt: timestamp("base_updated_at", { withTimezone: true }),
    removeMetadataKeys: jsonb("remove_metadata_keys").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    note: text("note"),
    draftId: uuid("draft_id"),

    // ---- check results ----
    change: text("change", { enum: ITEM_CHANGES }),
    liveVersion: integer("live_version"),
    liveUpdatedAt: timestamp("live_updated_at", { withTimezone: true }),
    /** ItemConflict: live moved past the base, the asset is gone, or a same-name asset exists */
    conflict: jsonb("conflict"),
    /** ValueChange[] of live metadata against the metadata after apply */
    metadataDiff: jsonb("metadata_diff").notNull().default(sql`'[]'::jsonb`),
    /** FileDiff[] of live files against the planned files */
    contentDiff: jsonb("content_diff").notNull().default(sql`'[]'::jsonb`),
    addedLines: integer("added_lines").notNull().default(0),
    removedLines: integer("removed_lines").notNull().default(0),
    validation: jsonb("validation").notNull().default(sql`'[]'::jsonb`),
    validationStatus: text("validation_status", { enum: ["passed", "warnings", "failed"] }),
    /** SizeMeter of the instructions after the change (agents_md) */
    sizeMeter: jsonb("size_meter"),
    /** WriteStep[] chosen by the check */
    writeSteps: jsonb("write_steps").notNull().default(sql`'[]'::jsonb`),
    checkedAt: timestamp("checked_at", { withTimezone: true }),

    // ---- apply ----
    progress: text("progress", { enum: ITEM_PROGRESS }),
    progressMessage: text("progress_message"),
    /** Set before the first write call; a retried job re-sends the same clientTokens instead of re-checking live */
    writeStartedAt: timestamp("write_started_at", { withTimezone: true }),
    /** Live state just before the first write (what the history records as the app's starting point) */
    preWriteVersion: integer("pre_write_version"),
    preWriteUpdatedAt: timestamp("pre_write_updated_at", { withTimezone: true }),
    /** WriteState: the metadata sent and the live metadata before the write, fixed at the first attempt so a retry sends the same requests */
    writeState: jsonb("write_state"),
    writtenVersion: integer("written_version"),
    writtenUpdatedAt: timestamp("written_updated_at", { withTimezone: true }),
    /** ItemVerification */
    verification: jsonb("verification"),
    commit: text("commit"),
    ...timestamps,
  },
  (t) => [index("plan_items_plan_idx").on(t.planId, t.position)],
);

/** Results of one apply job (applies and rollbacks), per asset. */
export const applyRuns = pgTable(
  "apply_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id").notNull(),
    /** job_runs.id; a retried pg-boss job reuses its row */
    jobRunId: uuid("job_run_id"),
    startedBy: text("started_by").notNull(),
    status: text("status", { enum: APPLY_RUN_STATUSES }).notNull().default("running"),
    /** { written, skipped, failed, unchanged } */
    counts: jsonb("counts"),
    /** ApplyRunItem[] */
    items: jsonb("items").notNull().default(sql`'[]'::jsonb`),
    commits: jsonb("commits").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** HEAD of the history repository after the apply was recorded (offer "Create release" from it) */
    finalCommit: text("final_commit"),
    pushed: boolean("pushed").notNull().default(false),
    pushError: text("push_error"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("apply_runs_plan_idx").on(t.planId, t.startedAt), uniqueIndex("apply_runs_job_uq").on(t.jobRunId)],
);
