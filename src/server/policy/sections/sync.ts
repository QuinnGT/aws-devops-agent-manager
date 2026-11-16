import { z } from "zod";
import { defineSection } from "./define";

/** Commit policy for a memory store: every version, the last version of each UTC day, or nothing. */
export const storeCommitPolicySchema = z.enum(["every-version", "daily", "ignore"]);
export type StoreCommitPolicy = z.output<typeof storeCommitPolicySchema>;

const commitMessagesDefault = {
  created: "Add {assetType} {name} (version {version})",
  baseline: "Import {assetType} {name} at version {version}",
  content: "Update {assetType} {name} to version {version}",
  metadata: "Update metadata of {assetType} {name} (version {version})",
  deleted: "Delete {assetType} {name}",
  space: "Record space {spaceAlias}",
};

const reconcileDefault = { maxDeleteFraction: 0.5, guardMinAssets: 10, maxAgeHours: 25 };

/**
 * Defaults for change capture; per-space settings override the interval and
 * the store commit policies.
 */
export const syncSection = defineSection(
  "sync.yaml",
  z.object({
    /** Minutes between scheduled syncs of one space (space setting syncIntervalMinutes overrides) */
    intervalMinutes: z.number().int().min(1).default(15),
    /** Cron (UTC) for the full reconcile that finds deleted assets */
    reconcileCron: z.string().default("17 3 * * *"),
    /** Cron (UTC) for the scheduler tick that enqueues due syncs */
    tickCron: z.string().default("* * * * *"),
    /** Default per-store commit policy: every version, one commit per day, or ignore */
    defaultStoreCommitPolicy: storeCommitPolicySchema.default("every-version"),
    /** Commit policy overrides by memory store name (space setting storeCommitPolicies wins) */
    storeCommitPolicies: z.record(z.string(), storeCommitPolicySchema).default({}),
    committer: z
      .object({ name: z.string(), email: z.string() })
      .default({ name: "DevOps Agent Manager sync", email: "sync@devops-agent-manager.invalid" }),
    /** Domain of the synthetic author email used when the attributed principal has no email */
    syntheticEmailDomain: z.string().min(1).default("devops-agent-manager.invalid"),
    /** Seconds subtracted from the ListAssets updatedAfter cursor, to tolerate listing delay and clock skew */
    cursorOverlapSeconds: z.number().int().min(0).default(300),
    /** Parallel API calls within one sync */
    concurrency: z.number().int().min(1).max(32).default(4),
    /** Changes fetched, attributed and committed per batch (one attributeChanges call per batch) */
    batchSize: z.number().int().min(1).max(5000).default(100),
    /** Page size for ListAssetVersions */
    versionsPageSize: z.number().int().min(1).max(100).default(50),
    /** Fetch a version with GetAssetContent (one zip) when it has at least this many files; 0 always uses GetAssetFile */
    zipMinFiles: z.number().int().min(0).default(3),
    /** Seconds to wait for another sync or reconcile of the same space before giving up */
    lockWaitSeconds: z.number().int().min(0).default(300),
    reconcile: z
      .object({
        /** Refuse a reconcile that would delete more than this fraction of the live assets */
        maxDeleteFraction: z.number().min(0).max(1).default(reconcileDefault.maxDeleteFraction),
        /** The guard applies only when the space has at least this many live assets */
        guardMinAssets: z.number().int().min(1).default(reconcileDefault.guardMinAssets),
        /**
         * A sync that would be incremental runs as a reconcile when no reconcile has
         * run yet or the last one is older than this. The daily cron is missed while
         * the worker is down, and only a reconcile records deletions.
         */
        maxAgeHours: z.number().positive().default(reconcileDefault.maxAgeHours),
      })
      .default(reconcileDefault),
    /** Ordering of asset types when changes share a timestamp; unlisted types sort after these */
    typeOrder: z.array(z.string()).default(["memory_store", "agents_md", "skill", "custom_agent", "memory"]),
    /**
     * Commit subjects. Placeholders: {assetType} {typeLabel} {name} {version} {spaceAlias}.
     * Commit trailers carry the machine-readable details.
     */
    commitMessages: z
      .object({
        created: z.string().default(commitMessagesDefault.created),
        baseline: z.string().default(commitMessagesDefault.baseline),
        content: z.string().default(commitMessagesDefault.content),
        metadata: z.string().default(commitMessagesDefault.metadata),
        deleted: z.string().default(commitMessagesDefault.deleted),
        space: z.string().default(commitMessagesDefault.space),
      })
      .default(commitMessagesDefault),
  }),
);
