/**
 * What the report Server Actions return to the Report tab's client
 * components. `message` is a plain sentence for a page or field error;
 * `problems` lists the reasons a finalize was refused.
 */
export type ReportActionResult<T = unknown> = ({ ok: true } & T) | { ok: false; message: string; problems: string[] };

export interface ReportActions {
  build: (alias: string, auditId: string) => Promise<ReportActionResult>;
  saveNarrative: (alias: string, auditId: string, sectionId: string, text: string) => Promise<ReportActionResult>;
  approveNarrative: (alias: string, auditId: string, sectionId: string, text: string) => Promise<ReportActionResult>;
  setHidden: (alias: string, auditId: string, sectionId: string, hidden: boolean) => Promise<ReportActionResult>;
  draftNarrative: (alias: string, auditId: string, sectionId: string, replacePersonText: boolean) => Promise<ReportActionResult<{ runId: string }>>;
  finalize: (alias: string, auditId: string) => Promise<ReportActionResult<{ runId: string }>>;
}
