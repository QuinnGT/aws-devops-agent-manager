import type { PackageValidationSummary } from "@/server/validation/package";
import type { ValidationResult } from "@/server/validation/types";

/**
 * Shapes of the revisions module (JSON columns of src/server/db/schema/revisions.ts
 * and the service results).
 */

/** What a revision's package was derived from. */
export type RevisionBase = (
  | {
      kind: "live";
      label: string;
      /** Started from a package import: its uploaded files are the revision's first save (changeId) */
      fromImport?: { importId: string; fileName: string; sha256: string; changeId: string };
    }
  | {
      kind: "release";
      releaseId: string;
      name: string;
      tag: string;
      /** The release commit (the manifest commit the tag points at) */
      commit: string;
      label: string;
      /** The revision whose plan produced the release; its non-asset files were carried over */
      fromRevisionId?: string | null;
    }
) & {
  /** Problems turning the assets into a package: assets the layout has no place for, files git doesn't hold */
  exportResults?: ValidationResult[];
};

/** Build and validation of one commit of a revision (checkPackage on the package at that commit). */
export interface RevisionBuild {
  status: "passed" | "failed";
  commit: string;
  ranAt: string;
  errors: number;
  warnings: number;
  /** Results in order (build and package checks, mapping, asset rules), capped at pages.maxResults */
  results: ValidationResult[];
  /** Results left out by the cap */
  omitted: number;
  /** The package checks' summary (VALIDATION.json shape) */
  validation: PackageValidationSummary | null;
  /** Package paths the build created or rewrote */
  buildPaths: string[];
  /** Assets the package maps to */
  assets: number;
}

export type RevisionErrorCode =
  | "bad-request"
  | "not-found"
  | "name-invalid"
  | "name-taken"
  | "no-history"
  | "unknown-release"
  | "unknown-layout"
  | "not-open"
  | "moved"
  | "finding-not-linkable"
  | "reason-required"
  | "nothing-changed"
  | "too-large"
  | "build-failed"
  | "plan-open"
  | "nothing-to-plan"
  | "export-blocked";

/** A revision request that can't go ahead, with a plain message, per-field messages and the blocking results. */
export class RevisionError extends Error {
  constructor(
    readonly code: RevisionErrorCode,
    message: string,
    readonly fieldErrors: Record<string, string> = {},
    readonly results: ValidationResult[] = [],
  ) {
    super(message);
    this.name = "RevisionError";
  }
}

/** One file write in a save: UTF-8 text or base64 bytes; content null deletes the file. */
export interface RevisionFileEdit {
  /** Package-relative path */
  path: string;
  encoding?: "utf8" | "base64";
  content: string | null;
}

/** The acting user: the email is the commit author and audit actor. */
export interface RevisionActor {
  email: string;
  name?: string | null;
}
