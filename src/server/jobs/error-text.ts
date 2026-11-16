/**
 * Errors as plain sentences for the UI, and the raw text for a "Details"
 * disclosure. Jobs store "Name: message" (job_runs.error, plan check errors,
 * apply item messages); sync stores the message alone. Errors this app throws
 * on purpose already carry a sentence written for users, so only their
 * message is kept. AWS failures (no credentials, expired credentials, access
 * denied, throttling, the network) get the shared sentences below; any other
 * AWS SDK or runtime error gets a general sentence, and its own text goes in
 * Details. Nothing here names a role: pages add the caller's next step with
 * `connectionNextStep` when `needsSettings` is true.
 *
 * `liveErrorMessage`, `liveErrorNeedsSettings` and `connectionNextStep` in
 * `src/server/assets/live.ts` re-export the functions here, so every live
 * read, sync, connection test and job uses one wording.
 */

/** Error classes of this app whose messages are written for users. */
const APP_ERRORS = new Set([
  "AnalyzerRequestError",
  "AssetGoneError",
  "AuditReportError",
  "AuthError",
  "CancelledError",
  "ExportRequestError",
  "ImportRequestError",
  "MarkdownImportError",
  "PackageIoError",
  "PaginationLoopError",
  "PlanApplyError",
  "PlanCheckError",
  "PlanServiceError",
  "ReasonError",
  "ReleaseError",
  "SpaceServiceError",
  "SyncError",
  "TemplateError",
  "UnsafeZipError",
  "UploadBodyError",
  "WriteAccessError",
]);

/** What kind of AWS failure an error is, for wording and for callers that branch (rerun or not). */
export type AwsErrorKind = "no-credentials" | "expired" | "access-denied" | "throttled" | "network";

/** The shared sentences (w3d COMMON "Shared wording"). */
export const AWS_ERROR_TEXT = {
  "no-credentials": "This app has no AWS credentials for this space, so it can't reach AWS.",
  expired: "The AWS credentials for this space have expired or aren't valid. Refresh them (for example with aws sso login) and try again.",
  throttled: "AWS is limiting requests right now. Try again in a minute.",
  network: "Can't reach AWS right now: the network request failed. Try again in a minute.",
} as const;

/** Access denied, with the refused action in plain words (see `accessDeniedText`). */
export const ACCESS_DENIED_PREFIX = "AWS refused the request: ";

/** Any other AWS SDK error, when it has no message a user can act on. */
export const AWS_OTHER_TEXT = "The request to AWS failed. Try again, and if it keeps failing, give the details to whoever runs this app.";
/** A runtime error inside this app (a bug), never shown with its own text. */
export const APP_BUG_TEXT = "Something went wrong in this app. Try again, and if it keeps failing, give the details to whoever runs this app.";

/**
 * Matched on the error name or message (sync_state keeps only the message),
 * in this order. The patterns also match the sentences themselves (current
 * and older builds), so stored text maps to the current wording.
 */
const KINDS: { kind: AwsErrorKind; match: RegExp; settings: boolean }[] = [
  {
    kind: "no-credentials",
    match:
      /CredentialsProviderError|Could not (?:load|resolve) credentials|Unable to locate credentials|credential provider|Profile \S+ (?:could not be found|not found)|no AWS credentials|SSO session .*(?:not found|invalid)/i,
    settings: true,
  },
  {
    kind: "expired",
    match: /ExpiredToken|expired|UnrecognizedClientException|InvalidClientTokenId|security token included in the request is invalid|aren't valid\. Refresh them/i,
    settings: false,
  },
  {
    kind: "access-denied",
    match: /AccessDenied|not authorized|UnauthorizedOperation|the role this app uses doesn't allow|AWS refused the request/i,
    settings: true,
  },
  { kind: "throttled", match: /Throttling|TooManyRequests|Rate exceeded|limiting requests/i, settings: false },
  {
    kind: "network",
    // Case-sensitive: "ResourceNotFoundException" must not read as ENOTFOUND.
    match: /\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|TimeoutError|socket hang up|getaddrinfo|network request failed/,
    settings: false,
  },
];

