/** A rejected request with a message for the user and optional per-field messages. */
export class SpaceServiceError extends Error {
  constructor(
    message: string,
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "SpaceServiceError";
  }
}

/** The Postgres unique-violation constraint name, if `err` (or its cause) is one. */
export function uniqueViolation(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e && depth < 3; depth++) {
    const pg = e as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (pg.code === "23505") return typeof pg.constraint === "string" ? pg.constraint : "";
    e = pg.cause;
  }
  return null;
}
