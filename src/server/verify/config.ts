import type { Permission } from "@/server/policy/sections/roles";
import type { BlockedReason, VerifyKind } from "./types";

/**
 * Implementation caps and fixed names for the verify module. They bound how
 * much one check reads; the policy rules are in policy/verify.yaml.
 */
export const VERIFY = {
  /** Parallel git reads when reading a release's files */
  gitReadConcurrency: 4,
  /** Commits read when looking for earlier and later versions of one asset */
  maxAssetCommits: 200,
  /** Verification runs listed per release and kind */
  maxListed: 20,
  /** Actor of checks queued after a journal export or import */
  autoActor: { email: "system:verify.reads" },
} as const;

export const VERIFY_QUEUES: Record<VerifyKind, string> = {
  live: "verify.live",
  reads: "verify.reads",
};

/** Reading the results needs history.read (like the release page); starting a check needs sync.run. */
export const VERIFY_PERMISSIONS = { read: "history.read", start: "sync.run" } as const satisfies Record<string, Permission>;

/** Audit log action recorded when a person starts a check. */
export const VERIFY_AUDIT_ACTION = "release.verify";

/** Why a check can't run, as one sentence for the release page. */
export const BLOCKED_MESSAGES: Record<BlockedReason, string> = {
  "no-repo": "This space has no history repository, so the release's files can't be read.",
  "not-cloned": "The history repository has no working copy yet. The first sync creates it.",
  "manifest-invalid": "The release's manifest can't be read.",
  "space-unreachable": "The app can't reach the space.",
  "sync-failed": "The sync before the check failed.",
  "sync-busy": "Another sync of this space is still running. Try again when it finishes.",
  "no-journals": "No investigations in the journal cache started after this release. Export or import journals first.",
  "no-files": "The release has no skill or memory files the check can compare.",
};
