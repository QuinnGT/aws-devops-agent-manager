import type { Permission } from "@/server/policy";
import {
  auditStateReason,
  canCancelAudit,
  canDeleteAudit,
  canEditSelection,
  canRerunItem,
  canReviewFindings,
  canStartAudit,
  findingActionReason,
  nextFindingState,
  type AuditItemState,
  type AuditState,
  type FindingAction,
  type FindingState,
} from "./states";

/**
 * Buttons on the audit pages, enabled or with the reason they are not. Pure.
 * The service functions apply the same state rules, so a button the page
 * disables is refused on the server too. Permissions: audits.run for the
 * lifecycle and ground truth, findings.review for findings.
 */

export interface ActionState {
  enabled: boolean;
  /** Shown next to a disabled button */
  disabledReason: string | null;
}

export interface AuditViewer {
  permissions: ReadonlySet<Permission> | readonly Permission[];
}

const has = (v: AuditViewer, p: Permission) => (v.permissions instanceof Set ? v.permissions.has(p) : (v.permissions as readonly Permission[]).includes(p));

const RUN_ROLE = "Your role can't run audits in this space.";
const REVIEW_ROLE = "Your role can't review findings in this space.";

function gate(roleOk: boolean, roleReason: string, stateOk: boolean, stateReason: string): ActionState {
  if (!roleOk) return { enabled: false, disabledReason: roleReason };
  if (!stateOk) return { enabled: false, disabledReason: stateReason };
  return { enabled: true, disabledReason: null };
}

export interface AuditActions {
  start: ActionState;
  /** Start and skip the items that are not ready */
  startSkippingIncomplete: ActionState;
  cancel: ActionState;
  delete: ActionState;
  editSelection: ActionState;
  uploadGroundTruth: ActionState;
}

export function auditActions(state: AuditState, readiness: { total: number; ready: number } | null, viewer: AuditViewer): AuditActions {
  const run = has(viewer, "audits.run");
  const allReady = !!readiness && readiness.total > 0 && readiness.ready === readiness.total;
  const someReady = !!readiness && readiness.ready > 0;
  const notReadyReason =
    !readiness || readiness.total === 0 ? "Add investigations first." : `${readiness.total - readiness.ready} of ${readiness.total} investigation(s) are not ready.`;
  return {
    start: gate(run, RUN_ROLE, canStartAudit(state) && allReady, canStartAudit(state) ? notReadyReason : auditStateReason("start", state)),
    startSkippingIncomplete: gate(
      run,
      RUN_ROLE,
      canStartAudit(state) && someReady && !allReady,
      canStartAudit(state) ? (allReady ? "Every investigation is ready." : "No investigation is ready.") : auditStateReason("start", state),
    ),
    cancel: gate(run, RUN_ROLE, canCancelAudit(state), auditStateReason("cancel", state)),
    delete: gate(run, RUN_ROLE, canDeleteAudit(state), auditStateReason("delete", state)),
    editSelection: gate(run, RUN_ROLE, canEditSelection(state), auditStateReason("edit", state)),
    uploadGroundTruth: gate(run, RUN_ROLE, state !== "finalized", "The audit is finalized."),
  };
}

export interface ItemActions {
  rerun: ActionState;
  acceptAll: ActionState;
}

export function itemActions(audit: AuditState, item: AuditItemState, proposed: number, viewer: AuditViewer): ItemActions {
  return {
    rerun: gate(
      has(viewer, "audits.run"),
      RUN_ROLE,
      canRerunItem(audit, item),
      audit === "running" || audit === "reviewing" ? "The review of this investigation is not finished." : auditStateReason("rerun", audit),
    ),
    acceptAll: gate(
      has(viewer, "findings.review"),
      REVIEW_ROLE,
      canReviewFindings(audit) && proposed > 0,
      canReviewFindings(audit) ? "No finding is waiting for a decision." : auditStateReason("review", audit),
    ),
  };
}

export type FindingActions = Record<FindingAction, ActionState>;

export function findingActions(audit: AuditState, finding: { state: FindingState; current: boolean; editable: boolean }, viewer: AuditViewer): FindingActions {
  const role = has(viewer, "findings.review");
  const one = (a: FindingAction): ActionState => {
    if (!role) return { enabled: false, disabledReason: REVIEW_ROLE };
    if (!canReviewFindings(audit)) return { enabled: false, disabledReason: auditStateReason("review", audit) };
    if (!finding.current) return { enabled: false, disabledReason: "This finding is from an earlier review." };
    if (a === "edit" && !finding.editable) return { enabled: false, disabledReason: "The profile allows no edits to this kind of finding." };
    return nextFindingState(finding.state, a) ? { enabled: true, disabledReason: null } : { enabled: false, disabledReason: findingActionReason(a, finding.state) };
  };
  return { accept: one("accept"), reject: one("reject"), reopen: one("reopen"), edit: one("edit") };
}
