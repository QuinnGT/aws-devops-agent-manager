import { Check, CheckCheck, CircleCheck, CircleMinus, CircleX, Clock, ListChecks, Loader, SquarePen, X } from "lucide-react";
import type { StatusSpec } from "@/components/common/status-words";
import { reviewFailureKind, reviewFailureText, type ReviewFailureKind } from "@/server/audits/failure";
import type { AuditItemState, AuditState, FindingState } from "@/server/audits/states";

/**
 * Words, tones and icons for the audit screens (pages/audits.md "States",
 * audit-detail.md, audit-item.md), in the style of src/components/plans/words.ts.
 * Pure; unit-tested.
 */

export const AUDITS_DESCRIPTION = "An audit reviews a set of investigations. You accept, edit or reject each finding, send accepted package fixes to a revision, then build a report and save the audit record.";

/** Audit states. An audit draft is neutral so info stays free for "Running" in the same column. */
export const AUDIT_STATE_BADGE: Record<AuditState, StatusSpec> = {
  draft: { tone: "neutral", icon: SquarePen, label: "Draft" },
  running: { tone: "info", icon: Loader, label: "Running" },
  reviewing: { tone: "warning", icon: ListChecks, label: "In review" },
  finalized: { tone: "success", icon: CircleCheck, label: "Record saved" },
  cancelled: { tone: "neutral", icon: CircleX, label: "Cancelled" },
};

/** What the audit's items and findings say about it, for the state words below. */
export interface AuditStateFacts {
  items: Record<AuditItemState, number>;
  /** Findings of the current reviews */
  findings: { proposed: number; total: number };
}

export const REVIEWS_FAILED_BADGE: StatusSpec = { tone: "destructive", icon: CircleX, label: "Reviews failed" };
export const READY_TO_SAVE_BADGE: StatusSpec = { tone: "success", icon: CheckCheck, label: "Ready to save the record" };

/**
 * The audit's badge. An audit in review whose every review failed says
 * "Reviews failed", never "In review"; one whose every investigation is
 * reviewed (or skipped) and every finding decided says "Ready to save the
 * record" (the same rule the Report tab's "Save the audit record" applies).
 */
export function auditStateBadge(state: AuditState, f?: AuditStateFacts | null): StatusSpec {
  if (!f || state !== "reviewing") return AUDIT_STATE_BADGE[state];
  if (allReviewsFailed(f)) return REVIEWS_FAILED_BADGE;
  if (readyToSave(state, f)) return READY_TO_SAVE_BADGE;
  return AUDIT_STATE_BADGE[state];
}

/** Every review that ran failed: none reviewed, at least one failed, nothing still running. */
export function allReviewsFailed(f: AuditStateFacts): boolean {
  const i = f.items;
  return i.failed > 0 && i.reviewed === 0 && i.pending + i.analyzing + i.reviewing === 0;
}

/** Every investigation reviewed or skipped, at least one reviewed, and no finding left proposed. */
export function readyToSave(state: AuditState, f: AuditStateFacts): boolean {
  const i = f.items;
  return state === "reviewing" && i.reviewed > 0 && i.failed + i.pending + i.analyzing + i.reviewing === 0 && f.findings.proposed === 0;
}

/** "0 of 2 reviewed" and "2 failed": the Reviews tile and the list's progress line say the same. */
export function reviewProgressText(i: Record<AuditItemState, number>): { value: string; failed: string | null } {
  const total = i.pending + i.analyzing + i.reviewing + i.reviewed + i.failed;
  return { value: `${i.reviewed} of ${total} reviewed`, failed: i.failed ? `${i.failed} failed` : null };
}

export const FINDING_STATE_BADGE: Record<FindingState, StatusSpec> = {
  proposed: { tone: "info", icon: Clock, label: "Proposed" },
  accepted: { tone: "success", icon: Check, label: "Accepted" },
  rejected: { tone: "neutral", icon: X, label: "Rejected" },
};

export const EDITED_BADGE: StatusSpec = { tone: "neutral", icon: SquarePen, label: "Edited" };

