import type { Audience, AudienceSummary, CountRow, ExportViolation, FinalizeIssue } from "@/server/audit-reports";
import type { PushPlan, SavedRecord } from "@/server/audit-reports/record";

/**
 * Words for the Report tab (pages/audit-report.md), kept pure so they are
 * unit-tested. Labels that are configuration (section titles, column headers,
 * finding kind labels) come from the audit's profile, never from here.
 */

export const AUDIENCE_LABELS: Record<Audience, string> = { shareable: "Shareable", internal: "Internal" };

/** The export card's order: shareable first, the default. */
export const AUDIENCE_ORDER: readonly Audience[] = ["shareable", "internal"];

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Plural of a finding kind label, lower case: Diagnosis -> diagnoses, Fix -> fixes, Issue -> issues. */
export function pluralLabel(label: string): string {
  const l = label.trim().toLowerCase();
  if (/sis$/.test(l)) return l.replace(/sis$/, "ses");
  if (/(s|x|z|ch|sh)$/.test(l)) return `${l}es`;
  if (/[^aeiou]y$/.test(l)) return l.replace(/y$/, "ies");
  return `${l}s`;
}

/** "1 accepted diagnosis", "16 accepted diagnoses". */
export function acceptedCount(n: number, label: string): string {
  return `${n} accepted ${n === 1 ? label.trim().toLowerCase() : pluralLabel(label)}`;
}

export interface KindLabel {
  kind: string;
  label: string;
  /** The extractor makes one finding per investigation ("$") */
  perInvestigation: boolean;
}

/** The help line above the sections. */
export function builtFromText(acceptedByKind: Record<string, number>, kinds: readonly KindLabel[], proposed: number): string {
  const parts = kinds.map((k) => acceptedCount(acceptedByKind[k.kind] ?? 0, k.label));
  const built = parts.length ? `Built from ${joinNames(parts)}.` : "Built from the accepted findings.";
  const pending = proposed === 0 ? "" : proposed === 1 ? " The 1 proposed finding counts once you accept it." : ` The ${proposed} proposed findings count once you accept them.`;
  return `${built}${pending} Sections appear in the profile's order.`;
}

/** The count column of a count table: "Incidents" when each investigation has one finding of the kind, else the kind's plural ("Fixes"). */
export function countHeader(kind: KindLabel | undefined): string {
  if (!kind) return "Count";
  if (kind.perInvestigation) return "Incidents";
  const p = pluralLabel(kind.label);
  return p.charAt(0).toUpperCase() + p.slice(1);
}

/** Share of `total`, as a whole percentage. */
export function shareText(count: number, total: number): string {
  return total > 0 ? `${Math.round((count / total) * 100)}%` : "0%";
}

