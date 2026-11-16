import { policyForSpace } from "@/server/journals/policy";
import { readPolicyFile, type LoadedPolicy } from "@/server/policy";
import { auditProfileSchema, type AuditProfile } from "@/server/policy/sections/audits";
import type { SpaceRow } from "@/server/spaces/queries";
import { AuditReportError } from "./errors";
import { getAuditInSpace, loadAuditData, loadExportRecords, type AuditData, type AuditRow } from "./queries";
import type { ReportView } from "./types";
import { buildReportView } from "./view";

/**
 * The report page loader (the page calls it after checking `audits.read`
 * for the space) and the shared context the other report services start from.
 */

/** The profile the audit ran with (audits.profile_snapshot). */
export function auditProfile(audit: Pick<AuditRow, "profileSnapshot">): AuditProfile {
  const parsed = auditProfileSchema.safeParse(audit.profileSnapshot);
  if (!parsed.success) throw new AuditReportError("The audit's profile snapshot can't be read.", "invalid");
  return parsed.data;
}

/** The review output schema, for the known values of enum fields; null when it is missing or not JSON. */
export function readOutputSchema(policy: LoadedPolicy, profile: AuditProfile): unknown {
  try {
    const text = readPolicyFile(policy.dirs, profile.review.outputSchema);
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

export interface ReportContext {
  audit: AuditRow;
  profile: AuditProfile;
  policy: LoadedPolicy;
  data: AuditData;
  view: ReportView;
}

/** Everything a report service needs, or null when the audit is not in the space. */
export async function loadReportContext(space: SpaceRow, auditId: string, policy?: LoadedPolicy): Promise<ReportContext | null> {
  const audit = await getAuditInSpace(space.id, auditId);
  if (!audit) return null;
  const profile = auditProfile(audit);
  const loaded = policy ?? (await policyForSpace(space));
  const data = await loadAuditData(audit);
  const view = buildReportView({
    audit,
    profile,
    items: data.items,
    findings: data.findings,
    evidence: data.evidence,
    analyzerRuns: data.analyzerRuns,
    outputSchema: readOutputSchema(loaded, profile),
    inputsChangedAt: data.inputsChangedAt,
    exports: await loadExportRecords(audit.spaceId, audit.id),
  });
  return { audit, profile, policy: loaded, data, view };
}

/** The report view for the audit page, or null when the audit is not in the space. */
export async function loadAuditReport(space: SpaceRow, auditId: string): Promise<ReportView | null> {
  return (await loadReportContext(space, auditId))?.view ?? null;
}
