/**
 * Read caps for the asset browser. They bound how much one web request reads
 * from git and the API; they are not service limits (those are in
 * policy/limits.yaml and policy/asset-types.yaml).
 */
export const ASSET_BROWSER = {
  /** Largest file rendered inline; larger files get a download link */
  maxInlineFileBytes: 1024 * 1024,
  /** Largest file the diff view compares line by line */
  maxDiffFileBytes: 512 * 1024,
  /** Milliseconds before a line diff gives up */
  diffTimeoutMs: 2000,
  /** Lines of context around each change in the diff view */
  diffContextLines: 3,
  /** Commits read for one asset's history */
  maxAssetCommits: 200,
  /** Rows per page on the space-wide timeline */
  timelinePageSize: 100,
  /** Versions read from ListAssetVersions for one asset */
  maxLiveVersions: 500,
  /** Seconds a ListAssetTypes result is reused per space */
  assetTypesCacheSeconds: 300,
  /** Parallel git processes when reading notes */
  gitReadConcurrency: 4,
  /** Longest change reason accepted */
  maxReasonChars: 2000,
} as const;

/**
 * Metadata and frontmatter keys the skill view reads. The asset guide names
 * them; keep them here so a renamed key is a one-line change.
 */
export const SKILL_KEYS = {
  agentTypes: "agent_types",
  enableTools: "enable_tools",
  skillType: "skill_type",
  status: "status",
} as const;

/** Asset IDs as the service issues them, used to spot references in custom agent metadata. */
export const ASSET_ID_PATTERN = /^ki-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Asset IDs and commit hashes accepted in URLs. */
export const URL_ASSET_ID = /^[A-Za-z0-9][\w.:-]{0,199}$/;
export const URL_COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
