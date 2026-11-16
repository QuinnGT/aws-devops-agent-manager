import type { Actor } from "@/server/aws/clients";
import type { DesiredAsset } from "@/server/packages/types";

/**
 * CONTRACT.
 *
 * Every write to an Agent Space goes through a plan. Drafts, rollbacks and
 * package imports all create plans with `createPlan` from
 * "@/server/plans". Nothing else calls a write API.
 *
 * Do not change these exported shapes. Add optional fields only.
 */

/** What a rollback plan restores. */
export type RollbackTarget =
  | { kind: "release"; releaseId: string; name: string }
  | { kind: "commit"; commit: string }
  | { kind: "version"; assetId: string; version: number };

/** Where a plan came from. Shown on the plan page and stored with the plan. */
export type PlanOrigin =
  | { kind: "drafts"; draftIds: string[] }
  | { kind: "rollback"; target: RollbackTarget }
  | { kind: "package"; importId: string; fileName: string }
  /** A revision built from audit findings; applying it tags a release */
  | { kind: "revision"; revisionId: string; name: string }
  /** "Create a plan for the failed items" after a failed apply */
  | { kind: "retry"; planId: string };

export interface PlanItemInput {
  /**
   * The state the asset should have after apply. `assetId` set: update that
   * asset. `assetId` unset: create it. `refs` (names of stores, skills) are
   * resolved to asset IDs at apply time, after earlier items are created.
   */
  desired: DesiredAsset;
  /**
   * The live version and updatedAt the desired state was derived from (a
   * draft's base, or the current version for a rollback item that sets an
   * asset Inactive). The plan check flags the item when live has moved past
   * it. Null for other rollback items and for imports, which compare against
   * live at check time.
   */
  baseVersion?: number | null;
  baseUpdatedAt?: string | null;
  /**
   * Metadata keys to remove because they were added after a rollback target.
   * How a key is removed under PATCH semantics is set by plans.yaml `write.metadataRemoval`.
   */
  removeMetadataKeys?: string[];
  /** Why this item exists, shown on the plan, e.g. "Added after the release: set Inactive instead of deleting." */
  note?: string;
}

export interface CreatePlanInput {
  spaceId: string;
  title: string;
  origin: PlanOrigin;
  items: PlanItemInput[];
  /** Deletes are refused unless the space setting `deletesEnabled` is on. */
  deletes?: { assetId: string; note?: string }[];
  /** Change reason, prefilled on the plan page; can be edited before apply. */
  reason?: string | null;
  /**
   * Plan-level notes shown on the plan page, for things that are not items,
   * e.g. "Kept as it is: <name> (unchanged since the release)".
   */
  notes?: string[];
}

export interface CreatePlanResult {
  planId: string;
  /** job_runs.id of the live-space check that the plan starts with */
  checkRunId: string;
}

/**
 * Insert the plan in state "checking" and enqueue its live-space check.
 * The caller has already checked `plans.create` for the space.
 */
export type CreatePlan = (input: CreatePlanInput, actor: Actor) => Promise<CreatePlanResult>;

/** Permission needed to apply a plan: rollbacks need `rollbacks.apply`, everything else `plans.apply`. */
export function applyPermissionFor(origin: PlanOrigin): "plans.apply" | "rollbacks.apply" {
  return origin.kind === "rollback" ? "rollbacks.apply" : "plans.apply";
}
