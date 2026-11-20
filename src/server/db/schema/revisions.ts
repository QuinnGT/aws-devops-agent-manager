import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { RevisionBase, RevisionBuild } from "@/server/revisions/types";
import { agentSpaces } from "./core";

/**
 * Revisions.
 * A revision is a branch in the space's history repository holding an
 * instruction package; each save is one commit and one revision_changes row.
 * JSON column shapes are in src/server/revisions/types.ts.
 */

/**
 * creating: the create job has not finished. open: saves allowed.
 * applied: a plan from it applied and its release was requested.
 * abandoned: closed by a person (the branch stays). failed: the create job failed.
 */
export const REVISION_STATES = ["creating", "open", "applied", "abandoned", "failed"] as const;
export const REVISION_BASE_KINDS = ["live", "release"] as const;

export const revisions = pgTable(
  "revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => agentSpaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Lowercased name when names are unique ignoring case (policy revisions.name.uniqueIgnoringCase), else the name */
    nameKey: text("name_key").notNull(),
    /** Branch in the history repository (historyLayout.revisionBranch) */
    branch: text("branch").notNull(),
    /** Package folder on the branch (historyLayout.packageDir) */
    packageDir: text("package_dir").notNull(),
    /** Package name (zip top folder) */
    packageName: text("package_name").notNull(),
    /** Layout from package-layouts.yaml */
    layout: text("layout").notNull(),
    baseKind: text("base_kind", { enum: REVISION_BASE_KINDS }).notNull(),
    /** "HEAD" for the live space, or the release ID */
    baseRef: text("base_ref").notNull(),
    /** RevisionBase: what the package was derived from (release name and tag, the history commit read) */
    base: jsonb("base").$type<RevisionBase>().notNull(),
    /** History commit the package was read from (default branch HEAD after the sync, or the release commit); null until created */
    baseCommit: text("base_commit"),
    /** First commit on the branch: the package as derived from the base. Diffs "against the base" start here */
    createdCommit: text("created_commit"),
    /** Branch head after the latest save */
    headCommit: text("head_commit"),
    state: text("state", { enum: REVISION_STATES }).notNull().default("creating"),
    stateReason: text("state_reason"),
    note: text("note"),
    /**
     * Audit findings sent to this revision and not yet linked by a save, in the order they were added.
     * A save that links a finding takes it off in the same transaction. The list holds IDs only: a finding
     * reopened or rejected on its audit stays here and the pages show it as no longer accepted.
     */
    toAddressFindingIds: jsonb("to_address_finding_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Build and validation of the head commit (RevisionBuild) */
    latestBuild: jsonb("latest_build").$type<RevisionBuild>(),
    /** job_runs.id of the create job and of the latest save */
    createRunId: uuid("create_run_id"),
    lastSaveRunId: uuid("last_save_run_id"),
    /** The latest plan made from the revision, and the head it was made from */
    planId: uuid("plan_id"),
    plannedCommit: text("planned_commit"),
    /** Set while a plan is being created from the revision, so a double submit makes one plan */
    planClaimedAt: timestamp("plan_claimed_at", { withTimezone: true }),
    /** Release requested after that plan applied, and the job that creates it */
    releaseId: uuid("release_id"),
    releaseName: text("release_name"),
    releaseRunId: uuid("release_run_id"),
    releaseError: text("release_error"),
    createdBy: text("created_by").notNull(),
    abandonedBy: text("abandoned_by"),
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("revisions_space_name_uq").on(t.spaceId, t.nameKey),
    index("revisions_space_idx").on(t.spaceId, t.state, t.updatedAt),
    index("revisions_plan_idx").on(t.planId),
  ],
);

/** One save of a revision: one commit on its branch. */
export const revisionChanges = pgTable(
  "revision_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => revisions.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id").notNull(),
    commit: text("commit").notNull(),
    parentCommit: text("parent_commit").notNull(),
    /** Package-relative paths the person wrote or deleted */
    changedPaths: jsonb("changed_paths").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Package-relative paths the build created or rewrote in the same commit (shared sections, indexes, skill zips, change record) */
    buildPaths: jsonb("build_paths").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    message: text("message").notNull(),
    /** Accepted, linkable findings of the same space */
    findingIds: jsonb("finding_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Why the change links no finding (policy revisions.save.unlinked) */
    unlinkedReason: text("unlinked_reason"),
    /** Whether the build and validation of this commit passed */
    buildStatus: text("build_status", { enum: ["passed", "failed"] }).notNull(),
    author: text("author").notNull(),
    authorName: text("author_name"),
    jobRunId: uuid("job_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("revision_changes_commit_uq").on(t.revisionId, t.commit), index("revision_changes_revision_idx").on(t.revisionId, t.createdAt)],
);
