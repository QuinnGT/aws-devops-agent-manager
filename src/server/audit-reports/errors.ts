/** A report action that can't be done, with a message for the person who asked. */
export class AuditReportError extends Error {
  constructor(
    message: string,
    readonly code: "not-found" | "read-only" | "invalid" | "not-ready" | "no-repo" | "output-rules" | "conflict" = "invalid",
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "AuditReportError";
  }
}
