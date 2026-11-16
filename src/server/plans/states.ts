import type { ItemChange, ItemProgress, PlanState } from "./types";

/**
 * Plan states and their badges (plan-review.md, "Plan states"), and the
 * labels of an item's change (MASTER.md status table, "Plan item"). Pure.
 */

export type Tone = "info" | "success" | "warning" | "destructive" | "neutral" | "agent" | "muted";

export interface Badge {
  tone: Tone;
  /** lucide-react icon name */
  icon: string | null;
  label: string;
}

export const PLAN_STATE_BADGES: Record<PlanState, Badge & { meaning: string }> = {
  checking: { tone: "info", icon: "Loader", label: "Checking", meaning: "The live-space check is running" },
  ready: { tone: "success", icon: "CircleCheck", label: "Ready", meaning: "Checked, valid, no approval needed" },
  waiting: { tone: "warning", icon: "Clock", label: "Waiting for approval", meaning: "Approval requested, not yet given" },
  approved: { tone: "success", icon: "UserCheck", label: "Approved", meaning: "A second person approved" },
  applying: { tone: "info", icon: "Loader", label: "Applying", meaning: "The apply job is running" },
  applied: { tone: "success", icon: "CircleCheck", label: "Applied", meaning: "Every item written and verified, or skipped" },
  failed: { tone: "destructive", icon: "CircleX", label: "Failed", meaning: "At least one item failed to write or verify" },
  discarded: { tone: "neutral", icon: null, label: "Discarded", meaning: "Closed without applying" },
};

/** States in which a plan is still open (not applying, not finished). */
export const OPEN_STATES: readonly PlanState[] = ["checking", "ready", "waiting", "approved"];
export const TERMINAL_STATES: readonly PlanState[] = ["applied", "failed", "discarded"];

/** The state a plan returns to after a check: approval fields decide it. */
export function stateAfterCheck(p: { approvalRequestedAt: Date | null; approvedAt: Date | null }): PlanState {
  if (p.approvedAt) return "approved";
  if (p.approvalRequestedAt) return "waiting";
  return "ready";
}

export function itemChangeBadge(change: ItemChange | null, opts: { skipped?: boolean; status?: unknown } = {}): Badge {
  if (opts.skipped) return { tone: "warning", icon: "TriangleAlert", label: "Skip: live changed" };
  switch (change) {
    case "create":
      return { tone: "info", icon: "CirclePlus", label: "Create" };
    case "content":
      return { tone: "info", icon: "SquarePen", label: "Update content" };
    case "metadata":
      return { tone: "info", icon: "SquarePen", label: "Update metadata" };
    case "status":
      return { tone: "agent", icon: "PowerOff", label: opts.status === "INACTIVE" ? "Set Inactive" : "Set Active" };
    case "delete":
      return { tone: "destructive", icon: "Trash2", label: "Delete (snapshot taken first)" };
    case "none":
      return { tone: "muted", icon: "Equal", label: "No change" };
    default:
      return { tone: "muted", icon: "Loader", label: "Checking" };
  }
}

export const ITEM_PROGRESS_LABELS: Record<ItemProgress, string> = {
  waiting: "Waiting",
  writing: "Writing",
  verifying: "Verifying",
  done: "Done",
  skipped: "Skipped",
  failed: "Failed",
};

/** "v5 → v6", "v1, status only", "planned v1, live v2", "new". */
export function versionLabel(i: { change: ItemChange | null; liveVersion: number | null; baseVersion: number | null; conflict: { kind: string } | null; writtenVersion?: number | null }): string {
  if (i.conflict?.kind === "moved") return `planned v${i.baseVersion ?? "?"}, live v${i.liveVersion ?? "?"}`;
  if (i.conflict?.kind === "missing") return "deleted in the space";
  const live = i.liveVersion;
  switch (i.change) {
    case "create":
      return i.writtenVersion ? `new → v${i.writtenVersion}` : "new";
    case "content":
      return `v${live} → v${i.writtenVersion ?? (live ?? 0) + 1}`;
    case "status":
      return `v${live}, status only`;
    case "metadata":
      return i.writtenVersion && i.writtenVersion !== live ? `v${live} → v${i.writtenVersion}` : `v${live}, metadata`;
    case "delete":
      return `v${live} → deleted`;
    case "none":
      return live === null ? "" : `v${live}`;
    default:
      return "";
  }
}
