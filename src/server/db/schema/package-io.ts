import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentSpaces } from "./core";

/**
 * Package import tables.
 *
 * One row per uploaded package (zip or folder). The upload itself is stored
 * under DAM_DATA_DIR/package-imports until it expires (package-io.yaml
 * uploads.retentionDays); the mapping results stay in this row.
 */
export const packageImports = pgTable(
  "package_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => agentSpaces.id, { onDelete: "cascade" }),
    /** Uploaded file name or folder name, as the browser sent it (display only) */
    fileName: text("file_name").notNull(),
    /** "zip" | "folder" */
    source: text("source", { enum: ["zip", "folder"] }).notNull(),
    /** SHA-256 of the stored zip: the uploaded bytes for a zip, the app-written zip for a folder */
    sha256: text("sha256").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    /** Package layout name from package-layouts.yaml */
    layout: text("layout").notNull(),
    /** Package name: the zip's top folder, the folder name, or the file name */
    packageName: text("package_name"),
    /** "analyzed" | "rejected" | "failed" | "planning" | "planned" (ImportStatus in src/server/package-io/types.ts) */
    status: text("status", { enum: ["analyzed", "rejected", "failed", "planning", "planned"] }).notNull(),
    /** ImportSummary (counts per action and file role, error and warning counts) */
    mappingSummary: jsonb("mapping_summary"),
    /** ImportResults (items, file roles, validation, untouched live assets) */
    results: jsonb("results"),
    /** Plan created from this import (plans.id; no foreign key, the plans table belongs to the plans module) */
    planId: text("plan_id"),
    importedBy: text("imported_by").notNull(),
    plannedBy: text("planned_by"),
    /** Stored upload, relative to DAM_DATA_DIR/package-imports; null when nothing was stored */
    storedPath: text("stored_path"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
    plannedAt: timestamp("planned_at", { withTimezone: true }),
    /** When the stored upload is deleted */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** When the stored upload was deleted (expired) */
    fileDeletedAt: timestamp("file_deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("package_imports_space_idx").on(t.spaceId, t.createdAt),
    index("package_imports_sha_idx").on(t.spaceId, t.sha256),
    index("package_imports_expiry_idx").on(t.expiresAt),
  ],
);
