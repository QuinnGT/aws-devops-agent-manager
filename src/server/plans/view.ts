import type { PlanOrigin } from "./contract";
import type { PlanState } from "./types";

/**
 * Pure view helpers for the plan pages (pages/plans.md, pages/plan-review.md):
 * the origin line and the status filter groups. Unit-tested.
 */

/** Names the origin line needs that the origin itself doesn't carry. */
export interface OriginLookups {
  /** Name of the asset a version restore (rollback) puts back */
  assetName?: string | null;
  /** Title of the plan a retry plan came from */
  retryOfTitle?: string | null;
}

/** The origin line of the plans table and the plan header (pages/plans.md, "Origin line by PlanOrigin.kind"). */
export function originLine(origin: PlanOrigin, lookups: OriginLookups = {}): string {
  switch (origin.kind) {
    case "drafts":
      return `From ${origin.draftIds.length} ${origin.draftIds.length === 1 ? "draft" : "drafts"}`;
    case "rollback":
      if (origin.target.kind === "release") return `Restore to release ${origin.target.name}`;
      if (origin.target.kind === "commit") return `Restore to commit ${origin.target.commit.slice(0, 7)}`;
      return `Restore ${lookups.assetName ?? origin.target.assetId} to v${origin.target.version}`;
    case "package":
      return "Package import";
    case "revision":
      return `Revision ${origin.name}`;
    case "retry":
      return lookups.retryOfTitle ? `Retry of ${lookups.retryOfTitle}` : "Retry of a failed plan";
  }
}

export const PLAN_STATUS_FILTERS = {
  open: ["checking", "ready", "waiting", "approved", "applying"],
  closed: ["applied", "failed", "discarded"],
  all: [],
} as const satisfies Record<string, readonly PlanState[]>;

export type PlanStatusFilter = keyof typeof PLAN_STATUS_FILTERS;

/** States still being worked on by a job: the list and the plan page refresh while one is visible. */
export function isBusyState(state: PlanState): boolean {
  return state === "checking" || state === "applying";
}