/** AWS SDK and runtime error names that are not this app's own sentences. */
const NAMED = /^((?:[A-Z][A-Za-z0-9]*)?(?:Error|Exception|Fault)): ([\s\S]*)$/;
const SDK_NAME = /(?:Exception|Fault)$/;
/** Other AWS SDK exceptions with a sentence of their own, by name. */
const SDK_TEXT: [RegExp, string][] = [
  [/^(?:ResourceNotFound|NotFound|NoSuchEntity)Exception$/, "AWS couldn't find what the request asked for. It may have been deleted."],
  [/^ValidationException$/, "AWS refused the request as invalid."],
  [/^ConflictException$/, "AWS refused the request because something else changed it at the same time. Try again."],
  [/^(?:InternalServer|InternalFailure|ServiceUnavailable)(?:Exception|Fault)?$/, "AWS had a problem with the request. Try again in a minute."],
];
const RUNTIME_NAME = /^(?:TypeError|RangeError|ReferenceError|SyntaxError|EvalError|URIError|AggregateError|InternalError)$/;

function sentence(text: string): string {
  const t = text.trim();
  return !t || /[.!?)]$/.test(t) ? t : `${t}.`;
}

/** An error or stored error text as { name, message }. A stored "Name: message" keeps its name. */
function parts(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name === "Error" ? "" : err.name, message: err.message };
  const raw = String(err ?? "").trim();
  const m = NAMED.exec(raw);
  return m ? { name: m[1] === "Error" ? "" : m[1]!, message: m[2]! } : { name: "", message: raw };
}

