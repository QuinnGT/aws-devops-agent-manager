/**
 * Validation result shape shared by the validation engine, the package tools
 * and plans, revisions and the editor.
 */
export type ValidationLevel = "error" | "warning";

export interface ValidationResult {
  level: ValidationLevel;
  /** Stable, dotted machine code, for example "metadata.schema" or "package.stale-archive" */
  code: string;
  /** Plain message for the UI */
  message: string;
  /** `${assetType}:${key}` of the asset the result is about (see assetKeyOf) */
  assetKey?: string;
  /** File path (inside the asset or the package) or metadata path ("metadata.name") */
  path?: string;
  /** 1-based line and column in the file the result is about, when the check knows them */
  line?: number;
  column?: number;
  /** A safe change that resolves the result, which the editor can apply in one click */
  fix?: QuickFix;
}

/**
 * A one-click fix: edits applied in order to the file the result is about
 * (or `from`, a package path, when set). `replace-lines` replaces `count`
 * lines from `line` and applies only while they still read `expect`;
 * `rename` moves the file to the package path `to`. Pure data, so it can be
 * stored with build results and applied in the browser.
 */
export interface QuickFix {
  /** Button text, for example "Put the description in quotes" */
  label: string;
  from?: string;
  edits: ({ kind: "replace-lines"; line: number; count: number; expect: string; text: string } | { kind: "rename"; to: string })[];
}

export function hasErrors(results: readonly ValidationResult[]): boolean {
  return results.some((r) => r.level === "error");
}

export function errorsOf(results: readonly ValidationResult[]): ValidationResult[] {
  return results.filter((r) => r.level === "error");
}

export function warningsOf(results: readonly ValidationResult[]): ValidationResult[] {
  return results.filter((r) => r.level === "warning");
}

export function error(code: string, message: string, extra: Pick<ValidationResult, "assetKey" | "path" | "line" | "column" | "fix"> = {}): ValidationResult {
  return { level: "error", code, message, ...stripUndefined(extra) };
}

export function warning(code: string, message: string, extra: Pick<ValidationResult, "assetKey" | "path" | "line" | "column" | "fix"> = {}): ValidationResult {
  return { level: "warning", code, message, ...stripUndefined(extra) };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Thrown when input is rejected outright (for example an unsafe zip). */
export class ValidationFailure extends Error {
  constructor(
    message: string,
    readonly results: ValidationResult[],
  ) {
    super(message);
    this.name = "ValidationFailure";
  }
}
