import { CircleCheck, CircleX, Clock, Loader, TriangleAlert, UserCheck } from "lucide-react";
import { STATUS, type ChangeWord, type StatusSpec } from "@/components/common/status-words";
import type { DraftChange } from "@/server/drafts/view";
import type { PlanActions } from "@/server/plans/actions";
import { PLAN_STATE_BADGES } from "@/server/plans/states";
import type { ItemChange, PlanState } from "@/server/plans/types";

/**
 * Words, tones and icons for plan states, plan items and drafts, mapped onto
 * the shared StatusBadge and ChangeChip tables (MASTER "Statuses",
 * plan-review.md "Plan states"). Pure; unit-tested.
 */

const STATE_ICON = { checking: Loader, ready: CircleCheck, waiting: Clock, approved: UserCheck, applying: Loader, applied: CircleCheck, failed: CircleX, discarded: undefined } as const;
const STATE_TONE = {
  checking: "info",
  ready: "success",
  waiting: "warning",
  approved: "success",
  applying: "info",
  applied: "success",
  failed: "destructive",
  discarded: "neutral",
} as const satisfies Record<PlanState, StatusSpec["tone"]>;

/** The badge of a plan whose last live-space check failed (it can't be applied until a check passes). */
export const CHECK_FAILED_BADGE: StatusSpec = { tone: "destructive", icon: CircleX, label: "Check failed" };

/** The badge of an open plan with a validation error (it can't be applied until the error is fixed). */
export const VALIDATION_FAILED_BADGE: StatusSpec = { tone: "destructive", icon: CircleX, label: "Validation failed" };

/**
 * The status badge of a plan, wherever it shows. An open plan whose live-space
 * check failed, or that has a validation error, says so instead of "Ready".
 */
export function planStateBadge(state: PlanState, checkFailed = false, validationFailed = false): StatusSpec {
  const open = state === "checking" || state === "ready" || state === "waiting" || state === "approved";
  if (open && checkFailed) return CHECK_FAILED_BADGE;
  if (open && validationFailed && state !== "checking") return VALIDATION_FAILED_BADGE;
  return { tone: STATE_TONE[state], icon: STATE_ICON[state], label: PLAN_STATE_BADGES[state].label };
}

/** Labels the counts and the diff when the check couldn't read the live space (plan page and draft editor). */
export const SYNCED_COMPARISON_NOTE = "The live space could not be read, so this compares with the last synced version.";
/** Under a count on the plans list that compares with the last synced version (the check failed). */
export const SYNCED_COUNT_NOTE = "vs last synced version";
/** The Validation tile's detail when it ran against the last synced version. */
export const SYNCED_VALIDATION_NOTE = "checked against the last synced version";

export interface ChangeWordSpec {
  word: ChangeWord;
  label?: string;
}

/** The Change column of a plan item. */
export function itemChangeWord(change: ItemChange | null, opts: { skipped?: boolean; status?: unknown } = {}): ChangeWordSpec {
  if (opts.skipped) return { word: "skip-live-changed" };
  switch (change) {
    case "create":
      return { word: "create" };
    case "content":
      return { word: "update-content" };
    case "metadata":
      return { word: "update-content", label: "Update metadata" };
    case "status":
      return opts.status === "INACTIVE" ? { word: "set-inactive" } : { word: "set-active" };
    case "delete":
      return { word: "delete", label: "Delete (snapshot taken first)" };
    case "none":
      return { word: "no-change" };
    default:
      return { word: "no-change", label: "Not checked yet" };
  }
}

/** The Change column of a draft (pages/drafts.md). */
export function draftChangeWord(change: Pick<DraftChange, "kind" | "status">): ChangeWordSpec {
  switch (change.kind) {
    case "create":
      return { word: "create" };
    case "content":
      return { word: "update-content" };
    case "metadata":
      return { word: "update-content", label: "Update metadata" };
    case "status":
      return change.status === "INACTIVE" ? { word: "set-inactive" } : { word: "set-active" };
    case "none":
      return { word: "no-change" };
  }
}

