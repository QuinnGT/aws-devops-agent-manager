import { and, asc, count, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { assetChanges, assetIndex, syncState } from "@/server/db/schema";

/**
 * Read helpers for the sync tables, used by the UI (asset
 * browser, history, space pages). Callers check permissions for the space
 * first. `gitPath` is authoritative for where an asset lives in the history
 * repository (it follows renames and the rare path collision suffix).
 */

export type AssetIndexEntry = typeof assetIndex.$inferSelect;
export type AssetChange = typeof assetChanges.$inferSelect;

export interface SyncStatus {
  spaceId: string;
  /** "never" | "running" | "succeeded" | "error" | "cancelled" */
  status: string;
  error: string | null;
  lastSyncStartedAt: Date | null;
  lastSyncCompletedAt: Date | null;
  lastReconcileAt: Date | null;
  baselineCompletedAt: Date | null;
  /** ListAssets updatedAfter cursor */
  cursor: Date | null;
  liveAssets: number;
  deletedAssets: number;
  /** Live assets with versions not yet in git (for example held back by a daily store policy) */
  pendingAssets: number;
  lastResult: unknown;
}

export async function getSyncStatus(spaceId: string): Promise<SyncStatus> {
  const [state] = await db().select().from(syncState).where(eq(syncState.spaceId, spaceId));
  const [counts] = await db()
    .select({
      live: sql<number>`count(*) filter (where ${assetIndex.deletedAt} is null)`.mapWith(Number),
      deleted: sql<number>`count(*) filter (where ${assetIndex.deletedAt} is not null)`.mapWith(Number),
      pending: sql<number>`count(*) filter (where ${assetIndex.deletedAt} is null and (${assetIndex.lastSyncedVersion} is distinct from ${assetIndex.liveVersion} or ${assetIndex.lastSyncedUpdatedAt} is distinct from ${assetIndex.liveUpdatedAt}))`.mapWith(Number),
    })
    .from(assetIndex)
    .where(eq(assetIndex.spaceId, spaceId));
  return {
    spaceId,
    status: state?.status ?? "never",
    error: state?.error ?? null,
    lastSyncStartedAt: state?.lastSyncStartedAt ?? null,
    lastSyncCompletedAt: state?.lastSyncCompletedAt ?? null,
    lastReconcileAt: state?.lastReconcileAt ?? null,
    baselineCompletedAt: state?.baselineCompletedAt ?? null,
    cursor: state?.updatedAfter ?? null,
    liveAssets: counts?.live ?? 0,
    deletedAssets: counts?.deleted ?? 0,
    pendingAssets: counts?.pending ?? 0,
    lastResult: state?.lastResult ?? null,
  };
}

/** Assets of a space, optionally of one type, ordered by type and name. Deleted assets only when asked. */
export async function listAssetIndex(spaceId: string, opts: { assetType?: string; includeDeleted?: boolean } = {}): Promise<AssetIndexEntry[]> {
  const where = [eq(assetIndex.spaceId, spaceId)];
  if (opts.assetType) where.push(eq(assetIndex.assetType, opts.assetType));
  if (!opts.includeDeleted) where.push(isNull(assetIndex.deletedAt));
  return db()
    .select()
    .from(assetIndex)
    .where(and(...where))
    .orderBy(asc(assetIndex.assetType), asc(assetIndex.name), asc(assetIndex.assetId));
}

export async function getAssetIndexEntry(spaceId: string, assetId: string): Promise<AssetIndexEntry | null> {
  const [row] = await db()
    .select()
    .from(assetIndex)
    .where(and(eq(assetIndex.spaceId, spaceId), eq(assetIndex.assetId, assetId)));
  return row ?? null;
}

/** Memories of one memory store. */
export async function listMemoriesInStore(spaceId: string, storeAssetId: string, opts: { includeDeleted?: boolean } = {}): Promise<AssetIndexEntry[]> {
  const where = [eq(assetIndex.spaceId, spaceId), eq(assetIndex.assetType, "memory"), eq(assetIndex.parentAssetId, storeAssetId)];
  if (!opts.includeDeleted) where.push(isNull(assetIndex.deletedAt));
  return db()
    .select()
    .from(assetIndex)
    .where(and(...where))
    .orderBy(asc(assetIndex.name));
}

/** Number of live assets per asset type. */
export async function countAssetsByType(spaceId: string): Promise<Record<string, number>> {
  const rows = await db()
    .select({ assetType: assetIndex.assetType, n: count() })
    .from(assetIndex)
    .where(and(eq(assetIndex.spaceId, spaceId), isNull(assetIndex.deletedAt)))
    .groupBy(assetIndex.assetType);
  return Object.fromEntries(rows.map((r) => [r.assetType, r.n]));
}

/** Recorded changes of one asset, newest first. */
export async function listAssetChanges(spaceId: string, assetId: string, opts: { limit?: number } = {}): Promise<AssetChange[]> {
  return db()
    .select()
    .from(assetChanges)
    .where(and(eq(assetChanges.spaceId, spaceId), eq(assetChanges.assetId, assetId)))
    .orderBy(desc(assetChanges.serviceUpdatedAt), desc(assetChanges.serviceVersion))
    .limit(Math.min(Math.max(opts.limit ?? 200, 1), 1000));
}

/** Recorded changes across a space, newest first; pass `before` to page back in time. */
export async function listRecentChanges(spaceId: string, opts: { limit?: number; before?: Date } = {}): Promise<AssetChange[]> {
  const where = [eq(assetChanges.spaceId, spaceId)];
  if (opts.before) where.push(lt(assetChanges.serviceUpdatedAt, opts.before));
  return db()
    .select()
    .from(assetChanges)
    .where(and(...where))
    .orderBy(desc(assetChanges.serviceUpdatedAt), desc(assetChanges.assetId))
    .limit(Math.min(Math.max(opts.limit ?? 100, 1), 1000));
}
