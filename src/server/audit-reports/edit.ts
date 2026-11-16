import { z } from "zod";
import { recordAuditEvent } from "@/server/audit-log";
import type { Actor } from "@/server/aws/clients";
import { getSpaceById, type SpaceRow } from "@/server/spaces/queries";
import { AuditReportError } from "./errors";
import { auditProfile, loadReportContext } from "./loader";
import { buildTime, getAuditInSpace, latestInputChange, type AuditRow } from "./queries";
import { emptyDraft, patchSection, updateReportDraft } from "./store";
import type { ReportView } from "./types";

/**
 * A person's report edits (the model drafts only the narrative sections, and
 * a person edits them). Server Actions check
 * `audits.run` for the space, parse input with these schemas and call these
 * functions with the signed-in user. Each records an audit event.
 */

export const reportRef = z.object({ spaceId: z.string().uuid(), auditId: z.string().uuid() });
const sectionId = z.string().min(1).max(200);
export const saveNarrativeInput = reportRef.extend({ sectionId, text: z.string().max(1_000_000) });
export const setSectionHiddenInput = reportRef.extend({ sectionId, hidden: z.boolean() });
/** `text` is the model text the person read and approves; a newer draft is not approved by it. */
export const approveNarrativeInput = reportRef.extend({ sectionId, text: z.string().max(1_000_000) });

export type ReportRef = z.input<typeof reportRef>;

async function resolve(ref: ReportRef): Promise<{ space: SpaceRow; audit: AuditRow }> {
  const parsed = reportRef.parse(ref);
  const space = await getSpaceById(parsed.spaceId);
  if (!space) throw new AuditReportError("Space not found.", "not-found");
  const audit = await getAuditInSpace(space.id, parsed.auditId);
  if (!audit) throw new AuditReportError("Audit not found.", "not-found");
  if (audit.state === "finalized") throw new AuditReportError("This audit is finalized, so its report can't be changed.", "read-only");
  return { space, audit };
}

async function viewOf(space: SpaceRow, auditId: string): Promise<ReportView> {
  const ctx = await loadReportContext(space, auditId);
  if (!ctx) throw new AuditReportError("Audit not found.", "not-found");
  return ctx.view;
}

/**
 * Build (or rebuild) the report: create the draft on first use and set
 * builtAt to now, which clears the stale flag once a person has looked at
 * the changed findings. Narrative text is kept.
 */
export async function buildAuditReport(ref: ReportRef, actor: Actor): Promise<ReportView> {
  const { space, audit } = await resolve(ref);
  const now = buildTime(new Date(), await latestInputChange(audit.id));
  const { before } = await updateReportDraft(audit, actor, (d) => (d ? { ...d, builtAt: now.toISOString() } : emptyDraft(now)));
  await recordAuditEvent({
    actor,
    action: "audit.report.build",
    spaceId: space.id,
    targetType: "audit",
    targetId: audit.id,
    details: { builtAt: now.toISOString(), previousBuiltAt: before?.builtAt ?? null },
  });
  return viewOf(space, audit.id);
}

/** Save a person's text for a narrative section (source "person"). Empty text clears the section. */
export async function saveReportNarrative(input: z.input<typeof saveNarrativeInput>, actor: Actor): Promise<ReportView> {
  const parsed = saveNarrativeInput.parse(input);
  const { space, audit } = await resolve(parsed);
  const profile = auditProfile(audit);
  const section = profile.report.sections.find((s) => s.id === parsed.sectionId);
  if (!section) throw new AuditReportError(`The report has no section ${parsed.sectionId}.`, "invalid");
  if (section.kind !== "narrative") throw new AuditReportError(`${section.title} is computed from the findings and has no text to edit.`, "invalid");
  const text = parsed.text.trim();
  if (text.length > profile.report.narrativeMaxChars) {
    throw new AuditReportError(`Keep the text to ${profile.report.narrativeMaxChars} characters or fewer.`, "invalid");
  }
  const now = new Date();
  const firstBuild = audit.report ? now : buildTime(now, await latestInputChange(audit.id));
  const { before } = await updateReportDraft(audit, actor, (d) =>
    patchSection(
      d ?? emptyDraft(firstBuild),
      section.id,
      // A person's text needs no approval; any approval belonged to the model text it replaces.
      { ...(text ? { narrative: text, narrativeSource: "person" as const } : { narrative: null, narrativeSource: null }), draftedAt: null, approvedBy: null, approvedAt: null },
      { email: actor.email, at: now },
    ),
  );
  await recordAuditEvent({
    actor,
    action: "audit.report.narrative-save",
    spaceId: space.id,
    targetType: "audit",
    targetId: audit.id,
    details: { sectionId: section.id, chars: text.length, cleared: !text, previousSource: before?.sections.find((s) => s.id === section.id)?.narrativeSource ?? null },
  });
  return viewOf(space, audit.id);
}