const plural = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;

/** A validation badge from counts: errors win over warnings; null status means the item wasn't checked. */
export function validationSpec(v: { status: "passed" | "warnings" | "failed" | null; errors: number; warnings: number }): StatusSpec {
  if (v.status === null) return STATUS.notChecked;
  if (v.errors > 0) return { ...STATUS.validationFailed, label: plural(v.errors, "error", "errors") };
  if (v.warnings > 0) return { tone: "warning", icon: TriangleAlert, label: plural(v.warnings, "warning", "warnings") };
  return STATUS.passed;
}

/** "overview", "overview and verity", "overview, verity and 3 more" (the default plan title on the drafts page). */
export function defaultPlanTitle(names: readonly string[]): string {
  const unique = [...new Set(names)];
  if (unique.length <= 1) return unique[0] ?? "";
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique[0]}, ${unique[1]} and ${unique.length - 2} more`;
}

/** The selected item card before the live-space check has compared the item (both views). */
export const DIFF_NOT_READY = "The live-space check hasn't finished, so the diff isn't ready yet.";
/** The same card after the check failed before it compared the item. */
export const DIFF_CHECK_FAILED = "The live-space check failed, so the diff isn't ready. Re-check the live space to try again.";

/**
 * Whether the change reason can be typed in. It is saved with "Request
 * approval" or with apply, so the author can type it while requesting
 * approval, and anyone whose role can apply this plan can type it while the
 * plan is open, even while Apply is still disabled. Not next to "Approve",
 * which doesn't save it.
 */
export function reasonEditable(actions: Pick<PlanActions, "primary" | "canEditReason" | "canApply">): boolean {
  const p = actions.primary;
  if (!actions.canEditReason || !p || p.action === "approve") return false;
  return p.enabled || actions.canApply;
}

/** Why the change reason can't be typed in, shown next to it; null when it can. `roleReason` names the roles that can apply (missingRoleReason). */
export function reasonLockedText(actions: Pick<PlanActions, "primary" | "canEditReason" | "canApply">, state: PlanState, roleReason?: string): string | null {
  const p = actions.primary;
  if (reasonEditable(actions)) return null;
  if (state === "applying") return "The reason can't change while the plan is applying.";
  if (state === "applied" || state === "failed" || state === "discarded") return "The plan is closed, so its reason can't change.";
  if (p?.action === "approve") return "The author enters the reason when they request approval.";
  if (!actions.canEditReason || p?.action === "apply") return roleReason ?? "You need the Publisher role to enter the reason.";
  return "You can enter the reason once approval can be requested.";
}

/** The "Apply will skip" tile's detail: what the count means, or that it is not known yet. */
export function skipTileDetail(skipped: number, checked: boolean): string {
  if (!checked) return "Known after the live-space check";
  return skipped > 0 ? "Changed in the live space after this plan was made" : "No asset changed in the live space since this plan was made";
}

const CHANGE_GROUPS: { key: ItemChange | "unchecked"; label: string }[] = [
  { key: "content", label: "Content updates" },
  { key: "metadata", label: "Metadata updates" },
  { key: "status", label: "Status changes" },
  { key: "delete", label: "Deletes" },
  { key: "create", label: "Creates" },
  { key: "none", label: "No change" },
  { key: "unchecked", label: "Not compared yet" },
];

/** Groups that start collapsed in the changes list when another group is shown: a new asset has nothing to compare against. */
export const COLLAPSED_GROUPS: ReadonlySet<string> = new Set(["create", "none"]);

/**
 * Plan items grouped by change, in the changes list's order (plan-review.md
 * "Changes list"); empty groups are left out. The order inside a group is the
 * plan's. Previous and Next follow the same order.
 */
export function groupPlanItems<T extends { change: ItemChange | null }>(items: readonly T[]): { key: ItemChange | "unchecked"; label: string; items: T[] }[] {
  return CHANGE_GROUPS.map((g) => ({ ...g, items: items.filter((i) => (i.change ?? "unchecked") === g.key) })).filter((g) => g.items.length > 0);
}