function oneLine(text: string, max = 600): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Removes anything that looks like a credential from raw error text before it is shown in Details. Pure. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g, "[redacted]")
    .replace(/((?:secret|session)[_ -]?(?:access[_ -]?)?(?:key|token)|signature|authorization|x-amz-security-token)(["'\s:=]+)[^\s"',;]+/gi, "$1$2[redacted]")
    .replace(/[A-Za-z0-9+/=_-]{80,}/g, "[redacted]");
}

/** The kind of AWS failure, or null when the error is something else. Pure. */
export function awsErrorKind(err: unknown): AwsErrorKind | null {
  const { name, message } = parts(err);
  if (name && APP_ERRORS.has(name)) return null;
  return KINDS.find((k) => k.match.test(name) || k.match.test(message))?.kind ?? null;
}

/** "ListAssetVersions" as "list asset versions", for the access-denied sentence. Pure. */
function actionWords(service: string, action: string): string {
  if (service === "sts" && action === "AssumeRole") return "";
  if (/^InvokeModel/.test(action) || action === "Converse" || action === "ConverseStream") return "call the model";
  const words = action
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(" ");
  if (words[0] === "get") words[0] = "read";
  if (words[0] === "lookup") words.splice(0, 1, "look", "up");
  return words.join(" ");
}

/** The IAM action an access-denied message names ("aidevops:ListAssets"), or null. Pure. */
export function deniedAction(err: unknown): string | null {
  const { message } = parts(err);
  const m = /perform:?\s+([a-z0-9-]+):([A-Za-z0-9*]+)/.exec(message) ?? /\b(?:action|operation)[:\s]+([a-z0-9-]+):([A-Za-z0-9]+)/i.exec(message);
  return m ? `${m[1]}:${m[2]}` : null;
}

/**
 * "AWS refused the request: the space's read role isn't allowed to list
 * assets." The IAM action itself goes in Details. `role` is the role the
 * request used (read unless a plan is being applied). Pure.
 */
export function accessDeniedText(err: unknown, role: "read" | "write" = "read"): string {
  const action = deniedAction(err);
  const [service, name] = action ? (action.split(":") as [string, string]) : ["", ""];
  if (service === "sts" && name === "AssumeRole") return `${ACCESS_DENIED_PREFIX}this app's AWS credentials aren't allowed to assume the space's ${role} role.`;
  const what = action ? actionWords(service, name) : "";
  return `${ACCESS_DENIED_PREFIX}the space's ${role} role isn't allowed to ${what || "make this call"}.`;
}

/** Short, credential-free sentence for any error from a live read, sync or job (not this app's own errors). Pure. */
export function liveErrorMessage(err: unknown): string {
  const { name, message } = parts(err);
  const kind = awsErrorKind(err);
  if (kind === "access-denied") {
    // An older stored sentence keeps its wording when it already is the current one.
    return message.startsWith(ACCESS_DENIED_PREFIX) ? sentence(oneLine(message, 300)) : accessDeniedText(err);
  }
  if (kind) return AWS_ERROR_TEXT[kind];
  if (name && SDK_NAME.test(name)) return SDK_TEXT.find(([re]) => re.test(name))?.[1] ?? AWS_OTHER_TEXT;
  if (name && RUNTIME_NAME.test(name)) return APP_BUG_TEXT;
  const raw = oneLine(message, 300);
  return name && !APP_ERRORS.has(name) ? `${name}: ${raw}` : raw;
}

/** True when the failure (an error or stored error text) is one an Admin fixes in Space settings. Pure. */
export function liveErrorNeedsSettings(err: unknown): boolean {
  const kind = awsErrorKind(err);
  return KINDS.some((k) => k.kind === kind && k.settings);
}

/**
 * The next step after a failure that `liveErrorNeedsSettings` reports, worded
 * for the caller: Admins are sent to Space settings (or told what to change
 * when they are already there), everyone else to an Admin.
 */
export function connectionNextStep(o: { canManage: boolean; onSettingsPage?: boolean }): string {
  if (o.canManage && o.onSettingsPage) return "Enter an AWS profile or a read role ARN under Connection and roles, save, then test the connection again.";
  if (o.canManage) return "An Admin sets the connection in Space settings.";
  return "Ask an Admin to check the connection in Space settings.";
}

/** The error class name of a stored "Name: message" error, or null. Pure. */
export function storedErrorName(raw: string): string | null {
  return NAMED.exec(raw.trim())?.[1] ?? null;
}

/** True when the stored error is one of this app's own errors (a rule or state problem, not a failed live read). Pure. */
export function isAppError(raw: string): boolean {
  const name = storedErrorName(raw);
  return name !== null && APP_ERRORS.has(name);
}

/** A stored error as a plain sentence; null for no error. Pure. */
export function plainErrorText(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const m = NAMED.exec(raw.trim());
  if (m && APP_ERRORS.has(m[1]!)) return sentence(m[2]!);
  return sentence(liveErrorMessage(raw.trim()));
}

/** An error object (thrown in this process) as a plain sentence. Pure. */
export function plainErrorOf(err: unknown): string {
  if (err instanceof Error && APP_ERRORS.has(err.name)) return sentence(err.message);
  return sentence(liveErrorMessage(err));
}

/**
 * The raw error for a muted "Details" disclosure, for support: the IAM action
 * when access was denied, then the error's own text with anything that looks
 * like a credential removed. Null when there is nothing to add to the plain
 * sentence (no error, this app's own sentence, or text that already is it). Pure.
 */
export function errorDetails(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = raw instanceof Error ? (raw.name && raw.name !== "Error" ? `${raw.name}: ${raw.message}` : raw.message) : String(raw);
  if (!text.trim()) return null;
  const { name } = parts(raw);
  if (name && APP_ERRORS.has(name)) return null;
  const plain = liveErrorMessage(raw);
  const shown = oneLine(redactSecrets(text));
  if (sentence(shown) === sentence(plain)) return null;
  // An older build's stored sentence carries no more than the current one.
  if (/^(?:Can't reach the Agent Space|The Agent Space (?:refused|is limiting))/.test(shown)) return null;
  const action = awsErrorKind(raw) === "access-denied" ? deniedAction(raw) : null;
  return action ? `IAM action ${action}. ${shown}` : shown;
}
