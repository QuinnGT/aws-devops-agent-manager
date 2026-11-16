import type { Citation, ReportDraft } from "@/server/audits/contract";
import type { AuditProfile } from "@/server/policy/sections/audits";
import { compareIncidents, computeSection, incidentName } from "./sections";
import type { Audience, ExportRecord, FinalizeIssue, NarrativeContent, ReportAnalyzerRun, ReportCounts, ReportFinding, ReportInputs, ReportItem, ReportSectionView, ReportView } from "./types";

/**
 * The report view (pure): the profile's sections in order, each with its
 * audience, computed content or narrative, hidden flag and stale flag. The
 * loader (loader.ts) reads the rows; this file decides what counts.
 */

/** An audit row as the report reads it. */
export interface AuditRecord {
  id: string;
  spaceId: string;
  name: string;
  state: string;
  profileId: string;
  createdBy: string;
  createdAt: Date;
  report: ReportDraft | null;
  reportUpdatedBy: string | null;
  reportUpdatedAt: Date | null;
  finalizedCommit: string | null;
  finalizedBy: string | null;
  finalizedAt: Date | null;
}

/** A finding row in any state. */
export interface FindingRecord {
  id: string;
  auditItemId: string;
  reviewId: string;
  incidentId: string | null;
  kind: string;
  ordinal: number;
  title: string;
  current: Record<string, unknown>;
  /** Values as the model proposed them */
  proposed?: Record<string, unknown>;
  citations: Citation[];
  state: string;
  edited: boolean;
  reviewNote?: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  updatedAt?: Date | null;
}

/**
 * Findings that belong to the audit's current result: from the review named
 * by the item's current_review_id (any review when it is not set), of an
 * item that was not skipped.
 */
export function currentFindings(items: ReportItem[], findings: FindingRecord[]): (FindingRecord & { item: ReportItem })[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: (FindingRecord & { item: ReportItem })[] = [];
  for (const f of findings) {
    const item = byId.get(f.auditItemId);
    if (!item || item.state === "skipped") continue;
    if (item.currentReviewId && item.currentReviewId !== f.reviewId) continue;
    out.push({ ...f, item });
  }
  return out;
}

/** Accepted current findings, as the computed sections read them. Proposed and rejected findings never count. */
export function acceptedFindings(items: ReportItem[], findings: FindingRecord[]): ReportFinding[] {
  return currentFindings(items, findings)
    .filter((f) => f.state === "accepted")
    .map((f) => ({
      id: f.id,
      auditItemId: f.auditItemId,
      reviewId: f.reviewId,
      taskId: f.item.taskId,
      incidentId: f.incidentId ?? f.item.incidentId,
      kind: f.kind,
      ordinal: f.ordinal,
      title: f.title,
      values: f.current ?? {},
      citations: f.citations ?? [],
      edited: f.edited,
      reviewedBy: f.reviewedBy,
      reviewedAt: f.reviewedAt?.toISOString() ?? null,
    }));
}

export function reportCounts(items: ReportItem[], findings: FindingRecord[]): ReportCounts {
  const itemsByState: Record<string, number> = {};
  for (const i of items) itemsByState[i.state] = (itemsByState[i.state] ?? 0) + 1;
  const current = currentFindings(items, findings);
  const acceptedByKind: Record<string, number> = {};
  for (const f of current) if (f.state === "accepted") acceptedByKind[f.kind] = (acceptedByKind[f.kind] ?? 0) + 1;
  return {
    items: items.length,
    itemsByState,
    findings: {
      accepted: current.filter((f) => f.state === "accepted").length,
      rejected: current.filter((f) => f.state === "rejected").length,
      proposed: current.filter((f) => f.state === "proposed").length,
    },
    acceptedByKind,
  };
}

function listNames(names: string[], max = 5): string {
  const sorted = [...names].sort(compareIncidents);
  return sorted.length > max ? `${sorted.slice(0, max).join(", ")} and ${sorted.length - max} more` : sorted.join(", ");
}