/** Count rows the page shows: values with findings, by count then label. Rows with no findings stay in the export. */
export function shownCountRows(rows: readonly CountRow[]): CountRow[] {
  return rows.filter((r) => r.count > 0).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** The audience card's help text. */
export function audienceHelp(audience: Audience, s: AudienceSummary): string {
  const n = `${s.sections} ${s.sections === 1 ? "section" : "sections"}`;
  const empty = s.emptyLeftOut.length ? ` ${joinNames(s.emptyLeftOut)} ${s.emptyLeftOut.length === 1 ? "has" : "have"} no text yet, so ${s.emptyLeftOut.length === 1 ? "it is" : "they are"} left out.` : "";
  if (audience === "internal") return `${n}, internal ones marked.${empty}`;
  const internal = s.internalLeftOut.length ? ` Leaves out ${joinNames(s.internalLeftOut)}, which ${s.internalLeftOut.length === 1 ? "is" : "are"} internal.` : "";
  return `${n}.${internal}${empty}`;
}

/** "2 output rule errors". */
export function ruleErrorsText(n: number): string {
  return `${n} output rule ${n === 1 ? "error" : "errors"}`;
}

/** "Exported with 1 warning". */
export function warningsText(n: number): string {
  return `${n} ${n === 1 ? "warning" : "warnings"}`;
}

/** Where an output-rule match is: "Fixes, row 12", "Summary, paragraph 2", "Incidents, INCIDENT-31808", "Report title". */
export function whereText(v: Pick<ExportViolation, "sectionId" | "sectionTitle" | "location">): string {
  if (v.sectionId === null) return "Report title";
  const loc = /^(Title|Header|Row \d+|Paragraph \d+|Total row|Median row)$/.test(v.location) ? v.location.charAt(0).toLowerCase() + v.location.slice(1) : v.location;
  return `${v.sectionTitle}, ${loc}`;
}

/** Errors first, then warnings, each in section order as checked. */
export function violationRows(violations: readonly ExportViolation[], warnings: readonly ExportViolation[]): ExportViolation[] {
  return [...violations, ...warnings];
}

/** The id of a section card, for links from the export dialog. */
export function sectionAnchor(sectionId: string): string {
  return `report-section-${sectionId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/** The stale callout's body before the time ("6 findings changed after the report was built on"). */
export function staleLead(changed: number): string {
  if (changed === 0) return "Investigations changed after the report was built on";
  return `${changed === 1 ? "1 finding" : `${changed} findings`} changed after the report was built on`;
}

/** The audit's Findings tab, filtered to one state. */
export function findingsHref(alias: string, auditId: string, state: "proposed"): string {
  return `/spaces/${encodeURIComponent(alias)}/audits/${encodeURIComponent(auditId)}/findings?state=${state}`;
}

/** The audit's Investigations tab. */
export function investigationsHref(alias: string, auditId: string): string {
  return `/spaces/${encodeURIComponent(alias)}/audits/${encodeURIComponent(auditId)}`;
}

/** "3 findings still need a decision." */
export function undecidedText(n: number): string {
  return `${n === 1 ? "1 finding still needs" : `${n} findings still need`} a decision.`;
}

export type FinalizeBlock = { reason: string; link: "findings" | "settings" | null } | null;

/**
 * Why the card's "Save the audit record" button is disabled, or null when it opens
 * the dialog. Undecided findings come first (the dialog can't help with
 * them); other issues are listed in the dialog itself.
 */
export function finalizeBlock(input: { state: string; issues: readonly FinalizeIssue[]; hasRepository: boolean }): FinalizeBlock {
  const proposed = input.issues.find((i) => i.code === "proposed");
  if (proposed) return { reason: undecidedText(proposed.count), link: "findings" };
  if (input.state === "running" || input.state === "draft") return { reason: input.state === "draft" ? "Start the audit and review its findings first." : "Wait for the reviews to finish.", link: null };
  if (input.state === "cancelled") return { reason: "The audit was cancelled, so its record can't be saved.", link: null };
  if (!input.hasRepository) return { reason: "The history repository isn't set up for this space.", link: "settings" };
  return null;
}

/** The first sentence of every notice on model text nobody has approved. */
export const MODEL_TEXT_NOTICE = "Written by the model. Check it against the tables before you share it.";

/**
 * The notice on a narrative section whose model text nobody has approved
 * since the latest finding decision. `canApprove` is false for a Viewer.
 */
export function approvalNotice(input: { draftedBeforeDecisions: boolean; canApprove: boolean }): { title: string; body: string } {
  const next = input.canApprove ? "Approve it once you have, or edit it to make it your own text." : "Someone who can run audits checks it and approves it.";
  if (input.draftedBeforeDecisions) {
    return { title: "Drafted before the latest decisions", body: `${MODEL_TEXT_NOTICE} The tables count findings decided after this draft. ${next}` };
  }
  return { title: MODEL_TEXT_NOTICE, body: next };
}

/** "Summary is the model's text, and nobody has approved it", for the shareable export's warning. */
export function unapprovedTitle(titles: readonly string[]): string {
  const one = titles.length === 1;
  return `${joinNames(titles)} ${one ? "is" : "are"} the model's text, and nobody has approved ${one ? "it" : "them"}`;
}

/** The body of the shareable export's warning. */
export function unapprovedExportBody(count: number): string {
  const it = count === 1 ? "it" : "them";
  return `Check ${it} against the tables before you share this file. You can export anyway, or approve or edit the text first.`;
}

/** Why the saved record stays on this machine, as Home says it; null when the repository pushes to a remote. */
export function localRecordText(repository: string, local: "no-remote" | "push-off" | null): string | null {
  if (local === "no-remote") return `${repository} has no remote (a copy of the repository on a server such as GitHub), so this audit record stays on this machine until one is set. Add one so the history is also kept off this machine.`;
  if (local === "push-off") return `Copying to the remote is off for ${repository}, so this audit record stays on this machine until it is turned on.`;
  return null;
}

/** The link to a section from a dialog: "Go to Summary". */
export function goToSection(title: string): string {
  return `Go to ${title}`;
}

/** Where the commit goes, in one line: "Pushes to <remote>", or why it stays on this machine. */
export function pushPlanText(push: PushPlan): { tone: "success" | "warning"; text: string } {
  if (push.kind === "pushes") return { tone: "success", text: `Pushes to ${push.remote}` };
  return { tone: "warning", text: push.reason === "no-remote" ? "Local only: this repository has no remote" : "Local only: pushing is off for this repository" };
}

/**
 * What happened to the commit, after the save: pushed, a failed push, or why it stayed on this machine.
 * `plan` (the repository as it is now) fills in a save made before the push result was kept.
 */
export function savedPushText(push: SavedRecord["push"], plan: PushPlan | null): { tone: "success" | "warning" | "destructive" | "neutral"; text: string } {
  if (!push) {
    return plan ? { tone: "neutral", text: `The push result wasn't kept for this save. ${pushPlanText(plan).text}.` } : { tone: "neutral", text: "The push result wasn't kept for this save." };
  }
  if (push.pushed) return { tone: "success", text: `Pushed${push.remote ? ` to ${push.remote}` : " to the remote"}` };
  if (push.error) return { tone: "destructive", text: `Saved here, but the push${push.remote ? ` to ${push.remote}` : ""} failed: ${push.error} The next push carries it.` };
  return { tone: "warning", text: push.remote ? "Not pushed: pushing was off for this repository" : "Local only: this repository has no remote" };
}

/** "new" or "changed", as a file's label in the facts. */
export function fileStatusText(status: "new" | "changed"): string {
  return status === "new" ? "new" : "replaces the file that is there";
}

/** The first 7 characters of a commit. */
export const shortCommit = (commit: string): string => commit.slice(0, 7);

/** What each saved file holds, in words a person who never saw the file can read, with the counts from this audit. */
export function recordFileHolds(name: "audit.json" | "findings.json" | "report.md", c: { journalCount: number; acceptedCount: number; reportSections: number }): string {
  const s = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (name === "audit.json") {
    return `the audit's settings, a fingerprint of ${c.journalCount === 1 ? "the 1 journal" : `each of the ${c.journalCount} journals`} so a later change to a journal can be detected, and the analyzer and model versions`;
  }
  if (name === "findings.json") return `the ${s(c.acceptedCount, "accepted finding", "accepted findings")} with their citations`;
  return `the report as text, ${s(c.reportSections, "section", "sections")}`;
}

/** What the repository, the branch, the folder and the commit are, a few words each, to follow their exact names. */
export const REPOSITORY_HELP = "the space's history repository";
export const BRANCH_HELP = "the line of history the record is added to";
export const FOLDER_HELP = "inside that repository";
export const COMMIT_HELP = "the saved snapshot; press it to copy the full ID";

/** What copying to the remote means for this repository, or why nothing is copied. */
export function remoteHelp(plan: PushPlan): string {
  if (plan.kind === "pushes") return "The saved commit is copied to the remote when you save.";
  if (plan.reason === "no-remote") return "A remote is a copy of the repository on a server, such as GitHub. Without one, the record stays on this machine until one is added.";
  return "Copying to the remote is off for this repository, so the record stays on this machine.";
}
