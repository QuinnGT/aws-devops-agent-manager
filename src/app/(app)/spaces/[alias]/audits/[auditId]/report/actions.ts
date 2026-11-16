"use server";

import { z } from "zod";
import type { ReportActionResult } from "@/components/audit-reports/action-state";
import {
  approveReportNarrative,
  AuditReportError,
  buildAuditReport,
  REPORT_PERMISSIONS,
  requestDraftNarrative,
  requestFinalizeAudit,
  saveReportNarrative,
  setReportSectionHidden,
} from "@/server/audit-reports";
import { AuthError, requirePermission } from "@/server/auth/dal";
import { actorOf } from "@/server/spaces/actor";
import { getSpaceByAlias } from "@/server/spaces/queries";

/**
 * Server Actions for the Report tab (pages/audit-report.md): find the space
 * by alias, check the permission for that space, parse the input with Zod,
 * then call the audit-reports service with the signed-in user. The service
 * looks the audit up within that space, so an audit ID from another space is
 * "not found". Everything here needs `audits.run`; export is a Route Handler
 * (audits.read).
 */

const NO_ACCESS = "You don't have permission to do this in this space.";
const ref = z.object({ alias: z.string().trim().min(1).max(200), auditId: z.string().uuid() });
const sectionId = z.string().min(1).max(200);

type Fail = Extract<ReportActionResult, { ok: false }>;
const fail = (message: string, problems: string[] = []): Fail => ({ ok: false, message, problems });

async function guarded<T>(alias: unknown, auditId: unknown, permission: (typeof REPORT_PERMISSIONS)[keyof typeof REPORT_PERMISSIONS], run: (ctx: { spaceId: string; auditId: string; actor: ReturnType<typeof actorOf> }) => Promise<T>): Promise<({ ok: true } & T) | Fail> {
  const parsed = ref.safeParse({ alias, auditId });
  if (!parsed.success) return fail("This audit doesn't exist in this space.");
  const space = await getSpaceByAlias(parsed.data.alias);
  if (!space) return fail(NO_ACCESS);
  try {
    const user = await requirePermission(permission, space.id);
    const out = await run({ spaceId: space.id, auditId: parsed.data.auditId, actor: actorOf(user) });
    return { ok: true, ...out };
  } catch (err) {
    if (err instanceof AuthError) return fail(err.status === 401 ? "Sign in again to continue." : NO_ACCESS);
    if (err instanceof AuditReportError) return fail(err.code === "not-found" ? "This audit doesn't exist in this space." : err.message, err.problems);
    if (err instanceof z.ZodError) return fail("Check what you entered and try again.");
    throw err;
  }
}

export async function buildReportAction(alias: string, auditId: string): Promise<ReportActionResult> {
  return guarded(alias, auditId, REPORT_PERMISSIONS.build, async ({ spaceId, auditId: id, actor }) => {
    await buildAuditReport({ spaceId, auditId: id }, actor);
    return {};
  });
}

export async function saveNarrativeAction(alias: string, auditId: string, section: string, text: string): Promise<ReportActionResult> {
  return guarded(alias, auditId, REPORT_PERMISSIONS.edit, async ({ spaceId, auditId: id, actor }) => {
    const input = z.object({ sectionId, text: z.string().max(1_000_000) }).parse({ sectionId: section, text });
    await saveReportNarrative({ spaceId, auditId: id, ...input }, actor);
    return {};
  });
}

/** Approve the model's text in a narrative section; `text` is the text the person read. */
export async function approveNarrativeAction(alias: string, auditId: string, section: string, text: string): Promise<ReportActionResult> {
  return guarded(alias, auditId, REPORT_PERMISSIONS.approve, async ({ spaceId, auditId: id, actor }) => {
    const input = z.object({ sectionId, text: z.string().max(1_000_000) }).parse({ sectionId: section, text });
    await approveReportNarrative({ spaceId, auditId: id, ...input }, actor);
    return {};
  });
}

export async function setSectionHiddenAction(alias: string, auditId: string, section: string, hidden: boolean): Promise<ReportActionResult> {
  return guarded(alias, auditId, REPORT_PERMISSIONS.edit, async ({ spaceId, auditId: id, actor }) => {
    const input = z.object({ sectionId, hidden: z.boolean() }).parse({ sectionId: section, hidden });
    await setReportSectionHidden({ spaceId, auditId: id, ...input }, actor);
    return {};
  });
}

export async function draftNarrativeAction(alias: string, auditId: string, section: string, replacePersonText: boolean): Promise<ReportActionResult<{ runId: string }>> {
  return guarded(alias, auditId, REPORT_PERMISSIONS.draftNarrative, async ({ spaceId, auditId: id, actor }) => {
    const input = z.object({ sectionId, replacePersonText: z.boolean() }).parse({ sectionId: section, replacePersonText });
    return requestDraftNarrative({ spaceId, auditId: id, sectionIds: [input.sectionId], replacePersonText: input.replacePersonText }, actor);
  });
}

export async function finalizeAuditAction(alias: string, auditId: string): Promise<ReportActionResult<{ runId: string }>> {
  return guarded(alias, auditId, REPORT_PERMISSIONS.finalize, async ({ spaceId, auditId: id, actor }) => requestFinalizeAudit({ spaceId, auditId: id }, actor));
}
