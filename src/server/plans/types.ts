import type { applyRuns, drafts, planItems, plans } from "@/server/db/schema";
import type { ITEM_CHANGES, ITEM_PROGRESS, PLAN_STATES } from "@/server/db/schema/plans";
import type { Permission } from "@/server/policy";
import type { SizeMeter } from "@/server/assets/size-meter";
import type { FileDiff, ValueChange } from "@/server/assets/diff";
import type { ValidationResult } from "@/server/validation/types";

/** Shapes shared by the plans module: rows, JSON columns, and the actor of service functions. */

export type PlanState = (typeof PLAN_STATES)[number];
export type ItemChange = (typeof ITEM_CHANGES)[number];
export type ItemProgress = (typeof ITEM_PROGRESS)[number];

export type PlanRow = typeof plans.$inferSelect;
export type PlanItemRow = typeof planItems.$inferSelect;
export type ApplyRunRow = typeof applyRuns.$inferSelect;
export type DraftRow = typeof drafts.$inferSelect;

/** The acting user of a service function, from the session. `permissions` are the user's permissions in the plan's space. */
export interface PlanActor {
  email: string;
  name?: string | null;
  permissions: ReadonlySet<Permission> | readonly Permission[];
  /** The user's role in the space, when the page knows it: disabled reasons then name the roles that can (missingRoleReason) */
  role?: string | null;
}

export function hasPermission(actor: Pick<PlanActor, "permissions">, p: Permission): boolean {
  const perms = actor.permissions;
  return perms instanceof Set ? perms.has(p) : (perms as readonly Permission[]).includes(p);
}

/** Why an item can't be written as planned. */
export interface ItemConflict {
  /**
   * moved: live has a newer version or updatedAt than the item's base (or, at
   *   apply, than the check);
   * missing: the asset the item updates or deletes no longer exists;
   * exists: an asset with the same name was created after the check.
   */
  kind: "moved" | "missing" | "exists";
  message: string;
  baseVersion?: number | null;
  baseUpdatedAt?: string | null;
  liveVersion?: number | null;
  liveUpdatedAt?: string | null;
  /** Source label of the live change, when the history has it */
  source?: string | null;
  /** Found by the apply job's re-read rather than by the check */
  atApply?: boolean;
}

/** One API call of an item's write, chosen by the check. Requests are built at apply time from `desired`. */
export type WriteStep =
  | { op: "CreateAsset"; content: "file" | "zip" }
  /** Content (one file or a zip) and the metadata patch, or the metadata patch alone when content is null */
  | { op: "UpdateAsset"; content: "file" | "zip" | null; path?: string }
  | { op: "UpdateAssetFile"; path: string }
  | { op: "CreateAssetFile"; path: string }
  | { op: "DeleteAssetFile"; path: string }
  | { op: "DeleteAsset" };

/**
 * Fixed at the first write attempt of an item: the metadata sent (the PATCH
 * for an update, the whole metadata with resolved references for a create)
 * and the live metadata before the write. A retried job sends the same.
 */
export interface WriteState {
  metadata: Record<string, unknown>;
  before: Record<string, unknown> | null;
}

export interface ItemVerification {
  ok: boolean;
  expectedContentHash: string | null;
  actualContentHash: string | null;
  expectedMetadataHash: string;
  actualMetadataHash: string;
  /** Metadata keys whose read-back value differs from what apply expected */
  metadataMismatch: string[];
  /** Files whose read-back hash differs, or that are missing or extra */
  fileMismatch: string[];
  /** Keys the service added on create that apply did not send */
  serviceAddedKeys?: string[];
  attempts: number;
}

/** Counts from the last check, for the plan list and the summary tiles. */
export interface PlanSummary {
  items: number;
  creates: number;
  contentUpdates: number;
  metadataUpdates: number;
  statusChanges: number;
  unchanged: number;
  deletes: number;
  /** Items with a conflict: apply skips them */
  skipped: number;
  /** Items apply will write (not unchanged, not skipped) */
  writes: number;
  validation: { checkedAssets: number; failedAssets: number; errors: number; warnings: number; planErrors: number };
}

export interface ApplyRunItem {
  planItemId: string;
  name: string;
  assetType: string;
  assetId: string | null;
  progress: ItemProgress;
  message: string | null;
  version: number | null;
  commit: string | null;
}

export type { FileDiff, SizeMeter, ValidationResult, ValueChange };

/** A refused request, with a message for the user and optional per-field messages. */
export class PlanServiceError extends Error {
  constructor(
    message: string,
    readonly fieldErrors: Record<string, string> = {},
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "PlanServiceError";
  }
}
