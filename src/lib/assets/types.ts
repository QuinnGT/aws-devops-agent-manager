/**
 * Canonical asset shapes shared by sync, the asset browser, package tools
 * and the write path.
 *
 * API facts (from test/fixtures/api/test-space):
 * - ListAssets / ListAssetVersions / ListAssetFiles return `items[]`.
 * - Asset: { assetId, assetType, metadata, version, createdAt, updatedAt }.
 *   Metadata keys are snake_case: name, description, status, agent_types,
 *   agent_type (agents_md), skill_type, memory_store_id (memory).
 * - GetAssetFile returns `file: { path, content: { text } | { bytes }, version, metadata: { mimeType } }`.
 * - GetAssetContent returns a zip (`content.zipFile`) of all files.
 * - A status-only UpdateAsset changes `updatedAt` of the current version in
 *   place without a new version number.
 */

export interface AssetFileSnapshot {
  /** Path inside the asset, forward slashes, e.g. "SKILL.md" or "references/x.md" */
  path: string;
  sha256: string;
  size: number;
  encoding: "utf8" | "base64";
  /** File content; omitted when the file is above the commit threshold */
  content?: string;
  mimeType?: string;
}

/** One service version of one asset, with its files. */
export interface AssetSnapshot {
  assetId: string;
  assetType: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  files: AssetFileSnapshot[];
}

/** Contents of asset.json in the history repository, next to the asset's files. */
export interface AssetJson {
  assetId: string;
  assetType: string;
  metadata: Record<string, unknown>;
  serviceVersion: number;
  serviceCreatedAt: string;
  serviceUpdatedAt: string;
  /** Every file of this version, including ones not committed because of size */
  files: { path: string; sha256: string; size: number; committed: boolean; mimeType?: string }[];
}

/** Commit trailer keys. */
export const TRAILERS = {
  assetId: "Asset-Id",
  assetType: "Asset-Type",
  serviceVersion: "Service-Version",
  serviceUpdatedAt: "Service-Updated-At",
  changeSource: "Change-Source",
  principal: "Principal",
  cloudTrailEventId: "CloudTrail-Event-Id",
  planId: "Plan-Id",
  spaceAlias: "Space",
} as const;

export type ChangeSource = "app" | "console" | "cli" | "agent" | "unknown";

/** Every change source, in the fixed order of the UI (design-system MASTER "Change sources"). */
export const CHANGE_SOURCES = ["agent", "console", "cli", "app", "unknown"] as const satisfies readonly ChangeSource[];

export type ChangeKind = "created" | "baseline" | "content" | "metadata" | "deleted";

/**
 * One recorded change for the change feed on Home and History: a row of
 * asset_changes joined to asset_index. `at` is the version's updatedAt (ISO).
 */
export interface FeedItem {
  assetId: string;
  assetType: string;
  name: string;
  /** Name of the parent asset (a memory's memory store), or null */
  parentName: string | null;
  version: number;
  kind: ChangeKind;
  source: ChangeSource;
  principal: string | null;
  at: string;
  /** History repository commit that recorded the change */
  commit: string;
  /** Attribution may still change (the CloudTrail event may not be delivered yet) */
  provisional: boolean;
  hasReason: boolean;
  /** Asset ID of the parent asset, or null */
  parentAssetId?: string | null;
  /** Long label recorded with the change (for example the role pattern's label), or null */
  sourceLabel?: string | null;
  /** Latest change reason added for the commit, or null */
  reason?: string | null;
  /** Commit of the asset's previous recorded change, for "Diff", or null */
  previousCommit?: string | null;
  /** Plan that applied the change, for changes made through this app, or null */
  planId?: string | null;
}
