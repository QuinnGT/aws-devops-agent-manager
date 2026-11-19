import type { Permission } from "@/server/policy/sections/roles";

/**
 * Audit reports: cross-incident summary, report, record.
 *
 *   loader.ts     loadAuditReport: the report page's data (needs audits.read)
 *   edit.ts       build, save or approve narrative text, hide or show a section (audits.run)
 *   jobs.ts       audit-reports.draft-narrative and audit-reports.finalize (audits.run)
 *   export.ts     the self-contained HTML export per audience (audits.read: an export is a read)
 *   page.ts       loadReportPage: the Report tab's data beyond the view (audits.read)
 *   sections.ts   computed sections (pure); view.ts the report view (pure)
 *   html.ts, report-md.ts, gate.ts, manifest.ts  renderers and checks (pure)
 */

/**
 * The permission each report action needs, for the pages, actions and
 * handlers. Export is a read, as journal exports are, so Viewers can export.
 */
export const REPORT_PERMISSIONS = {
  read: "audits.read",
  build: "audits.run",
  draftNarrative: "audits.run",
  edit: "audits.run",
  /** Approve the model's text in a narrative section for sharing */
  approve: "audits.run",
  export: "audits.read",
  finalize: "audits.run",
} as const satisfies Record<string, Permission>;

export { approveNarrativeInput, approveReportNarrative, buildAuditReport, saveReportNarrative, setReportSectionHidden, saveNarrativeInput, setSectionHiddenInput, reportRef } from "./edit";
export { AuditReportError } from "./errors";
export { checkAuditReportExport, exportAuditReport, exportReportInput, type CheckReportResult, type ExportReportResult } from "./export";
export type { ExportViolation } from "./gate";
export { finalizeAuditInput, prepareFinalizeAudit, type FinalizeAuditResult } from "./finalize";
export { requestDraftNarrative, requestFinalizeAudit } from "./jobs";
export { loadAuditReport } from "./loader";
export { NO_REPORT_MODEL_REASON, noReportModelReason, reportModelOf, type ReportModel } from "./model";
export { loadReportPage, type AudienceSummary, type ReportPage, type SectionDraftInfo } from "./page";
export { draftNarrativeInput } from "./narrative";
export { titleList, unapprovedNarratives } from "./view";
export type * from "./types";
