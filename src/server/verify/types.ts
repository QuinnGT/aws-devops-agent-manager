import type { LastChange, MetadataKeyChange } from "@/server/releases/views";

/**
 * Result shapes of the two release checks. Stored in verification_runs.result as JSON and read by the
 * release page's Verification section.
 */

export const VERIFY_KINDS = ["live", "reads"] as const;
export type VerifyKind = (typeof VERIFY_KINDS)[number];

export type VerifyState = "queued" | "running" | "succeeded" | "blocked" | "failed" | "cancelled";

/** Why a check couldn't run. */
export const BLOCKED_REASONS = ["no-repo", "not-cloned", "manifest-invalid", "space-unreachable", "sync-failed", "sync-busy", "no-journals", "no-files"] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

export interface ReleaseRef {
  id: string;
  name: string;
  /** The history commit whose assets the release lists */
  sourceCommit: string;
}

// ---------- check 1: live state ----------

/** How one asset of the release (or one added since) compares with the live space. */
export type LiveOutcome = "matches" | "changed" | "missing" | "added";

export const LIVE_OUTCOMES: readonly LiveOutcome[] = ["changed", "missing", "added", "matches"];

/** What changed on a "changed" asset; several can apply. */
export type LiveChange = "content" | "status" | "metadata" | "recreated";

export interface LiveRow {
  /** `${assetType}:${key}`, unique within the result */
  rowKey: string;
  assetType: string;
  typeLabel: string;
  name: string;
  parentName: string | null;
  outcome: LiveOutcome;
  changes: LiveChange[];
  /** The asset as the release lists it; null for an asset added since */
  release: { assetId: string; version: number; status: string | null; contentHash: string } | null;
  /** The live asset; null when it is missing */
  live: { assetId: string; version: number | null; status: string | null } | null;
  /** Live has a newer service version than the release (with the same content when the outcome is "matches") */
  newerVersion: boolean;
  /** Metadata keys that differ, other than the status key */
  metadataChanges: MetadataKeyChange[];
  /** The newest recorded change since the release, with who made it */
  lastChange: LastChange | null;
  /** Live has changes the history repository doesn't have yet (a store held back by its daily commit policy) */
  pendingSync: boolean;
}

export interface LiveCheckResult {
  release: ReleaseRef;
  /** The sync that ran first, or null when policy verify.live.syncFirst is off. `at`: when it finished (absent on older stored results) */
  sync: { mode: string; status: string; changes: number; commits: number; deleted: number; deferred: number; at?: string } | null;
  /** HEAD of the history repository the comparison read */
  headCommit: string | null;
  /** True when every release asset matches and nothing was added */
  matches: boolean;
  counts: Record<LiveOutcome, number>;
  /** Changed, missing and added first, then the assets that match */
  rows: LiveRow[];
}

// ---------- check 2: what the agent read ----------

/**
 * What one investigation got for one package file.
 *   release-body    a body that matches the release's file
 *   near-release    a body that nearly matches it (90% of lines on both sides) and no other version matches better
 *   older-body      a body that matches an earlier version of the file (the October 12 failure)
 *   newer-body      a body that matches a later version (the file changed after the release)
 *   other-body      a body that matches neither the release nor any version the history repository holds
 *   requested-no-body  the agent requested the deployed path, and the journal has no returned body for it
 *   not-requested   neither requested nor returned
 */
export const READ_OUTCOMES = ["older-body", "other-body", "newer-body", "release-body", "near-release", "requested-no-body", "not-requested"] as const;
export type ReadOutcome = (typeof READ_OUTCOMES)[number];

/** A file's verdict is the first outcome in READ_OUTCOMES that any investigation had: clear verdicts first, the October 12 failure (older-body) at the top. */
export type FileVerdict = ReadOutcome;

export interface RecordExample {
  taskId: string;
  incidentId: string | null;
  /** Journal record ID for the link (#rec-<recordId>); null when it could not be found */
  recordId: string | null;
  /** Record number in the investigation (the analyzer's numbering) */
  n: number | null;
  /** Version of the file the body matched, for older and newer bodies */
  version?: number | null;
}

export interface MatchedVersion {
  version: number;
  relation: "older" | "newer";
  /** History commit the version's content came from */
  commit: string;
}

export interface ReadsFileRow {
  /** `${assetType}:${name}:${path}`, unique within the result */
  rowKey: string;
  assetType: string;
  typeLabel: string;
  /** Asset ID and version in the release */
  assetId: string;
  releaseVersion: number;
  /** Display name: the skill or memory name */
  assetName: string;
  /** Memory store, for memories */
  store: string | null;
  /** File inside the asset */
  filePath: string;
  /** Path the agent requests (analyzer template) */
  deployedPath: string;
  verdict: FileVerdict;
  /** Investigations per outcome; they add up to `investigations` */
  counts: Record<ReadOutcome, number>;
  investigations: number;
  /** Investigations that requested the deployed path */
  requested: number;
  /** Versions the agent got instead of the release's, newest first */
  matchedVersions: MatchedVersion[];
  /** Lowest line shares seen for a body that isn't the release's (pkg: release lines found; ret: returned lines found) */
  worstShares: { pkg: number; ret: number } | null;
  /** First differing lines, from the analyzer (release only / deployed only) */
  releaseOnly: string[];
  deployedOnly: string[];
  /** Example records per outcome (at most verify.reads.examplesPerFile each) */
  examples: Partial<Record<ReadOutcome, RecordExample[]>>;
}

export interface SkippedAsset {
  assetId: string;
  assetType: string;
  name: string;
  /** not-compared: the analyzer has no deployed path for the type (instructions are part of the prompt); managed; inactive; not-in-git: content missing or not matching the manifest */
  reason: "not-compared" | "managed" | "inactive" | "not-in-git";
}

export interface ReadsCheckResult {
  release: ReleaseRef;
  /** The investigations considered: created in [from, to) */
  window: { mode: "release-created" | "content-live"; from: string; to: string | null; nextRelease: string | null };
  /** Investigations in the window, and how many the check read (policy verify.reads.maxInvestigations) */
  investigationsInWindow: number;
  investigations: number;
  /** Investigations whose journal could not be read */
  missing: string[];
  /** Analyzer errors per investigation */
  errors: { taskId: string; message: string }[];
  analyzer: { id: string; version: string; packageDigest: string };
  /**
   * failed: some file was read with a body that isn't the release's (older, other or newer).
   * passed: files were read with the release's body, and none with another.
   * inconclusive: no file body was returned in these journals.
   */
  verdict: "failed" | "passed" | "inconclusive";
  /** Files per verdict */
  counts: Record<FileVerdict, number>;
  /** In READ_OUTCOMES order of their verdict: older, other and newer bodies, the release's body, near matches, then requested without a body and not requested */
  files: ReadsFileRow[];
  /** Memory stores and how many investigations referenced them anywhere */
  stores: { store: string; referencedIn: number }[];
  skipped: SkippedAsset[];
}
