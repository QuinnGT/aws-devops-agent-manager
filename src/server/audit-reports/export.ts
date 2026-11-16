import { createHash } from "node:crypto";
import { z } from "zod";
import { recordAuditEvent } from "@/server/audit-log";
import type { Actor } from "@/server/aws/clients";
import { safeSegment } from "@/server/history/layout";
import { getSpaceById } from "@/server/spaces/queries";
import { AuditReportError } from "./errors";
import { checkExport, type ExportViolation } from "./gate";
import { renderReportHtml } from "./html";
import { loadReportContext } from "./loader";
import { EXPORT_ACTION } from "./queries";
import { AUDIENCES } from "./types";
import { unapprovedNarratives } from "./view";

/**
 * HTML export for one audience. Export is a read: the Route Handler checks
 * `audits.read` (REPORT_PERMISSIONS.export) for the space, calls
 * exportAuditReport with the signed-in user and sends `html` as a download,
 * or shows the violations. The output rules run over the export's text first;
 * a match whose severity the profile blocks on (report.exportBlockOn) refuses
 * the export. Every attempt records an audit event.
 */

export const exportReportInput = z.object({
  spaceId: z.string().uuid(),
  auditId: z.string().uuid(),
  audience: z.enum(AUDIENCES),
});

export type ExportReportInput = z.input<typeof exportReportInput>;

export type ExportReportResult =
  | {
      ok: true;
      fileName: string;
      contentType: "text/html; charset=utf-8";
      html: string;
      bytes: number;
      sha256: string;
      sections: string[];
      omitted: { id: string; reason: "empty-narrative" }[];
      /** Output-rule matches that don't block the export */
      warnings: ExportViolation[];
      stale: boolean;
      /** Narrative sections in the file whose model text nobody approved (shareable exports only) */
      unapproved: { id: string; title: string }[];
    }
  | { ok: false; reason: "output-rules"; violations: ExportViolation[]; warnings: ExportViolation[] };

export function exportFileName(spaceAlias: string, auditName: string, audience: string): string {
  return `${safeSegment(spaceAlias)}-${safeSegment(auditName).toLowerCase()}-${audience}.html`;
}

export async function exportAuditReport(input: ExportReportInput, actor: Actor, now = new Date()): Promise<ExportReportResult> {
  const parsed = exportReportInput.parse(input);
  const space = await getSpaceById(parsed.spaceId);
  if (!space) throw new AuditReportError("Space not found.", "not-found");
  const rc = await loadReportContext(space, parsed.auditId);
  if (!rc) throw new AuditReportError("Audit not found.", "not-found");
  const { view, profile, policy } = rc;

  const gate = checkExport(view, parsed.audience, policy.policy.outputRules, profile.report.exportBlockOn, now);
  const summary = (vs: ExportViolation[]) => vs.map((v) => ({ ruleId: v.ruleId, severity: v.severity, sectionId: v.sectionId, location: v.location }));
  const event = { actor, action: EXPORT_ACTION, spaceId: space.id, targetType: "audit", targetId: view.audit.id } as const;

  if (gate.blocking.length) {
    await recordAuditEvent({ ...event, result: "denied", details: { audience: parsed.audience, refused: "output-rules", violations: summary(gate.blocking), warnings: summary(gate.warnings) } });
    return { ok: false, reason: "output-rules", violations: gate.blocking, warnings: gate.warnings };
  }

  const rendered = renderReportHtml(view, parsed.audience, now);
  const bytes = Buffer.byteLength(rendered.html, "utf8");
  const sha256 = createHash("sha256").update(rendered.html).digest("hex");
  const fileName = exportFileName(space.alias, view.audit.name, parsed.audience);
  // The dialog warned before this export; the record says it went out unapproved.
  const unapproved = parsed.audience === "shareable" ? unapprovedNarratives(view, "shareable") : [];
  await recordAuditEvent({
    ...event,
    details: {
      audience: parsed.audience,
      fileName,
      bytes,
      sha256,
      sections: rendered.sections,
      omitted: rendered.omitted,
      warnings: summary(gate.warnings),
      stale: view.stale,
      ...(unapproved.length ? { unapprovedNarratives: unapproved.map((s) => s.id) } : {}),
    },
  });
  return {
    ok: true,
    fileName,
    contentType: "text/html; charset=utf-8",
    html: rendered.html,
    bytes,
    sha256,
    sections: rendered.sections,
    omitted: rendered.omitted,
    warnings: gate.warnings,
    stale: view.stale,
    unapproved,
  };
}

export type CheckReportResult = { ok: boolean; violations: ExportViolation[]; warnings: ExportViolation[]; excerptChars: number };

/**
 * The output-rules check of an export without building the file, so a page
 * can show what a refused export found. A read with no file produced, so no
 * audit event; the export itself records one.
 */
export async function checkAuditReportExport(input: ExportReportInput, now = new Date()): Promise<CheckReportResult> {
  const parsed = exportReportInput.parse(input);
  const space = await getSpaceById(parsed.spaceId);
  if (!space) throw new AuditReportError("Space not found.", "not-found");
  const rc = await loadReportContext(space, parsed.auditId);
  if (!rc) throw new AuditReportError("Audit not found.", "not-found");
  const gate = checkExport(rc.view, parsed.audience, rc.policy.policy.outputRules, rc.profile.report.exportBlockOn, now);
  return { ok: gate.blocking.length === 0, violations: gate.blocking, warnings: gate.warnings, excerptChars: rc.policy.policy.outputRules.excerptChars };
}
