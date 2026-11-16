import { MODEL_SOURCE_LABELS, type ModelSource } from "@/server/ai/models";
import type { AuditProfile } from "@/server/policy/sections/audits";
import type { SpaceSettings } from "@/server/spaces/settings-schema";

/**
 * Which model drafts an audit's narrative sections, and where it came from
 * (src/server/ai/models.ts). The audit's profile snapshot holds the resolved
 * IDs: createAudit writes the report model (the audit's choice, else the
 * space default, else the policy's) into report.modelId, and the narrative
 * job uses report.modelId, else review.modelId. The snapshot doesn't say which
 * of the three a report model came from, so this compares it with the space
 * default and the policy now. Pure.
 */

export interface ReportModel {
  id: string | null;
  source: ModelSource | null;
  /** MODEL_SOURCE_LABELS[source] */
  sourceLabel: string | null;
}

export function reportModelOf(
  snapshot: Pick<AuditProfile, "review" | "report">,
  settings: Pick<SpaceSettings, "inference"> | null | undefined,
  policyProfile: Pick<AuditProfile, "report"> | null | undefined,
): ReportModel {
  const done = (id: string | null, source: ModelSource | null): ReportModel => ({ id, source, sourceLabel: source ? MODEL_SOURCE_LABELS[source] : null });
  const id = snapshot.report.modelId;
  if (id) {
    if (settings?.inference.reportModelId === id) return done(id, "space");
    if (policyProfile?.report.modelId === id) return done(id, "policy");
    return done(id, "audit");
  }
  if (snapshot.review.modelId) return done(snapshot.review.modelId, "review-model");
  return done(null, null);
}

/** Why "Draft with the model" can't run when no model resolves. */
export const NO_REPORT_MODEL_REASON = "No model is set for this audit's report. Choose one on the audit, or ask an Admin to set a default in Space settings.";
