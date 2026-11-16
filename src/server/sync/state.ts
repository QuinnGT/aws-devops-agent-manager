import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { assetChanges, assetIndex, syncState } from "@/server/db/schema";

/** Postgres access for the sync engine (worker only writes these tables). */

export type IndexRow = typeof assetIndex.$inferSelect;
export type ChangeRow = typeof assetChanges.$inferInsert;
export type SyncStateRow = typeof syncState.$inferSelect;
export type SyncStatePatch = Partial<Omit<typeof syncState.$inferInsert, "spaceId">>;

export async function loadIndex(spaceId: string): Promise<Map<string, IndexRow>> {
  const rows = await db().select().from(assetIndex).where(eq(assetIndex.spaceId, spaceId));
  return new Map(rows.map((r) => [r.assetId, r]));
}

/** Latest recorded updatedAt per (asset, version), ignoring deletion rows. */
export async function loadRecorded(spaceId: string): Promise<Map<string, Map<number, Date>>> {
  const rows = await db()
    .select({
      assetId: assetChanges.assetId,
      version: assetChanges.serviceVersion,
      updatedAt: sql<Date>`max(${assetChanges.serviceUpdatedAt})`.mapWith((v: string | Date) => new Date(v)),
    })
    .from(assetChanges)
    .where(and(eq(assetChanges.spaceId, spaceId), ne(assetChanges.changeKind, "deleted")))
    .groupBy(assetChanges.assetId, assetChanges.serviceVersion);
  const out = new Map<string, Map<number, Date>>();
  for (const r of rows) {
    let m = out.get(r.assetId);
    if (!m) out.set(r.assetId, (m = new Map()));
    m.set(r.version, r.updatedAt);
  }
  return out;
}

export async function getSyncStateRow(spaceId: string): Promise<SyncStateRow | null> {
  const [row] = await db().select().from(syncState).where(eq(syncState.spaceId, spaceId));
  return row ?? null;
}

export async function patchSyncState(spaceId: string, patch: SyncStatePatch): Promise<void> {
  await db()
    .insert(syncState)
    .values({ spaceId, ...patch })
    .onConflictDoUpdate({ target: syncState.spaceId, set: patch });
}

export interface LiveIndexValues {
  spaceId: string;
  assetId: string;
  assetType: string;
  name: string;
  parentAssetId: string | null;
  liveVersion: number;
  liveUpdatedAt: Date;
  metadata: Record<string, unknown> | unknown;
  createdAt: Date;
}

/** Upsert the live state of listed assets; git fields are left as they are. Clears deletedAt. */
export async function upsertLive(rows: LiveIndexValues[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, deletedAt: null }));
    await db()
      .insert(assetIndex)
      .values(chunk)
      .onConflictDoUpdate({
        target: [assetIndex.spaceId, assetIndex.assetId],
        set: {
          assetType: sql`excluded.asset_type`,
          name: sql`excluded.name`,
          parentAssetId: sql`excluded.parent_asset_id`,
          liveVersion: sql`excluded.live_version`,
          liveUpdatedAt: sql`excluded.live_updated_at`,
          metadata: sql`excluded.metadata`,
          createdAt: sql`excluded.created_at`,
          deletedAt: sql`null`,
        },
      });
  }
}

export type IndexGitPatch = Partial<
  Pick<IndexRow, "name" | "metadata" | "parentAssetId" | "gitPath" | "lastCommit" | "lastSyncedVersion" | "lastSyncedUpdatedAt" | "deletedAt">
>;

/** Record one committed change and the asset's new git state in one transaction. */
export async function recordChange(change: ChangeRow, index: IndexGitPatch, extraIndex: { assetId: string; patch: IndexGitPatch }[] = []): Promise<void> {
  await db().transaction(async (tx) => {
    await tx
      .insert(assetChanges)
      .values(change)
      .onConflictDoUpdate({
        target: [assetChanges.spaceId, assetChanges.assetId, assetChanges.serviceVersion, assetChanges.serviceUpdatedAt],
        set: {
          changeKind: change.changeKind,
          commit: change.commit,
          changeSource: change.changeSource ?? "unknown",
          changeSourceLabel: change.changeSourceLabel ?? null,
          principal: change.principal ?? null,
          cloudTrailEventId: change.cloudTrailEventId ?? null,
          planId: change.planId ?? null,
          attributionMatchedBy: change.attributionMatchedBy ?? null,
          attributionProvisional: change.attributionProvisional ?? false,
          gitPath: change.gitPath ?? null,
          recordedAt: sql`now()`,
        },
      });
    await tx
      .update(assetIndex)
      .set(index)
      .where(and(eq(assetIndex.spaceId, change.spaceId), eq(assetIndex.assetId, change.assetId)));
    for (const e of extraIndex) {
      await tx
        .update(assetIndex)
        .set(e.patch)
        .where(and(eq(assetIndex.spaceId, change.spaceId), eq(assetIndex.assetId, e.assetId)));
    }
  });
}

export async function patchIndex(spaceId: string, assetId: string, patch: IndexGitPatch): Promise<void> {
  await db()
    .update(assetIndex)
    .set(patch)
    .where(and(eq(assetIndex.spaceId, spaceId), eq(assetIndex.assetId, assetId)));
}
