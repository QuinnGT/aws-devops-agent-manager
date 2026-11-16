import type { Permission } from "@/server/policy";
import { applyPermissionFor, type PlanOrigin } from "./contract";
import type { PlanState } from "./types";

/**
 * The actions a user has on a plan: the "Buttons by role and state" table in
 * design-system/devops-agent-manager/pages/plan-review.md. Pure; unit-tested.
 * The service functions call it too, so a button the page hides is also
 * refused on the server.
 *
 * Rows, first that applies:
 * 1. Author, approval required, ready and not requested: "Request approval".
 * 2. Approver (plans.approve, not the author), waiting: "Approve", and "Reject" (asks for a note).
 * 3. Publisher (plans.apply, or rollbacks.apply for rollbacks), approved, or ready when no approval is needed: "Apply <N> changes".
 * 4. Anyone else, or a blocked state: the disabled button that would apply, with its reason (the role reason first).
 */

export type PrimaryAction = "request-approval" | "approve" | "apply";

export interface ActionButton<A extends string> {
  action: A;
  label: string;
  enabled: boolean;
  /** Shown next to a disabled button (DisabledReason) */
  disabledReason: string | null;
}

export interface PlanActions {
  /** Null in states with nothing to do (applied, discarded, failed) */
  primary: ActionButton<PrimaryAction> | null;
  /** "Reject", next to "Approve" */
  reject: ActionButton<"reject"> | null;
  /** "Discard plan", for the author or an Admin, with plans.create */
  discard: ActionButton<"discard"> | null;
  /** "Re-check live space" (plans.create); the page shows it only in the conflict callout */
  recheck: ActionButton<"recheck"> | null;
  /** "Create a plan for the failed items", after a failed apply */
  retryFailed: ActionButton<"retry-failed"> | null;
  /** The change reason can still be edited */
  canEditReason: boolean;
  /** The viewer's role can apply this plan (plans.apply, or rollbacks.apply for a restore) */
  canApply: boolean;
}

export interface PlanActionInput {
  plan: {
    state: PlanState;
    origin: PlanOrigin;
    createdBy: string;
    approvalRequestedAt: Date | null;
    approvedAt: Date | null;
    checkError: string | null;
  };
  viewer: { email: string; permissions: ReadonlySet<Permission> | readonly Permission[] };
  settings: { approvalRequired: boolean };
  /** Items apply will write (not skipped, not unchanged) */
  writeCount: number;
  /** Items (and plan-level checks) with validation errors */
  validationFailed: number;
  /** Items that failed in the last apply */
  failedCount: number;
  /** Role reasons naming the roles that can (missingRoleReason); REASONS.publisher and REASONS.editor otherwise */
  roleReasons?: { apply: string; create: string };
}

/** The permission that marks an Admin for "Discard plan" (the Admin role is the only one with it by default). */
export const ADMIN_PERMISSION: Permission = "spaces.manage";

export const REASONS = {
  approvalFirst: "Apply unlocks after approval.",
  validation: (n: number) => `Validation failed for ${n} asset(s).`,
  publisher: "You need the Publisher role to apply.",
  ownPlan: "The plan author can't approve their own plan.",
  checking: "The live-space check is still running.",
  checkFailed: "The live-space check failed. Re-check the live space to try again.",
  applying: "The apply job is running.",
  nothingToApply: "Nothing to apply: every item is unchanged or will be skipped.",
  editor: "You need the Editor role to change this plan.",
  notAuthor: "Only the plan author or an Admin can discard this plan.",
} as const;

function has(perms: ReadonlySet<Permission> | readonly Permission[], p: Permission): boolean {
  return perms instanceof Set ? perms.has(p) : (perms as readonly Permission[]).includes(p);
}

export function sameUser(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function applyLabel(n: number): string {
  return `Apply ${n} ${n === 1 ? "change" : "changes"}`;
}

function button<A extends string>(action: A, label: string, blocked: string | null): ActionButton<A> {
  return { action, label, enabled: blocked === null, disabledReason: blocked };
}

export function planActions(input: PlanActionInput): PlanActions {
  const { plan, viewer, settings, writeCount, validationFailed, failedCount } = input;
  const perms = viewer.permissions;
  const isAuthor = sameUser(viewer.email, plan.createdBy);
  const canCreate = has(perms, "plans.create");
  const canApprove = has(perms, "plans.approve");
  const canApply = has(perms, applyPermissionFor(plan.origin));
  const isAdmin = has(perms, ADMIN_PERMISSION);
  const open = plan.state === "checking" || plan.state === "ready" || plan.state === "waiting" || plan.state === "approved";
  const publisherReason = input.roleReasons?.apply ?? REASONS.publisher;
  const editorReason = input.roleReasons?.create ?? REASONS.editor;

  // The discard action checks plans.create, so authorship alone (a Viewer's own old plan) is not enough.
  const discard =
    open || plan.state === "failed"
      ? button("discard", "Discard plan", !canCreate ? editorReason : isAuthor || isAdmin ? null : REASONS.notAuthor)
      : null;
  const recheck = plan.state === "ready" || plan.state === "waiting" || plan.state === "approved" ? button("recheck", "Re-check live space", canCreate ? null : editorReason) : null;
  const retryFailed = plan.state === "failed" && failedCount > 0 ? button("retry-failed", "Create a plan for the failed items", canCreate ? null : editorReason) : null;
  const base = { reject: null, discard, recheck, retryFailed, canEditReason: open && canCreate, canApply };

  if (plan.state === "applied" || plan.state === "discarded" || plan.state === "failed") {
    return { ...base, primary: null, canEditReason: false };
  }
  if (plan.state === "applying") {
    return { ...base, primary: button("apply", applyLabel(writeCount), REASONS.applying), canEditReason: false };
  }

  const blocker =
    plan.state === "checking"
      ? REASONS.checking
      : plan.checkError
        ? REASONS.checkFailed
        : validationFailed > 0
          ? REASONS.validation(validationFailed)
          : null;
  const nothing = writeCount === 0 ? REASONS.nothingToApply : null;
  const waiting = plan.state === "waiting";
  const approved = plan.state === "approved";
  const readyNoApproval = (plan.state === "ready" || waiting) && !settings.approvalRequired;

  // Row 1: the author asks for approval (the action needs plans.create, so an author who lost the role falls to row 4).
  if (isAuthor && canCreate && settings.approvalRequired && plan.state === "ready" && !plan.approvalRequestedAt) {
    return { ...base, primary: button("request-approval", "Request approval", blocker ?? nothing) };
  }
  // Row 2: an approver who is not the author.
  if (waiting && settings.approvalRequired && canApprove && !isAuthor) {
    return { ...base, primary: button("approve", "Approve", blocker), reject: button("reject", "Reject", null) };
  }
  // Row 3: a publisher, once approved or when no approval is needed.
  if (canApply && (approved || readyNoApproval)) {
    return { ...base, primary: button("apply", applyLabel(writeCount), blocker ?? nothing) };
  }
  // Row 4: the disabled button that would apply, and why.
  if (waiting && isAuthor && canApprove) {
    return { ...base, primary: button("approve", "Approve", REASONS.ownPlan) };
  }
  // A role that can never apply hears that first; a running check or a failure matters only to someone who could apply.
  const reason = !canApply ? publisherReason : (blocker ?? (settings.approvalRequired && !approved ? REASONS.approvalFirst : (nothing ?? REASONS.approvalFirst)));
  return { ...base, primary: button("apply", applyLabel(writeCount), reason) };
}
