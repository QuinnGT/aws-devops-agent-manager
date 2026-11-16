import { and, desc, eq, gte, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/server/db/client";
import { assetChanges, assetIndex, assetReasons, syncState } from "@/server/db/schema";
import { ASSET_BROWSER } from "./config";

/**
 * Postgres reads for the asset browser. asset_index, asset_changes and
 * sync_state are written by the sync worker; asset_reasons by this module's
 * add-reason job. Callers check assets.read or history.read first.
 */

export type IndexedAsset = typeof assetIndex.$inferSelect;
export type AssetChange = typeof assetChanges.$inferSelect;
export type AssetReason = typeof assetReasons.$inferSelect;
export type SyncStateRow = typeof syncState.$inferSelect;

export async function listIndexedAssets(spaceId: string, opts: { assetType?: string; includeDeleted?: boolean } = {}): Promise<IndexedAsset[]> {
  const where: SQL[] = [eq(assetIndex.spaceId, spaceId)];
  if (opts.assetType) where.push(eq(assetIndex.assetType, opts.assetType));
  if (!opts.includeDeleted) where.push(isNull(assetIndex.deletedAt));
  return db()
    .select()
    .from(assetIndex)
    .where(and(...where))
    .orderBy(assetIndex.name, assetIndex.assetId);
}

export async function getIndexedAsset(spaceId: string, assetId: string): Promise<IndexedAsset | null> {
  const [row] = await db()
    .select()
    .from(assetIndex)
    .where(and(eq(assetIndex.spaceId, spaceId), eq(assetIndex.assetId, assetId)));
  return row ?? null;
}

/** Live (not deleted) assets per type. */
export async function countAssetsByType(spaceId: string): Promise<Record<string, number>> {
  const rows = await db()
    .select({ assetType: assetIndex.assetType, n: sql<number>`count(*)::int` })
    .from(assetIndex)
    .where(and(eq(assetIndex.spaceId, spaceId), isNull(assetIndex.deletedAt)))
    .groupBy(assetIndex.assetType);
  return Object.fromEntries(rows.map((r) => [r.assetType, Number(r.n)]));
}

/** Every indexed asset of the space by ID (name, type, parent, deleted), for resolving references. */
export async function assetDirectory(spaceId: string): Promise<Map<string, Pick<IndexedAsset, "name" | "assetType" | "parentAssetId" | "deletedAt">>> {
  const rows = await db()
    .select({ assetId: assetIndex.assetId, name: assetIndex.name, assetType: assetIndex.assetType, parentAssetId: assetIndex.parentAssetId, deletedAt: assetIndex.deletedAt })
    .from(assetIndex)
    .where(eq(assetIndex.spaceId, spaceId));
  return new Map(rows.map(({ assetId, ...r }) => [assetId, r]));
}

/** The most recent change of each asset (for "source of the last change"). */
export async function latestChangeByAsset(spaceId: string, assetIds?: readonly string[]): Promise<Map<string, AssetChange>> {
  if (assetIds && assetIds.length === 0) return new Map();
  const where: SQL[] = [eq(assetChanges.spaceId, spaceId)];
  if (assetIds) where.push(inArray(assetChanges.assetId, [...assetIds]));
  const rows = await db()
    .selectDistinctOn([assetChanges.assetId])
    .from(assetChanges)
    .where(and(...where))
    .orderBy(assetChanges.assetId, desc(assetChanges.serviceUpdatedAt), desc(assetChanges.serviceVersion), desc(assetChanges.recordedAt));
  return new Map(rows.map((r) => [r.assetId, r]));
}

export async function listAssetChanges(spaceId: string, assetId: string): Promise<AssetChange[]> {
  return db()
    .select()
    .from(assetChanges)
    .where(and(eq(assetChanges.spaceId, spaceId), eq(assetChanges.assetId, assetId)))
    .orderBy(desc(assetChanges.serviceUpdatedAt), desc(assetChanges.serviceVersion));
}

export async function getAssetChangeByCommit(spaceId: string, assetId: string, commit: string): Promise<AssetChange | null> {
  const [row] = await db()
    .select()
    .from(assetChanges)
    .where(and(eq(assetChanges.spaceId, spaceId), eq(assetChanges.assetId, assetId), eq(assetChanges.commit, commit)))
    .limit(1);
  return row ?? null;
}

export interface TimelineFilters {
  assetType?: string;
  source?: string;
  /** Inclusive lower bound on the version's updatedAt */
  from?: Date;
  /** Exclusive upper bound on the version's updatedAt */
  to?: Date;
  assetId?: string;
  /** Words that must appear in a change reason added for the change */
  reason?: string;
  limit?: number;
  offset?: number;
}

export interface TimelineRow extends AssetChange {
  assetName: string | null;
  assetType: string | null;
  assetDeletedAt: Date | null;
}

/** Space-wide change timeline, newest first. Returns one extra row's worth of information through `hasMore`. */
export async function listSpaceChanges(spaceId: string, f: TimelineFilters = {}): Promise<{ rows: TimelineRow[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(f.limit ?? ASSET_BROWSER.timelinePageSize, 1), 500);
  const offset = Math.max(f.offset ?? 0, 0);
  const where: SQL[] = [eq(assetChanges.spaceId, spaceId)];
  if (f.assetType) where.push(eq(assetIndex.assetType, f.assetType));
  if (f.source) where.push(eq(assetChanges.changeSource, f.source));
  if (f.from) where.push(gte(assetChanges.serviceUpdatedAt, f.from));
  if (f.to) where.push(sql`${assetChanges.serviceUpdatedAt} < ${f.to}`);
  if (f.assetId) where.push(eq(assetChanges.assetId, f.assetId));
  const reason = f.reason?.trim();
  if (reason) {
    where.push(
      sql`exists (select 1 from ${assetReasons} where ${assetReasons.spaceId} = ${assetChanges.spaceId} and ${assetReasons.commit} = ${assetChanges.commit} and to_tsvector('simple', ${assetReasons.reason}) @@ plainto_tsquery('simple', ${reason}))`,
    );
  }
  const rows = await db()
    .select({
      change: assetChanges,
      assetName: assetIndex.name,
      assetType: assetIndex.assetType,
      assetDeletedAt: assetIndex.deletedAt,
    })
    .from(assetChanges)
    .leftJoin(assetIndex, and(eq(assetIndex.spaceId, assetChanges.spaceId), eq(assetIndex.assetId, assetChanges.assetId)))
    .where(and(...where))
    .orderBy(desc(assetChanges.serviceUpdatedAt), desc(assetChanges.serviceVersion), assetChanges.assetId)
    .limit(limit + 1)
    .offset(offset);
  return {
    rows: rows.slice(0, limit).map((r) => ({ ...r.change, assetName: r.assetName, assetType: r.assetType, assetDeletedAt: r.assetDeletedAt })),
    hasMore: rows.length > limit,
  };
}

/** Change sources present in the space, for the timeline filter. */
export async function distinctChangeSources(spaceId: string): Promise<string[]> {
  const rows = await db()
    .selectDistinct({ s: assetChanges.changeSource })
    .from(assetChanges)
    .where(eq(assetChanges.spaceId, spaceId));
  return rows.map((r) => r.s).sort();
}

/** Reasons indexed for commits, oldest first per commit. */
export async function reasonsForCommits(spaceId: string, commits: readonly string[]): Promise<Map<string, AssetReason[]>> {
  if (commits.length === 0) return new Map();
  const rows = await db()
    .select()
    .from(assetReasons)
    .where(and(eq(assetReasons.spaceId, spaceId), inArray(assetReasons.commit, [...new Set(commits)])))
    .orderBy(assetReasons.createdAt);
  const out = new Map<string, AssetReason[]>();
  for (const r of rows) out.set(r.commit, [...(out.get(r.commit) ?? []), r]);
  return out;
}

export async function getSyncState(spaceId: string): Promise<SyncStateRow | null> {
  const [row] = await db().select().from(syncState).where(eq(syncState.spaceId, spaceId));
  return row ?? null;
}

/** Inclusive date filter helper: "2026-11-10" as the end date means before 2026-11-11T00:00Z. */
export function endOfDayExclusive(day: Date): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1));
}
