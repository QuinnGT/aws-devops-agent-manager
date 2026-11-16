import { accessDeniedText, awsErrorKind, noCredentialsText } from "@/server/ai/error-kind";

/**
 * Why a review failed, from the reason stored on the item (audit_items.state_reason,
 * written by run.ts from the reviewer's error), so the audit pages can say it
 * in plain words and offer a rerun only when one can help. Pure; no
 * server-only imports, so pages and client components can use it.
 */

export const REVIEW_FAILURE_KINDS = [
  "no-credentials",
  "expired",
  "access-denied",
  "throttled",
  "network",
  "timeout",
  "step-limit",
  "schema",
  "model",
  "no-journal",
  "analyzers",
  "no-model",
  "interrupted",
  "other",
] as const;
export type ReviewFailureKind = (typeof REVIEW_FAILURE_KINDS)[number];

/** Kinds that need someone to fix the space's AWS access first. */
export const ACCESS_FAILURES: readonly ReviewFailureKind[] = ["no-credentials", "expired", "access-denied"];

export function reviewFailureKind(reason: string | null | undefined): ReviewFailureKind {
  const r = (reason ?? "").trim();
  if (!r) return "other";
  if (/journal is not in the journal cache/i.test(r)) return "no-journal";
  if (/analyzers could not run|analyzers have not run/i.test(r)) return "analyzers";
  if (/No review model is set/i.test(r)) return "no-model";
  const aws = awsErrorKind(r);
  if (aws !== "other") return aws;
  if (/step limit/i.test(r)) return "step-limit";
  if (/timed out after/i.test(r)) return "timeout";
  if (/schema|not valid JSON|no structured output|stopped without output/i.test(r)) return "schema";
  if (/stopped before this review finished|reviewer stopped with an error/i.test(r)) return "interrupted";
  if (/model call failed|model could not be set up/i.test(r)) return "model";
  return "other";
}

/**
 * Whether a rerun can fix this kind on its own: throttling, network, a slow or
 * wrong model answer. Missing or expired credentials need the connection
 * fixed first (`accessWorksNow` says the space's Bedrock check passes again);
 * refused access needs an IAM change the app can't see, so it is never offered.
 */
export function rerunCanHelp(kind: ReviewFailureKind, accessWorksNow = false): boolean {
  switch (kind) {
    case "no-credentials":
    case "expired":
      return accessWorksNow;
    case "access-denied":
    case "no-journal":
    case "analyzers":
    case "no-model":
      return false;
    default:
      return true;
  }
}

/** The plain sentence for a failure kind, without the incident. `canManage`: the reader is an Admin of the space. */
export function reviewFailureText(kind: ReviewFailureKind, o: { canManage: boolean; stepLimit: number; reason: string | null }): string {
  switch (kind) {
    case "no-credentials":
      return noCredentialsText(o.canManage);
    case "expired":
      return "The space's AWS credentials had expired, so the review couldn't call Amazon Bedrock. Refresh them, then rerun the review.";
    case "access-denied":
      return `${accessDeniedText("call the review model in Amazon Bedrock")} Ask your AWS admin to allow it.`;
    case "throttled":
      return "Amazon Bedrock was limiting requests, so the review stopped. Rerun it in a few minutes.";
    case "network":
      return "The app couldn't reach Amazon Bedrock, so the review stopped. Rerun it when the network is back.";
    case "timeout":
      return "The review took longer than the profile's time limit. Rerun it.";
    case "step-limit":
      return `The review stopped at the step limit (${o.stepLimit} steps) before it returned a result.`;
    case "schema":
      return "The model's answer didn't match the profile's output schema.";
    case "model":
      return "The model call failed.";
    case "no-journal":
      return "The investigation's journal is no longer in the journal cache.";
    case "analyzers":
      return "The analyzers couldn't run on this investigation.";
    case "no-model":
      return "No review model was set for this audit.";
    case "interrupted":
      return "The review stopped before it finished, for example because the worker restarted.";
    default:
      return "The review failed.";
  }
}

/** Whether the stored reason adds anything a support person needs (shown in Details only). */
export function failureDetail(kind: ReviewFailureKind, reason: string | null): string | null {
  const r = (reason ?? "").trim();
  if (!r) return null;
  return kind === "step-limit" || kind === "no-model" ? null : r;
}
