import type { ValidationResult } from "@/server/validation/types";

/**
 * A release or rollback request that can't go ahead, with a message for the
 * user, optional per-field messages (form fields) and the blocking problems.
 */
export class ReleaseError extends Error {
  constructor(
    message: string,
    readonly fieldErrors: Record<string, string> = {},
    readonly problems: ValidationResult[] = [],
  ) {
    super(message);
    this.name = "ReleaseError";
  }
}