/**
 * A person approves the model's text in a narrative section: they checked it
 * against the tables. Recorded with who and when; a later finding decision,
 * a new draft or a person's edit replaces it. The approval time is never
 * earlier than the latest finding change, so it counts for every decision
 * the person could see.
 */
export async function approveReportNarrative(input: z.input<typeof approveNarrativeInput>, actor: Actor): Promise<ReportView> {
  const parsed = approveNarrativeInput.parse(input);
  const { space, audit } = await resolve(parsed);
  const section = auditProfile(audit).report.sections.find((s) => s.id === parsed.sectionId);
  if (!section) throw new AuditReportError(`The report has no section ${parsed.sectionId}.`, "invalid");
  if (section.kind !== "narrative") throw new AuditReportError(`${section.title} is computed from the findings, so it has no text to approve.`, "invalid");
  const at = buildTime(new Date(), await latestInputChange(audit.id));
  let draftedAt: string | null = null;
  await updateReportDraft(audit, actor, (d) => {
    const current = d?.sections.find((s) => s.id === section.id);
    const text = current?.narrative?.trim() ? current.narrative : null;
    if (!d || !current || !text) throw new AuditReportError(`${section.title} has no text to approve yet.`, "invalid");
    if (current.narrativeSource !== "model") throw new AuditReportError(`${section.title} is a person's text, so it needs no approval.`, "invalid");
    if (text.trim() !== parsed.text.trim()) throw new AuditReportError(`The model redrafted ${section.title} after you opened the page. Read the new text, then approve it.`, "conflict");
    draftedAt = current.draftedAt ?? current.updatedAt ?? null;
    return patchSection(d, section.id, { approvedBy: actor.email, approvedAt: at.toISOString() }, { email: actor.email, at: new Date() });
  });
  await recordAuditEvent({
    actor,
    action: "audit.report.narrative-approve",
    spaceId: space.id,
    targetType: "audit",
    targetId: audit.id,
    details: { sectionId: section.id, approvedAt: at.toISOString(), draftedAt },
  });
  return viewOf(space, audit.id);
}

/** Hide a section from every export, or show it again. */
export async function setReportSectionHidden(input: z.input<typeof setSectionHiddenInput>, actor: Actor): Promise<ReportView> {
  const parsed = setSectionHiddenInput.parse(input);
  const { space, audit } = await resolve(parsed);
  const section = auditProfile(audit).report.sections.find((s) => s.id === parsed.sectionId);
  if (!section) throw new AuditReportError(`The report has no section ${parsed.sectionId}.`, "invalid");
  const now = new Date();
  const firstBuild = audit.report ? now : buildTime(now, await latestInputChange(audit.id));
  await updateReportDraft(audit, actor, (d) => patchSection(d ?? emptyDraft(firstBuild), section.id, { hidden: parsed.hidden }, { email: actor.email, at: now }));
  await recordAuditEvent({
    actor,
    action: parsed.hidden ? "audit.report.section-hide" : "audit.report.section-show",
    spaceId: space.id,
    targetType: "audit",
    targetId: audit.id,
    details: { sectionId: section.id },
  });
  return viewOf(space, audit.id);
}