/** The Review column of the Investigations tab. `waitingLabel` words a waiting item ("Waiting for a review file" in a hand-off audit). */
export function itemReviewBadge(state: AuditItemState, waitingLabel?: string | null): StatusSpec {
  switch (state) {
    case "reviewed":
      return { tone: "success", icon: Check, label: "Reviewed" };
    case "reviewing":
      return { tone: "info", icon: Loader, label: "Reviewing" };
    case "failed":
      return { tone: "destructive", icon: CircleX, label: "Failed" };
    case "skipped":
      return { tone: "neutral", icon: CircleMinus, label: "Skipped" };
    default:
      return { tone: "neutral", icon: Clock, label: waitingLabel ?? "Waiting" };
  }
}

/** Extra rows on the Start card for a reviewer that is not a Bedrock model. */
export function reviewerFacts(runner: string): [string, string][] {
  if (runner === "handoff") return [["Review files", "You download them after the analyzers run, run them with an agent your company has approved, and import each review. The app makes no model call."]];
  return [];
}

/** The help line under the Start button. */
export function startHelp(runner: string): string {
  if (runner === "handoff") return "Analyzers run first. Then you download the review files, run them with your agent and import each review. Nothing counts until you accept it.";
  return "Analyzers run first, then the reviews. Each review reads only its own investigation's records, and nothing counts until you accept it.";
}

/** "Reviewed by Claude Code, Opus 5.5, from a review file" for a hand-off review; the model ID for a model review. */
export function reviewedBy(runner: string, modelId: string): string {
  return runner === "handoff" ? `${modelId}, from a review file` : modelId;
}

export const plural = (n: number, one: string, other = `${one}s`) => `${n} ${n === 1 ? one : other}`;

/** The audits list's footer link for the audits the default filter leaves out: "Show 2 cancelled audits", "Show 1 audit with a saved record". */
export function showClosedText(state: "cancelled" | "finalized", n: number): string {
  if (state === "cancelled") return `Show ${plural(n, "cancelled audit")}`;
  return `Show ${n} ${n === 1 ? "audit" : "audits"} with a saved record`;
}

/** "3 accepted, 1 proposed", leaving out zero counts; "None" when there are none. */
export function findingCountsText(c: { accepted: number; proposed: number; rejected: number }): { parts: { n: number; word: string; strong: boolean }[]; none: boolean } {
  const parts = [
    { n: c.accepted, word: "accepted", strong: false },
    { n: c.proposed, word: "proposed", strong: true },
    { n: c.rejected, word: "rejected", strong: false },
  ].filter((p) => p.n > 0);
  return { parts, none: parts.length === 0 };
}

/** Citation check summary for a table cell. */
export function citationCell(c: { checked: number; failed: number } | null): { tone: "success" | "warning" | "muted"; label: string; detail: string | null } {
  if (!c) return { tone: "muted", label: "Not checked", detail: null };
  if (c.failed > 0) return { tone: "warning", label: `${c.failed} failed`, detail: `of ${plural(c.checked, "citation")}` };
  return { tone: "success", label: "Passed", detail: plural(c.checked, "citation") };
}

/** Citations of one finding, for the Findings tab: "3 passed", "1 of 2 failed", or failed ones a reviewer checked. */
export function findingCitationText(c: { checked: number; failed: number; open?: number }): { tone: "success" | "warning" | "muted"; label: string } {
  if (c.checked === 0) return { tone: "muted", label: "No records cited" };
  const open = c.open ?? c.failed;
  if (open > 0) return { tone: "warning", label: `${open} of ${c.checked} failed` };
  if (c.failed > 0) return { tone: "success", label: `${plural(c.failed, "failed citation")} checked by a reviewer` };
  return { tone: "success", label: `${c.checked} passed` };
}

export interface CitationLike {
  record: number;
  ok: boolean;
  problem?: "missing-record" | "quote-not-found";
  checked?: { by: string; at: string; note: string } | null;
}

