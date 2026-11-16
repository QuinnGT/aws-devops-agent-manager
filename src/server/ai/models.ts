import type { AuditProfile } from "@/server/policy/sections/audits";
import type { AwsErrorKind } from "./error-kind";
import type { SpaceSettings } from "@/server/spaces/settings-schema";

/**
 * Which Bedrock model an audit uses. Nothing in
 * code or in the shipped policy names a model: a person picks it in the app.
 *
 * Resolution, first match wins:
 *   review model  the audit's own choice (New audit) -> the space default
 *                 (Space settings, "Model review") -> the profile's review.modelId
 *                 (only when a customer's policy sets one) -> none
 *   report model  the audit's own choice -> the space default -> the profile's
 *                 report.modelId -> the resolved review model
 * An audit with no review model can't start; the page says where to set one.
 */

/** Bedrock model ID, inference profile ID or ARN. Checked for shape only; Bedrock decides whether it exists. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.:/_-]{0,255}$/;

export function isModelId(v: unknown): v is string {
  return typeof v === "string" && MODEL_ID_PATTERN.test(v);
}

export type ModelSource = "audit" | "space" | "policy" | "review-model";

export interface ResolvedModel {
  id: string | null;
  source: ModelSource | null;
}

export interface AuditModelChoice {
  reviewModelId?: string | null;
  reportModelId?: string | null;
}

const pick = (...c: [string | null | undefined, ModelSource][]): ResolvedModel => {
  for (const [id, source] of c) if (id) return { id, source };
  return { id: null, source: null };
};

export function resolveAuditModels(
  profile: Pick<AuditProfile, "review" | "report">,
  settings: Pick<SpaceSettings, "inference"> | null | undefined,
  choice: AuditModelChoice = {},
): { review: ResolvedModel; report: ResolvedModel } {
  const review = pick([choice.reviewModelId, "audit"], [settings?.inference.reviewModelId, "space"], [profile.review.modelId, "policy"]);
  const report = pick([choice.reportModelId, "audit"], [settings?.inference.reportModelId, "space"], [profile.report.modelId, "policy"], [review.id, "review-model"]);
  return { review, report };
}

/** Plain text for where a model came from, for the audit page. */
export const MODEL_SOURCE_LABELS: Record<ModelSource, string> = {
  audit: "Chosen for this audit",
  space: "Space default",
  policy: "Set in the space's policy",
  "review-model": "Same as the review model",
};

export const NO_REVIEW_MODEL_REASON = "Choose a review model for this audit, or ask an Admin to set a default in Space settings.";

/** One model the space can call, for the model pickers. */
export interface ModelOption {
  /** What to store: inference profile ID or foundation model ID */
  id: string;
  /** Display name from Bedrock */
  label: string;
  kind: "inference-profile" | "foundation-model";
  provider: string | null;
  /** Bedrock's status for the profile or model, e.g. "ACTIVE" */
  status: string | null;
}

export interface ModelCatalog {
  region: string;
  models: ModelOption[];
  /** Plain reason the list could not be read (for example a missing IAM permission); the picker then accepts a typed ID */
  error: string | null;
  /** Machine-readable kind of the failure, null when the list was read */
  errorKind?: AwsErrorKind | null;
  /** For a muted Details line: the IAM actions that were refused, or the error name and message (credentials removed) */
  errorDetail?: string | null;
  fetchedAt: string;
}

/**
 * Lists the text models the space's read role can see in `region`:
 * `listModels(space, actor, region): Promise<ModelCatalog>` in
 * src/server/ai/catalog.ts (server only). It is not re-exported here: client
 * components reach this file through settings-schema.ts (MODEL_ID_PATTERN),
 * and a runtime re-export would pull the AWS SDK and node:fs into the browser
 * bundle. Keep this file free of server-only imports.
 */
