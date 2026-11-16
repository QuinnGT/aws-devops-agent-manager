/**
 * Implementation caps and fixed names for the releases module. They bound how
 * much one request reads from git; they are not policy rules
 * (those are in policy/releases.yaml).
 */
export const RELEASES = {
  /** Parallel git reads when scanning asset.json files or reading asset files */
  gitReadConcurrency: 4,
  /** Parallel version fetches from the service for files git doesn't hold */
  fetchConcurrency: 2,
  /** Commits read when looking for a version of one asset in git */
  maxAssetCommits: 500,
  /** Releases listed per space */
  maxListed: 500,
} as const;

/** Commit and tag trailers written by release commits (in addition to TRAILERS.spaceAlias and TRAILERS.planId). */
export const RELEASE_TRAILERS = {
  releaseId: "Release-Id",
  release: "Release",
  sourceCommit: "Source-Commit",
} as const;

/** Commit hashes accepted from forms: an abbreviated or full SHA-1 or SHA-256 hash. */
export const COMMIT_INPUT = /^[0-9a-f]{7,64}$/;

export function shortCommit(hash: string): string {
  return hash.slice(0, 12);
}
