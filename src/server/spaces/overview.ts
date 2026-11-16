import { and, asc, count, eq, isNull } from "drizzle-orm";
import { db } from "@/server/db/client";
import { assetIndex, journalTasks, syncState } from "@/server/db/schema";

/** Read model for the space overview page. Callers check `assets.read` for the space first. */

export type SyncStateRow = typeof syncState.$inferSelect;

export interface SpaceOverview {
  sync: SyncStateRow | null;
  /** Live (not deleted) assets in asset_index, by type */
  assetCounts: { assetType: string; count: number }[];
  /** Investigations cached in journal_tasks */
  investigationCount: number;
}

export async function getSpaceOverview(spaceId: string): Promise<SpaceOverview> {
  const [syncRows, assetCounts, tasks] = await Promise.all([
    db().select().from(syncState).where(eq(syncState.spaceId, spaceId)),
    db()
      .select({ assetType: assetIndex.assetType, count: count() })
      .from(assetIndex)
      .where(and(eq(assetIndex.spaceId, spaceId), isNull(assetIndex.deletedAt)))
      .groupBy(assetIndex.assetType)
      .orderBy(asc(assetIndex.assetType)),
    db().select({ count: count() }).from(journalTasks).where(eq(journalTasks.spaceId, spaceId)),
  ]);
  return { sync: syncRows[0] ?? null, assetCounts, investigationCount: tasks[0]?.count ?? 0 };
}

/** Memory store names known for a space, for the per-store commit policy editor. */
export async function listMemoryStoreNames(spaceId: string): Promise<string[]> {
  const rows = await db()
    .select({ name: assetIndex.name })
    .from(assetIndex)
    .where(and(eq(assetIndex.spaceId, spaceId), eq(assetIndex.assetType, "memory_store"), isNull(assetIndex.deletedAt)))
    .orderBy(asc(assetIndex.name));
  return [...new Set(rows.map((r) => r.name))];
}
