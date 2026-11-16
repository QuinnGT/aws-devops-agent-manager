import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentSpaces } from "./core";

/**
 * Sync and history index tables.
 * The asset browser reads these; only the sync worker writes them.
 */

/** One row per asset the app has seen in a space (live or deleted). */
export const assetIndex = pgTable(
  "asset_index",
  {
    spaceId: uuid("space_id")
      .notNull()
      .references(() => agentSpaces.id, { onDelete: "cascade" }),
    assetId: text("asset_id").notNull(),
    assetType: text("asset_type").notNull(),
    /** Display name derived from metadata (name, agent_type, ...) */
    name: text("name").notNull(),
    /** For memories: the memory store's asset ID */
    parentAssetId: text("parent_asset_id"),
    liveVersion: integer("live_version"),
    liveUpdatedAt: timestamp("live_updated_at", { withTimezone: true }),
    lastSyncedVersion: integer("last_synced_version"),
    lastSyncedUpdatedAt: timestamp("last_synced_updated_at", { withTimezone: true }),
    /** Directory of this asset in the history repository, relative to the repo root */
    gitPath: text("git_path"),
    lastCommit: text("last_commit"),
    metadata: jsonb("metadata"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.assetId] }),
    index("asset_index_type_idx").on(t.spaceId, t.assetType),
  ],
);

/**
 * One row per change committed to git: a new service version, or a new
 * updatedAt on a version already recorded (metadata-only change such as the
 * Active switch), or a deletion.
 */
export const assetChanges = pgTable(
  "asset_changes",
  {
    spaceId: uuid("space_id")
      .notNull()
      .references(() => agentSpaces.id, { onDelete: "cascade" }),
    assetId: text("asset_id").notNull(),
    serviceVersion: integer("service_version").notNull(),
    serviceUpdatedAt: timestamp("service_updated_at", { withTimezone: true }).notNull(),
    changeKind: text("change_kind", { enum: ["created", "content", "metadata", "deleted", "baseline"] }).notNull(),
    commit: text("commit").notNull(),
    /** "app" | "console" | "cli" | "agent" | "unknown" (labels come from attribution policy) */
    changeSource: text("change_source").notNull().default("unknown"),
    changeSourceLabel: text("change_source_label"),
    principal: text("principal"),
    cloudTrailEventId: text("cloudtrail_event_id"),
    planId: text("plan_id"),
    /** How attribution matched: "clientToken" | "exact" | "window" | "none" | "error" */
    attributionMatchedBy: text("attribution_matched_by"),
    /** True when attribution was provisional (recent change, CloudTrail event may not be delivered yet); re-attribute later */
    attributionProvisional: boolean("attribution_provisional").notNull().default(false),
    /** Directory of the asset in the history repository at this change (it moves on renames) */
    gitPath: text("git_path"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.assetId, t.serviceVersion, t.serviceUpdatedAt] }),
    index("asset_changes_time_idx").on(t.spaceId, t.serviceUpdatedAt),
  ],
);

/** Sync cursor and status per space. */
export const syncState = pgTable("sync_state", {
  spaceId: uuid("space_id")
    .primaryKey()
    .references(() => agentSpaces.id, { onDelete: "cascade" }),
  /** Cursor for ListAssets updatedAfter */
  updatedAfter: timestamp("updated_after", { withTimezone: true }),
  lastSyncStartedAt: timestamp("last_sync_started_at", { withTimezone: true }),
  lastSyncCompletedAt: timestamp("last_sync_completed_at", { withTimezone: true }),
  lastReconcileAt: timestamp("last_reconcile_at", { withTimezone: true }),
  baselineCompletedAt: timestamp("baseline_completed_at", { withTimezone: true }),
  /** Last time the scheduler enqueued a sync of this space */
  lastEnqueuedAt: timestamp("last_enqueued_at", { withTimezone: true }),
  /** "never" | "running" | "succeeded" | "error" | "cancelled" */
  status: text("status").notNull().default("never"),
  error: text("error"),
  /** Counts from the last run (SyncResult) */
  lastResult: jsonb("last_result"),
});
