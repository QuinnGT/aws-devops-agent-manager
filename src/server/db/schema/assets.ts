import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentSpaces } from "./core";

/**
 * Asset browser tables.
 *
 * Change reasons added after the fact live in git notes (historyLayout.notesRef)
 * so they travel with the history repository. This table indexes them for the
 * timeline and for search; it can be rebuilt from the notes.
 */
export const assetReasons = pgTable(
  "asset_reasons",
  {
    /** Generated when the reason is requested, and written into the note as Reason-Id, so a retried job adds it once */
    id: uuid("id").primaryKey(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => agentSpaces.id, { onDelete: "cascade" }),
    assetId: text("asset_id").notNull(),
    /** History repository commit the note is attached to */
    commit: text("commit").notNull(),
    reason: text("reason").notNull(),
    /** Optional link, for example to an audit report */
    link: text("link"),
    notesRef: text("notes_ref").notNull(),
    addedBy: text("added_by").notNull(),
    jobRunId: uuid("job_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("asset_reasons_asset_idx").on(t.spaceId, t.assetId),
    index("asset_reasons_commit_idx").on(t.spaceId, t.commit),
    index("asset_reasons_search_idx").using("gin", sql`to_tsvector('simple', ${t.reason})`),
  ],
);
