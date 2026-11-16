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

export function error(code: string, message: string, extra: Pick<ValidationResult, "assetKey" | "path"> = {}): ValidationResult {
  return { level: "error", code, message, ...stripUndefined(extra) };
}

export function warning(code: string, message: string, extra: Pick<ValidationResult, "assetKey" | "path"> = {}): ValidationResult {
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