/** Why the audit can't be finalized yet, as structured items; empty when it can. */
export function finalizeIssues(audit: Pick<AuditRecord, "state">, items: ReportItem[], findings: FindingRecord[]): FinalizeIssue[] {
  const issue = (code: FinalizeIssue["code"], message: string, count = 0, incidents: string[] = []): FinalizeIssue => ({ code, message, count, incidents });
  if (audit.state === "finalized") return [issue("finalized", "The audit is already finalized.")];
  if (audit.state === "cancelled") return [issue("cancelled", "The audit was cancelled.")];
  const out: FinalizeIssue[] = [];
  if (!items.length) out.push(issue("no-items", "The audit has no investigations."));
  const open = items.filter((i) => i.state !== "reviewed" && i.state !== "skipped");
  if (open.length) {
    const names = open.map(incidentName);
    out.push(issue("items-open", `${open.length === 1 ? "1 investigation is" : `${open.length} investigations are`} not reviewed or skipped yet: ${listNames(names)}.`, open.length, names.sort(compareIncidents)));
  }
  const proposed = currentFindings(items, findings).filter((f) => f.state === "proposed");
  if (proposed.length) {
    out.push(issue("proposed", `${proposed.length === 1 ? "1 finding is" : `${proposed.length} findings are`} still proposed. Accept or reject each one first.`, proposed.length));
  }
  return out;
}

/** Why the audit can't be finalized yet; empty when it can. */
export function finalizeProblems(audit: Pick<AuditRecord, "state">, items: ReportItem[], findings: FindingRecord[]): string[] {
  return finalizeIssues(audit, items, findings).map((i) => i.message);
}

/** Latest change that can alter the report's computed content. */
export function latestChange(dates: (Date | null | undefined)[]): Date | null {
  let max: Date | null = null;
  for (const d of dates) if (d && (!max || d > max)) max = d;
  return max;
}

export interface BuildViewInput {
  audit: AuditRecord;
  profile: AuditProfile;
  items: ReportItem[];
  /** Every finding of the audit, in any state */
  findings: FindingRecord[];
  evidence: ReportInputs["evidence"];
  analyzerRuns: Record<string, Record<string, ReportAnalyzerRun>>;
  outputSchema: unknown;
  /** Latest updated_at over the audit's findings and items */
  inputsChangedAt: Date | null;
  /** Export attempts from the audit log, any order */
  exports?: ExportRecord[];
}

type DraftSection = ReportDraft["sections"][number];

/** At or after `since`, or no decision has been made yet. Both are ISO times or dates on the clock buildTime() keeps ahead of row timestamps. */
function notBefore(iso: string | null | undefined, since: Date | null): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && (since === null || t >= since.getTime());
}

/**
 * Whether a narrative's model text has been checked. A person's text needs no approval. Model text needs a person
 * to approve it after the latest finding decision: text drafted before that
 * decision, or approved before it, needs approval again. Pure.
 */
export function narrativeCheck(
  source: "model" | "person" | null,
  edit: Pick<DraftSection, "draftedAt" | "approvedBy" | "approvedAt" | "updatedAt"> | undefined,
  inputsChangedAt: Date | null,
): Pick<NarrativeContent, "draftedAt" | "approved" | "needsApproval" | "draftedBeforeDecisions"> {
  if (source !== "model") return { draftedAt: null, approved: null, needsApproval: false, draftedBeforeDecisions: false };
  // Drafts saved before draftedAt existed fall back to the section's last change.
  const draftedAt = edit?.draftedAt ?? edit?.updatedAt ?? null;
  const approved = edit?.approvedBy && notBefore(edit.approvedAt, inputsChangedAt) ? { by: edit.approvedBy, at: edit.approvedAt! } : null;
  return {
    draftedAt,
    approved,
    needsApproval: approved === null,
    draftedBeforeDecisions: approved === null && draftedAt !== null && !notBefore(draftedAt, inputsChangedAt),
  };
}

/** Narrative sections an export for `audience` includes whose model text nobody has approved. */
export function unapprovedNarratives(view: Pick<ReportView, "sections">, audience: Audience): { id: string; title: string }[] {
  return sectionsFor(view, audience)
    .filter((s) => s.content.type === "narrative" && s.content.text !== null && s.content.needsApproval)
    .map((s) => ({ id: s.id, title: s.title }));
}

