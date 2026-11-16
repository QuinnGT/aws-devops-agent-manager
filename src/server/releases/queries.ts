import { and, asc, desc, eq, gt, ne } from "drizzle-orm";
import { db } from "@/server/db/client";
import { assetChanges, releases } from "@/server/db/schema";
import { RELEASES } from "./config";

/**
 * Postgres reads and writes for releases. The releases table is written only
 * by the release job; callers check permissions first.
 */

export type ReleaseRow = typeof releases.$inferSelect;
export type NewReleaseRow = typeof releases.$inferInsert;

export async function listReleases(spaceId: string): Promise<ReleaseRow[]> {
  return db().select().from(releases).where(eq(releases.spaceId, spaceId)).orderBy(desc(releases.createdAt), releases.name).limit(RELEASES.maxListed);
}

export async function getRelease(spaceId: string, releaseId: string): Promise<ReleaseRow | null> {
  const [row] = await db()
    .select()
    .from(releases)
    .where(and(eq(releases.spaceId, spaceId), eq(releases.id, releaseId)));
  return row ?? null;
}

export async function getReleaseByName(spaceId: string, name: string): Promise<ReleaseRow | null> {
  const [row] = await db()
    .select()
    .from(releases)
    .where(and(eq(releases.spaceId, spaceId), eq(releases.name, name)));
  return row ?? null;
}

/** The space's newest release, or null. */
export async function latestRelease(spaceId: string): Promise<ReleaseRow | null> {
  const [row] = await db().select().from(releases).where(eq(releases.spaceId, spaceId)).orderBy(desc(releases.createdAt), releases.name).limit(1);
  return row ?? null;
}

/** Service times (ms, ascending) of the space's recorded changes after `after`, for "changes since" counts. */
export async function changeTimesAfter(spaceId: string, after: Date): Promise<number[]> {
  const rows = await db()
    .select({ at: assetChanges.serviceUpdatedAt })
    .from(assetChanges)
    .where(and(eq(assetChanges.spaceId, spaceId), gt(assetChanges.serviceUpdatedAt, after)))
    .orderBy(asc(assetChanges.serviceUpdatedAt));
  return rows.map((r) => r.at.getTime());
}

export async function getReleaseById(releaseId: string): Promise<ReleaseRow | null> {
  const [row] = await db().select().from(releases).where(eq(releases.id, releaseId));
  return row ?? null;
}

/** Names of the space's releases, optionally without one release (a retried job). */
export async function releaseNames(spaceId: string, exceptId?: string): Promise<string[]> {
  const where = exceptId ? and(eq(releases.spaceId, spaceId), ne(releases.id, exceptId)) : eq(releases.spaceId, spaceId);
  const rows = await db().select({ name: releases.name }).from(releases).where(where);
  return rows.map((r) => r.name);
}

/** Insert a release row; a retried job that already inserted it is a no-op. */
export async function insertRelease(row: NewReleaseRow): Promise<void> {
  await db().insert(releases).values(row).onConflictDoNothing({ target: releases.id });
}

/** Commits recorded for one service version of an asset, latest state of the version first (not deletions). */
export async function commitsForVersion(spaceId: string, assetId: string, version: number): Promise<{ commit: string; gitPath: string | null }[]> {
  const rows = await db()
    .select({ commit: assetChanges.commit, gitPath: assetChanges.gitPath, kind: assetChanges.changeKind })
    .from(assetChanges)
    .where(and(eq(assetChanges.spaceId, spaceId), eq(assetChanges.assetId, assetId), eq(assetChanges.serviceVersion, version)))
    .orderBy(desc(assetChanges.serviceUpdatedAt), desc(assetChanges.recordedAt));
  return rows.filter((r) => r.kind !== "deleted").map((r) => ({ commit: r.commit, gitPath: r.gitPath }));
}
