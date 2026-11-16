/**
 * What kind of failure an AWS call (or a stored error text) was, so pages can
 * say it in plain words and decide whether a retry can help. Pure and free of
 * server-only imports, so client components may use it.
 *
 *   no-credentials  the app has no credentials for the space (missing profile, empty chain)
 *   expired         the credentials were found but have expired
 *   access-denied   IAM refused the call
 *   throttled       AWS is limiting requests
 *   network         AWS could not be reached
 *   other           anything else
 */
export const AWS_ERROR_KINDS = ["no-credentials", "expired", "access-denied", "throttled", "network", "other"] as const;
export type AwsErrorKind = (typeof AWS_ERROR_KINDS)[number];

const ACCESS_DENIED = /AccessDenied|not authorized|UnauthorizedOperation|UnrecognizedClient/i;
const NO_CREDENTIALS = /CredentialsProviderError|Could not load credentials|Could not resolve credentials|Unable to locate credentials|Profile .* (?:could not be found|not found)|no AWS credentials/i;
const EXPIRED = /ExpiredToken|token (?:has )?expired|credentials (?:have )?expired|is expired/i;
const THROTTLED = /Throttling|TooManyRequests|Rate exceeded|ServiceQuotaExceeded|ServiceUnavailable/i;
const NETWORK = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|TimeoutError|socket hang up|getaddrinfo|NetworkingError/i;

function textOf(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return `${err.name} ${err.message}`;
  if (err && typeof err === "object" && "message" in err) return `${String((err as { name?: unknown }).name ?? "")} ${String((err as { message?: unknown }).message)}`;
  return String(err ?? "");
}

/** The kind of an error object or of a stored error text. Credentials are checked first: a missing profile is never "access denied". */
export function awsErrorKind(err: unknown): AwsErrorKind {
  const text = textOf(err);
  if (NO_CREDENTIALS.test(text)) return "no-credentials";
  if (EXPIRED.test(text)) return "expired";
  if (ACCESS_DENIED.test(text)) return "access-denied";
  if (THROTTLED.test(text)) return "throttled";
  if (NETWORK.test(text)) return "network";
  return "other";
}

/** The first IAM action an access-denied message names ("bedrock:InvokeModel"), for a Details line. */
export function deniedAction(err: unknown): string | null {
  return /\b([a-z0-9-]+:[A-Z][A-Za-z0-9]+)\b/.exec(textOf(err))?.[1] ?? null;
}

const MAX_DETAIL = 400;

/**
 * The error as one line for a muted Details disclosure: "Name: message", with
 * anything that looks like a credential removed. Never the main text.
 */
export function errorDetail(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  const raw = typeof err === "string" ? err : err instanceof Error ? err.message : String(err ?? "");
  const cleaned = raw
    .replace(/\b(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{12,}\b/g, "[redacted]")
    .replace(/(secret|token|signature|credential|authorization)(["'\s:=]+)[^\s"',;]+/gi, "$1$2[redacted]")
    .replace(/[A-Za-z0-9+/=_-]{60,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  const text = name && name !== "Error" && !cleaned.startsWith(name) ? `${name}: ${cleaned}` : cleaned;
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}...` : text;
}

/** First sentence when the app has no AWS credentials for the space (shared wording). */
export const NO_CREDENTIALS_SENTENCE = "This app has no AWS credentials for this space, so it can't reach AWS.";

/** The shared no-credentials text, with the next step for the reader's role. */
export function noCredentialsText(canManage: boolean): string {
  return `${NO_CREDENTIALS_SENTENCE} ${canManage ? "An Admin sets the connection in Space settings." : "Ask an Admin to check the connection in Space settings."}`;
}

/** "AWS refused the request: the space's read role isn't allowed to <what>." (shared wording; the IAM action goes in Details). */
export function accessDeniedText(what: string): string {
  return `AWS refused the request: the space's read role isn't allowed to ${what}.`;
}
