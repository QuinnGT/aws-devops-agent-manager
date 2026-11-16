/**
 * A request the audits module refuses, with a plain message the page can show
 * as is. `code` lets a Server Action pick the response:
 *   not-found      the audit, item or finding is not in this space
 *   invalid        the input is wrong (unknown task IDs, too many items, a bad value)
 *   state          the audit or finding is in a state that does not allow the action
 *   not-ready      the audit has items that are not ready to run (see `details`)
 *   confirm        the action would replace decisions a person made; repeat it with the confirmation flag
 */
export type AuditErrorCode = "not-found" | "invalid" | "state" | "not-ready" | "confirm";

export class AuditRequestError extends Error {
  constructor(
    readonly code: AuditErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AuditRequestError";
  }
}
