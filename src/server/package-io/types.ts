import type { FileRole } from "@/server/packages/desired";
import type { Permission } from "@/server/policy";
import type { ValidationResult } from "@/server/validation/types";

/**
 * Shapes stored in package_imports (mapping_summary, results) and returned
 * to the pages. Plain JSON: no Buffers, no Maps.
 */

/** What applying the package would do to one asset. */
export type ImportAction = "create" | "update" | "unchanged";

export const IMPORT_ACTIONS: readonly ImportAction[] = ["create", "update", "unchanged"];

export const FILE_ROLES: readonly FileRole[] = ["asset", "build-artifact", "manifest", "non-asset", "skipped", "unmapped"];

export interface ImportItemFile {
  /** Path inside the asset */
  path: string;
  size: number;
  sha256: string;
  /** Package path the file came from */
  sourcePath?: string;
  /** Line count of a UTF-8 text file, as an editor shows it; absent for binary files */
  lines?: number;
}

/** One asset of the package, matched against the space by identity. */
export interface ImportItem {
  /** `${assetType}:${key}`, the assetKey of validation results */
  assetKey: string;
  assetType: string;
  /** Identity within the type (skill name, agent type, "<store>/<memory name>") */
  key: string;
  action: ImportAction;
  /** The live asset this item updates (update, unchanged); null for create */
  assetId: string | null;
  /** Live version from the asset index, for update and unchanged */
  liveVersion: number | null;
  /** Package path of the asset's main file or folder */
  source: string | null;
  /** Metadata from the package (before it is merged with the live metadata) */
  metadata: Record<string, unknown>;
  refs?: Record<string, string | string[]>;
  files: ImportItemFile[];
  /** assetContentHash and metadataHash of the state after apply (live metadata patched with the package's) */
  contentHash: string;
  metadataHash: string;
  /**
   * For update: what differs from the committed state. `committed` false
   * means the history repository had no committed state for the asset, so
   * it can't be compared and counts as an update.
   */
  changes: { content: boolean; metadataKeys: string[]; committed: boolean } | null;
  /**
   * For an update whose content changed: lines added and removed against the
   * committed files (text files only). Absent when it couldn't be compared.
   */
  diffStat?: { added: number; removed: number };
  /** Validation results about this asset */
  errors: number;
  warnings: number;
  /** The asset ID the package gives the asset (an Agent Space folder's descriptor) */
  sourceAssetId?: string;
  /** How the live asset was found: its source asset ID is live in the space, or a live asset has its identity */
  matchedBy?: "asset-id" | "identity";
}

/**
 * A package asset that is not planned: its type was not selected, or it
 * shares an identity with another package asset and the space doesn't hold
 * all their source asset IDs (layout `duplicates`).
 */
export interface LeftOutItem {
  assetKey: string;
  assetType: string;
  key: string;
  source: string | null;
  sourceAssetId: string | null;
  reason: "type-not-selected" | "duplicate" | "cannot-create";
  /** Plain sentence for the page and the plan notes */
  message: string;
  /** For duplicates: the key of the asset planned instead */
  keptKey: string | null;
}

/** How well one layout maps the upload (layout detection). */
export interface LayoutCandidate {
  layout: string;
  label: string;
  /** Package assets the layout finds */
  assets: number;
  /** Files that belong to an asset */
  assetFiles: number;
  /** Files no rule of the layout claims */
  unmappedFiles: number;
}

export interface ImportFileEntry {
  /** Package path (after the build step) */
  path: string;
  role: FileRole;
  /** assetKey of the asset the file belongs to (role asset) */
  assetKey: string | null;
  size: number;
  /** The build step created or rewrote this file (shared sections, indexes, skill zips) */
  build: "created" | "updated" | null;
}

/** A live asset the package doesn't mention. Import never deletes; it is listed and left alone. */
export interface UntouchedAsset {
  assetId: string;
  assetType: string;
  name: string;
}

export interface ImportCounts {
  create: number;
  update: number;
  unchanged: number;
  untouched: number;
  errors: number;
  warnings: number;
  /** Package assets left out (LeftOutItem); absent on imports analyzed before it existed */
  leftOut?: number;
}

/** package_imports.mapping_summary */
export interface ImportSummary {
  /** No validation errors (the plan can be created) */
  ok: boolean;
  packageName: string | null;
  assets: number;
  counts: ImportCounts;
  /** Files per role */
  roles: Record<FileRole, number>;
}

/** package_imports.results */
export interface ImportResults {
  items: ImportItem[];
  files: ImportFileEntry[];
  untouched: UntouchedAsset[];
  /** Package assets that are not planned, with the reason; absent on older imports */
  leftOut?: LeftOutItem[];
  /**
   * Every layout's fit for the upload, best first (layout detection), and
   * whether the import's layout was detected or chosen by the person who
   * uploaded it. Absent on older imports.
   */
  layouts?: LayoutCandidate[];
  layoutChoice?: "detected" | "chosen";
  /** Every validation result: read rejects, build and package checks, mapping, asset and set rules */
  validation: ValidationResult[];
  /** History repository commit the committed states were read from; null without a working copy */
  historyCommit: string | null;
  analyzedAt: string;
}

/**
 * analyzed: mapped, a plan can be created. rejected: the upload failed the
 * read checks (nothing stored). failed: the mapping threw (the upload is
 * stored; creating a plan maps it again). planning: a plan is being created.
 * planned: the plan exists (planId).
 */
export type ImportStatus = "analyzed" | "rejected" | "failed" | "planning" | "planned";

/**
 * Permissions the Server Actions and the download Route Handler check with
 * requirePermission before calling the service functions.
 */
export const PACKAGE_IO_PERMISSIONS = {
  /** Upload a package and see its mapping */
  import: "plans.create",
  /** Create a plan from an import */
  plan: "plans.create",
  /** Read the import list and an import's detail */
  read: "assets.read",
  /** Download the space as a package zip (pages/package-import.md, "Permissions") */
  export: "history.read",
} as const satisfies Record<string, Permission>;

/** A request the service refuses, with a plain message for the UI. */
export class PackageIoError extends Error {
  constructor(
    readonly code:
      | "not-found"
      | "bad-request"
      | "unknown-layout"
      | "upload-expired"
      | "upload-changed"
      | "already-planned"
      | "in-revision"
      | "not-plannable"
      | "nothing-to-plan"
      | "no-history"
      | "unknown-ref"
      | "checks-failed",
    message: string,
    readonly results: ValidationResult[] = [],
  ) {
    super(message);
    this.name = "PackageIoError";
  }
}
