import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agentSpaces } from "./core";

/**
 * Releases.
 *
 * Git is the source of truth: each release is an annotated tag on a commit
 * that adds the manifest file. This table indexes them for the release pages
 * and can be rebuilt from the tags and manifest files.
 */
export const releases = pgTable(
  "releases",
  {
    /** Assigned when the release is requested and written into the commit and tag as Release-Id, so a retried job finishes the same release */
    id: uuid("id").primaryKey(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => agentSpaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Annotated tag name (historyLayout.releaseTag) */
    tag: text("tag").notNull(),
    /** The commit the tag points at: it adds the manifest file */
    commit: text("commit").notNull(),
    /** The commit whose assets the manifest lists (HEAD when the release was requested, or the commit of an apply) */
    sourceCommit: text("source_commit").notNull(),
    /** Path of the manifest file in the history repository (historyLayout.releaseManifest) */
    manifestPath: text("manifest_path").notNull(),
    /** The manifest as committed (ReleaseManifest, src/server/releases/manifest.ts) */
    manifest: jsonb("manifest").notNull(),
    assetCount: integer("asset_count").notNull(),
    note: text("note"),
    /** Set when the release was tagged after applying this plan */
    planId: text("plan_id"),
    createdBy: text("created_by").notNull(),
    jobRunId: uuid("job_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("releases_space_name_uq").on(t.spaceId, t.name),
    index("releases_space_created_idx").on(t.spaceId, t.createdAt),
  ],
);