/** "Summary", "Summary and Outlook", "A, B and C". */
export function titleList(titles: readonly string[]): string {
  return titles.length <= 1 ? (titles[0] ?? "") : `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}

/** Finalize needs a person's text, or approved model text, in every shareable narrative it commits. */
export function unapprovedIssues(sections: ReportSectionView[]): FinalizeIssue[] {
  const list = unapprovedNarratives({ sections }, "shareable");
  if (!list.length) return [];
  const one = list.length === 1;
  const names = titleList(list.map((s) => s.title));
  return [
    {
      code: "unapproved-narrative",
      message: `${names} ${one ? "is" : "are"} the model's text, and nobody has approved ${one ? "it" : "them"} since the latest decisions. Approve ${one ? "it" : "them"} or write your own text first.`,
      count: list.length,
      incidents: [],
      sections: list,
    },
  ];
}

export function reportInputs(input: BuildViewInput): ReportInputs {
  return {
    profile: input.profile,
    items: input.items,
    findings: acceptedFindings(input.items, input.findings),
    evidence: input.evidence,
    analyzerRuns: input.analyzerRuns,
    outputSchema: input.outputSchema,
  };
}

export function buildReportView(input: BuildViewInput): ReportView {
  const { audit, profile } = input;
  const draft = audit.report;
  const inputs = reportInputs(input);
  const builtAt = draft?.builtAt ?? null;
  const stale = Boolean(builtAt && input.inputsChangedAt && input.inputsChangedAt.getTime() > Date.parse(builtAt));
  const edits = new Map((draft?.sections ?? []).map((s) => [s.id, s]));

  const sections: ReportSectionView[] = profile.report.sections.map((s) => {
    const edit = edits.get(s.id);
    const computed = computeSection(s, inputs);
    const text = edit?.narrative?.trim() ? edit.narrative : null;
    const source = text ? (edit?.narrativeSource ?? null) : null;
    return {
      id: s.id,
      title: s.title,
      kind: s.kind,
      audience: s.audience,
      hidden: edit?.hidden === true,
      stale: computed === null && text !== null && stale,
      updatedBy: edit?.updatedBy ?? null,
      updatedAt: edit?.updatedAt ?? null,
      content: computed ?? { type: "narrative", text, source, canDraft: Boolean(s.prompt), ...narrativeCheck(source, edit, input.inputsChangedAt) },
    };
  });

  const issues = [...finalizeIssues(audit, input.items, input.findings), ...(audit.state === "finalized" || audit.state === "cancelled" ? [] : unapprovedIssues(sections))];
  const problems = issues.map((i) => i.message);
  const builtMs = builtAt ? Date.parse(builtAt) : null;
  const changedSinceBuilt = builtMs === null ? 0 : input.findings.filter((f) => f.updatedAt && f.updatedAt.getTime() > builtMs).length;
  return {
    audit: {
      id: audit.id,
      spaceId: audit.spaceId,
      name: audit.name,
      state: audit.state,
      profileId: audit.profileId,
      profileLabel: profile.label,
      createdBy: audit.createdBy,
      createdAt: audit.createdAt.toISOString(),
      finalizedCommit: audit.finalizedCommit,
      finalizedBy: audit.finalizedBy,
      finalizedAt: audit.finalizedAt?.toISOString() ?? null,
    },
    title: profile.report.title,
    builtAt,
    inputsChangedAt: input.inputsChangedAt?.toISOString() ?? null,
    stale,
    changedSinceBuilt,
    lastExports: lastExports(input.exports ?? []),
    lastSuccessfulExports: lastExports((input.exports ?? []).filter((r) => r.result === "ok")),
    readOnly: audit.state === "finalized",
    updatedBy: audit.reportUpdatedBy,
    updatedAt: audit.reportUpdatedAt?.toISOString() ?? null,
    counts: reportCounts(input.items, input.findings),
    finalize: { allowed: problems.length === 0, problems, issues },
    sections,
  };
}

export function lastExports(records: ExportRecord[]): Record<Audience, ExportRecord | null> {
  const latest = (a: Audience) => records.filter((r) => r.audience === a).sort((x, y) => Date.parse(y.at) - Date.parse(x.at))[0] ?? null;
  return { internal: latest("internal"), shareable: latest("shareable") };
}

/** Sections an export or report.md includes: not hidden, and for the shareable audience only shareable ones. */
export function sectionsFor(view: Pick<ReportView, "sections">, audience: "internal" | "shareable"): ReportSectionView[] {
  return view.sections.filter((s) => !s.hidden && (audience === "internal" || s.audience === "shareable"));
}