/** "Checked by Alex Rivera: the numbers are there" for a failed citation a reviewer checked. */
export function checkedText(c: { by: string; note: string }): string {
  return `Checked by ${c.by}: ${c.note}`;
}

/** One sentence per failed citation, for the citation check callout (pages/audit-item.md). */
export function citationProblemSentence(c: CitationLike, totalRecords: number | null): string {
  if (c.problem === "missing-record") return totalRecords !== null ? `R${c.record} doesn't exist: this journal has ${plural(totalRecords, "record")}.` : `R${c.record} doesn't exist in this journal.`;
  return `The text quoted from R${c.record} isn't in that record.`;
}

/** The short reason next to a failed citation chip; a checked one says who checked it. */
export function citationChipReason(c: CitationLike, totalRecords: number | null): string | null {
  if (c.ok) return null;
  if (c.checked) return checkedText(c.checked);
  if (c.problem === "missing-record") return totalRecords !== null ? `Not in this journal (${plural(totalRecords, "record")})` : "Not in this journal";
  return `Quoted text not found in R${c.record}`;
}

/** Unique failed citations, one per record and problem, in record order. */
export function uniqueProblems<T extends CitationLike>(cs: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const c of [...cs].filter((x) => !x.ok).sort((a, b) => a.record - b.record)) {
    const k = `${c.record}\0${c.problem ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/** "Diagnosis" for a kind with one finding, "Fix 2 of 3" when the review has several. */
export function kindPosition(label: string, index: number, count: number): string {
  return count > 1 ? `${label} ${index + 1} of ${count}` : label;
}

/** The failed-review sentence for a callout: the incident, then the cause in plain words. */
export function failedReviewSentence(incident: string, reason: string | null, stepLimit: number, canManage = false): string {
  return `${incident}: ${reviewFailureText(reviewFailureKind(reason), { canManage, stepLimit, reason })}`;
}

const SHORT_FAILURE: Record<ReviewFailureKind, string> = {
  "no-credentials": "No AWS credentials for the space",
  expired: "AWS credentials expired",
  "access-denied": "AWS refused the request",
  throttled: "Bedrock was limiting requests",
  network: "Bedrock couldn't be reached",
  timeout: "Took longer than the time limit",
  "step-limit": "Stopped at the step limit",
  schema: "Output didn't match the schema",
  model: "The model call failed",
  "no-journal": "Journal no longer cached",
  analyzers: "Analyzers couldn't run",
  "no-model": "No review model",
  interrupted: "Stopped before it finished",
  other: "Review failed",
};

/** Short reason under a Failed badge. Never the stored error text. */
export function failedShortReason(reason: string | null): string {
  return SHORT_FAILURE[reviewFailureKind(reason)];
}

/**
 * Incident IDs from the "Incident IDs" field: numbers or full IDs, separated
 * by spaces, commas or new lines. A bare number goes through the profile's
 * incident ID template ("INCIDENT-{id}" turns 20101 into INCIDENT-20101).
 */
export function parseIncidentIds(text: string, template: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const t = raw.trim();
    if (!t || t.length > 300) continue;
    const id = /^\d+$/.test(t) ? template.replaceAll("{id}", t) : t;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** "Needs per incident: Confirmed root cause, Benchmark scorecard" or "Needs: two cohorts". */
export function profileNeeds(p: { inputs: { label: string; required: boolean }[]; cohorts: { label: string }[] }): string | null {
  const parts: string[] = [];
  const req = p.inputs.filter((i) => i.required).map((i) => i.label);
  if (req.length) parts.push(`Needs per incident: ${req.join(", ")}`);
  if (p.cohorts.length) parts.push(`Needs: ${p.cohorts.length === 2 ? "two" : p.cohorts.length} cohorts`);
  return parts.length ? parts.join(". ") : null;
}

/** Masks an account ID for the Start card: 111122223333 becomes 1111-2222-3333. */
export function formatAccount(id: string): string {
  return /^\d{12}$/.test(id) ? `${id.slice(0, 4)}-${id.slice(4, 8)}-${id.slice(8)}` : id;
}

/** "1.9 M", "12 k", "830": token counts in the Reviews tile. */
export function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")} M`;
  if (n >= 10_000) return `${Math.round(n / 1000)} k`;
  return String(n);
}

