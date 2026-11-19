import type { AUDIT_ITEM_STATES, AUDIT_STATES, FINDING_STATES, REVIEW_STATES } from "@/server/db/schema/audits";

/**
 * State rules of audits, items and findings. Pure.
 *
 * Audit:   draft -> running (start) -> reviewing (every item done) -> finalized (by audit-reports)
 *          running -> cancelled; draft is deleted, never cancelled.
 *          reviewing -> running while a rerun of one item is in progress.
 * Item:    pending -> analyzing -> pending with analyzedAt (waiting for a review slot)
 *          -> reviewing -> reviewed | failed. skipped when the audit starts without it or is cancelled.
 * Finding: proposed -> accepted | rejected; accepted <-> rejected; reopen goes back to proposed.
 *          Edits are allowed while proposed or accepted.
 */

export type AuditState = (typeof AUDIT_STATES)[number];
export type AuditItemState = (typeof AUDIT_ITEM_STATES)[number];
export type ReviewState = (typeof REVIEW_STATES)[number];
export type FindingState = (typeof FINDING_STATES)[number];

export const AUDIT_STATE_LABELS: Record<AuditState, string> = {
  draft: "Draft",
  running: "Running",
  reviewing: "Reviewing findings",
  finalized: "Finalized",
  cancelled: "Cancelled",
};

export const ITEM_STATE_LABELS: Record<AuditItemState, string> = {
  pending: "Waiting",
  analyzing: "Running analyzers",
  reviewing: "Model review",
  reviewed: "Reviewed",
  failed: "Failed",
  skipped: "Skipped",
};

export const FINDING_STATE_LABELS: Record<FindingState, string> = {
  proposed: "Proposed",
  accepted: "Accepted",
  rejected: "Rejected",
};

/** A pending item whose analyzers have run, waiting for its review. A hand-off audit waits for a file a person imports. */
export const WAITING_FOR_REVIEW_LABEL = "Waiting for review";
export const WAITING_FOR_FILE_LABEL = "Waiting for a review file";
export const itemWaitingLabel = (runner: string): string => (runner === "handoff" ? WAITING_FOR_FILE_LABEL : WAITING_FOR_REVIEW_LABEL);

/** Why a hand-off audit's item has no Rerun: importing a new review file replaces its review. */
export const HANDOFF_RERUN_REASON = "This audit's reviews come from review files. Import a new review file to replace this review.";

/**
 * Whether a hand-off audit can take review files for an item and a review back:
 * its analyzers have run (so its journal digest is known) and it was not skipped.
 * A review imported later replaces the current one, like a rerun.
 */
export const filesEligible = (i: { state: AuditItemState; analyzedAt: Date | null; journalSha256: string | null }): boolean =>
  !!i.analyzedAt && !!i.journalSha256 && (i.state === "pending" || i.state === "reviewed" || i.state === "failed");

/** Item states after which an item needs no more work in this run. */
export const FINISHED_ITEM_STATES: readonly AuditItemState[] = ["reviewed", "failed", "skipped"];
export const isItemFinished = (s: AuditItemState) => FINISHED_ITEM_STATES.includes(s);

/** States in which people review findings. Findings of a cancelled or finalized audit are read-only. */
export const FINDING_REVIEW_AUDIT_STATES: readonly AuditState[] = ["running", "reviewing"];

export const canStartAudit = (s: AuditState) => s === "draft";
export const canCancelAudit = (s: AuditState) => s === "running";
export const canDeleteAudit = (s: AuditState) => s === "draft";
export const canEditSelection = (s: AuditState) => s === "draft";
export const canReviewFindings = (s: AuditState) => FINDING_REVIEW_AUDIT_STATES.includes(s);
export const canRerunItem = (audit: AuditState, item: AuditItemState) => (audit === "running" || audit === "reviewing") && (item === "reviewed" || item === "failed");

/** Why an audit action is not allowed, in words for the page. */
export function auditStateReason(action: "start" | "cancel" | "delete" | "edit" | "review" | "rerun", state: AuditState): string {
  const label = AUDIT_STATE_LABELS[state].toLowerCase();
  switch (action) {
    case "start":
      return `The audit is ${label}; only a draft can be started.`;
    case "cancel":
      return `The audit is ${label}; only a running audit can be cancelled.`;
    case "delete":
      return state === "running" || state === "finalized" ? `A ${label} audit can't be deleted.` : `The audit is ${label}; only a draft can be deleted.`;
    case "edit":
      return `The audit is ${label}; investigations can be changed only while it is a draft.`;
    case "review":
      return `The audit is ${label}; its findings can't be changed.`;
    case "rerun":
      return `The audit is ${label}; an item can be reviewed again only while the audit is running or its findings are being reviewed.`;
  }
}

export type FindingAction = "accept" | "reject" | "reopen" | "edit";

/** The finding's state after the action, or null when the action is not allowed from `state`. */
export function nextFindingState(state: FindingState, action: FindingAction): FindingState | null {
  switch (action) {
    case "accept":
      return state === "proposed" || state === "rejected" ? "accepted" : null;
    case "reject":
      return state === "proposed" || state === "accepted" ? "rejected" : null;
    case "reopen":
      return state === "accepted" || state === "rejected" ? "proposed" : null;
    case "edit":
      return state === "proposed" || state === "accepted" ? state : null;
  }
}

export function findingActionReason(action: FindingAction, state: FindingState): string {
  const label = FINDING_STATE_LABELS[state].toLowerCase();
  switch (action) {
    case "accept":
      return `The finding is already ${label}.`;
    case "reject":
      return `The finding is already ${label}.`;
    case "reopen":
      return "The finding is already proposed.";
    case "edit":
      return "A rejected finding can't be edited. Reopen it first.";
  }
}

/** The audit's state once every item has finished: reviewing, unless it was cancelled meanwhile. */
export function stateAfterItemsFinished(current: AuditState, items: readonly AuditItemState[]): AuditState {
  if (current !== "running") return current;
  return items.every(isItemFinished) ? "reviewing" : "running";
}
