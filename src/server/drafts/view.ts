import type { DesiredAsset } from "@/server/packages/types";
import { desiredContentHash, sameValue } from "@/server/plans/content";
import { STATUS_KEY } from "./rules";

/**
 * Pure view logic for the drafts list (pages/drafts.md): what a draft
 * changes, the row order, and the "also has a draft" notes. Unit-tested.
 */

export type DraftChangeKind = "create" | "content" | "status" | "metadata" | "none";

export interface DraftChange {
  kind: DraftChangeKind;
  /** The status the draft sets, for "Set Inactive" or "Set Active" */
  status: string | null;
  /** Metadata keys whose value differs from the base */
  metadataKeys: string[];
  /** The files differ from the base (content, or a file added or removed) */
  contentChanged: boolean;
}

/** What a draft changes against its base. A draft of a new asset is a create. */
export function draftChange(d: { desired: Pick<DesiredAsset, "metadata" | "files">; baseMetadata: Record<string, unknown> | null; baseContentHash: string | null }): DraftChange {
  if (!d.baseMetadata) return { kind: "create", status: null, metadataKeys: Object.keys(d.desired.metadata), contentChanged: true };
  const keys = [...new Set([...Object.keys(d.baseMetadata), ...Object.keys(d.desired.metadata)])].filter((k) => !sameValue(d.baseMetadata![k], d.desired.metadata[k])).sort();
  const contentChanged = d.baseContentHash !== null && desiredContentHash(d.desired.files) !== d.baseContentHash;
  const status = typeof d.desired.metadata[STATUS_KEY] === "string" ? (d.desired.metadata[STATUS_KEY] as string) : null;
  if (contentChanged) return { kind: "content", status, metadataKeys: keys, contentChanged };
  if (keys.length === 1 && keys[0] === STATUS_KEY) return { kind: "status", status, metadataKeys: keys, contentChanged };
  if (keys.length) return { kind: "metadata", status, metadataKeys: keys, contentChanged };
  return { kind: "none", status, metadataKeys: [], contentChanged };
}

export interface OrderableDraft {
  id: string;
  assetId: string | null;
  createdBy: string;
  planId: string | null;
  updatedAt: Date;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Row order: the viewer's drafts that aren't in a plan, then drafts in a plan
 * (grouped by plan, plans in the order their first draft was saved), then
 * other people's drafts. Within each group, saved time, oldest first.
 */
export function orderDrafts<T extends OrderableDraft>(rows: readonly T[], viewerEmail: string): T[] {
  const byTime = (a: T, b: T) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id);
  const mineFree = rows.filter((r) => !r.planId && same(r.createdBy, viewerEmail)).sort(byTime);
  const planned = rows.filter((r) => r.planId).sort(byTime);
  const planOrder = [...new Set(planned.map((r) => r.planId!))];
  const inPlans = planOrder.flatMap((p) => planned.filter((r) => r.planId === p));
  const others = rows.filter((r) => !r.planId && !same(r.createdBy, viewerEmail)).sort(byTime);
  return [...mineFree, ...inPlans, ...others];
}

/**
 * The note after the type label when someone else also has a draft of the
 * same asset: " · you also have a draft" on another person's row when the
 * viewer has one, otherwise " · <name> also has a draft".
 */
export function alsoHasDraftNote(row: OrderableDraft, all: readonly OrderableDraft[], viewerEmail: string, nameOf: (email: string) => string): string | null {
  if (!row.assetId) return null;
  const others = all.filter((r) => r.id !== row.id && r.assetId === row.assetId && !same(r.createdBy, row.createdBy));
  if (!others.length) return null;
  if (!same(row.createdBy, viewerEmail) && others.some((r) => same(r.createdBy, viewerEmail))) return "you also have a draft";
  const names = [...new Set(others.map((r) => nameOf(r.createdBy)))];
  return names.length === 1 ? `${names[0]} also has a draft` : `${names.length} other people also have drafts`;
}
