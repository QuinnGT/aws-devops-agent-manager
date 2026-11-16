import type { ChangeSource } from "@/lib/assets/types";

/** Contract types, re-exported from ./index. */

export interface AssetChangeToAttribute {
  assetId: string;
  assetType: string;
  serviceVersion: number;
  /** The version's createdAt (new version) */
  serviceCreatedAt: Date;
  /** The version's updatedAt; for metadata-only changes this is the only timestamp that moves */
  serviceUpdatedAt: Date;
  changeKind: "created" | "content" | "metadata" | "deleted" | "baseline";
  /**
   * Optional: when sync observed the change. For deletions it is the upper
   * bound of the CloudTrail search (default: now), and it decides whether a
   * deletion without an event is provisional.
   */
  detectedAt?: Date;
}

export interface Attribution {
  source: ChangeSource;
  /** Human label from policy, e.g. "Operator Web App" */
  label: string;
  /** Role session name, IAM principal ARN, app user, or a fixed label */
  principal: string | null;
  cloudTrailEventId: string | null;
  /** Plan item id when the change was applied by this app (clientToken match) */
  planId: string | null;
  /** How the match was made, for debugging: "clientToken", "exact", "window", "none", "error" */
  matchedBy: "clientToken" | "exact" | "window" | "none" | "error";
  /** Optional: why the source is unknown, or other detail for logs */
  note?: string;
  /**
   * Optional: true when no event matched but CloudTrail may not have
   * delivered it yet (policy eventDeliveryDelaySeconds). Sync may attribute
   * the change again later instead of committing this result.
   */
  provisional?: boolean;
}

/** Key used in the returned map */
export function attributionKey(c: Pick<AssetChangeToAttribute, "assetId" | "serviceVersion" | "serviceUpdatedAt">): string {
  return `${c.assetId}@${c.serviceVersion}@${c.serviceUpdatedAt.toISOString()}`;
}