/** Analyzer IDs in words: "run-metrics" becomes "run metrics". */
export function analyzerWords(ids: readonly string[], labels: ReadonlyMap<string, string> = new Map()): string {
  const words = ids.map((id) => (labels.get(id) ?? id.replace(/[-_]+/g, " ")).toLowerCase());
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** "Score 2/5" for a score, "Verdict: Miss" for other text. Pure. */
export function fieldText(label: string, value: string): string {
  return /^\d+(\.\d+)?\s*\/\s*\d+$/.test(value) ? `${label} ${value}` : `${label}: ${value}`;
}

/** Text for a not-matched file, by reason code (pages/audit-new.md, "Not matched"). Pure. */
export function unmatchedText(u: { fileName: string; reason: string; code: string | null }, example: string | null): string {
  switch (u.code) {
    case "evidence.name-unmatched":
      return `${u.fileName}: the name matches neither input.${example ? ` Rename it, for example to ${example}, and upload it again.` : " Rename it and upload it again."}`;
    case "evidence.not-text":
      return `${u.fileName} isn't a text or markdown file.`;
    default:
      return `${u.fileName}: ${u.reason}`;
  }
}


/** A plan's state in a sentence, for the revisions a finding went to. */
export function planStateWords(state: string): string {
  const words: Record<string, string> = {
    checking: "being checked",
    ready: "ready to apply",
    waiting: "waiting for approval",
    approved: "approved",
    applying: "being applied",
    applied: "applied",
    failed: "failed",
    discarded: "discarded",
  };
  return words[state] ?? state;
}

/** A revision's state when it isn't plainly open, for the revisions a finding went to; null for an open revision. */
export function revisionStateWords(state: string): string | null {
  const words: Record<string, string> = { creating: "Being created", applied: "Applied", abandoned: "Abandoned", failed: "Not created" };
  return words[state] ?? null;
}

/** What a revision does with the finding: "To address" while it waits on the list, "Linked by a save" once a save names it. */
export function linkKindWords(kind: "to-address" | "linked"): string {
  return kind === "linked" ? "Linked by a save" : "To address";
}

/**
 * The check result under one citation of the evidence list: what the citation check found, in words.
 * A failed citation a reviewer read says who checked it and what they found.
 */
export function citationResult(c: CitationLike & { quote?: string | null }, totalRecords: number | null): { tone: "success" | "warning"; text: string } {
  if (c.ok) return { tone: "success", text: c.quote ? `The quoted text is in R${c.record}.` : `R${c.record} exists in this journal.` };
  return { tone: "warning", text: c.checked ? checkedText(c.checked) : (citationProblemSentence(c, totalRecords) ?? "The citation failed the check.") };
}

/** The evidence heading's summary: "2 citations passed", "1 of 2 failed", or the failed ones a reviewer checked. */
export function evidenceSummary(rows: readonly CitationLike[]): { tone: "success" | "warning" | "muted"; label: string } {
  const failed = rows.filter((r) => !r.ok);
  const open = failed.filter((r) => !r.checked).length;
  if (rows.length === 0) return { tone: "muted", label: "No records cited" };
  if (open > 0) return { tone: "warning", label: `${open} of ${rows.length} failed the check` };
  if (failed.length > 0) return { tone: "success", label: `${plural(failed.length, "failed citation")} checked by a reviewer` };
  return { tone: "success", label: `${plural(rows.length, "citation")} passed` };
}

/** What the confirm button of the "Add to revision…" dialog says. */
export function confirmRevisionLabel(p: { acceptFirst: boolean; target: "new" | { name: string } }): string {
  const what = p.acceptFirst ? "Accept and add" : "Add";
  return p.target === "new" ? `${what} to a new revision` : `${what} to ${p.target.name}`;
}
