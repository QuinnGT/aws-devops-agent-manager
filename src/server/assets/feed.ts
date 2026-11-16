import "server-only";
import { and, desc, eq, gte, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { CHANGE_SOURCES, type ChangeKind, type ChangeSource, type FeedItem } from "@/lib/assets/types";
import { db } from "@/server/db/client";
import { assetChanges, assetIndex } from "@/server/db/schema";
import { agentTypeLabel, assetLabel } from "@/server/history/display-name";
import { getAppPolicy, type Policy } from "@/server/policy";

/**
 * Change feed reads for Home and History (design-system pages/space-home.md,
 * "Data"): asset_changes joined to asset_index. Callers check assets.read or
 * history.read for the space first.
 */

export interface FeedFilters {
  sources?: readonly ChangeSource[];
  types?: readonly string[];
  /** Inclusive lower bound on the version's updatedAt */
  since?: Date;
  /** Case-insensitive substring of the asset name or its display name ("global" finds the Global instructions) */
  name?: string;
  /** Default 100, at most 500 */
  limit?: number;
  offset?: number;
}

const KINDS: readonly ChangeKind[] = ["created", "baseline", "content", "metadata", "deleted"];

export function toChangeSource(s: string): ChangeSource {
  return (CHANGE_SOURCES as readonly string[]).includes(s) ? (s as ChangeSource) : "unknown";
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Agent type IDs whose instruction file label ("Global instructions") contains `q`. Pure. */
export function agentTypesMatching(policy: Pick<Policy, "agentTypes">, q: string): string[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return policy.agentTypes.agentTypes.filter((a) => `${agentTypeLabel(policy, a.id)} instructions`.toLowerCase().includes(needle)).map((a) => a.id);
}

function feedWhere(spaceId: string, f: FeedFilters, policy: Pick<Policy, "agentTypes">): SQL[] {
  const where: SQL[] = [eq(assetChanges.spaceId, spaceId)];
  if (f.sources?.length) where.push(inArray(assetChanges.changeSource, [...f.sources]));
  if (f.types?.length) where.push(inArray(assetIndex.assetType, [...f.types]));
  if (f.since) where.push(gte(assetChanges.serviceUpdatedAt, f.since));
  const name = f.name?.trim();
  if (name) {
    const like = `%${escapeLike(name)}%`;
    const agentTypes = agentTypesMatching(policy, name);
    where.push(
      or(
        ilike(assetIndex.name, like),
        sql`${assetIndex.metadata}->>'title' ilike ${like}`,
        ...(agentTypes.length ? [and(eq(assetIndex.assetType, "agents_md"), inArray(assetIndex.name, agentTypes))] : []),
      )!,
    );
  }
  return where;
}

/** Changes newest first, with one row of look-ahead for `hasMore`. */
export async function listFeedItems(spaceId: string, f: FeedFilters = {}): Promise<{ items: FeedItem[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const offset = Math.max(f.offset ?? 0, 0);
  const policy = getAppPolicy().policy;
  const parent = alias(assetIndex, "parent");
  const rows = await db()
    .select({
      assetId: assetChanges.assetId,
      assetType: assetIndex.assetType,
      name: assetIndex.name,
      metadata: assetIndex.metadata,
      parentAssetId: assetIndex.parentAssetId,
      parentName: parent.name,
      version: assetChanges.serviceVersion,
      kind: assetChanges.changeKind,
      source: assetChanges.changeSource,
      sourceLabel: assetChanges.changeSourceLabel,
      principal: assetChanges.principal,
      at: assetChanges.serviceUpdatedAt,
      commit: assetChanges.commit,
      provisional: assetChanges.attributionProvisional,
      planId: assetChanges.planId,
      reason: sql<string | null>`(select r.reason from asset_reasons r where r.space_id = ${assetChanges.spaceId} and r.commit = ${assetChanges.commit} order by r.created_at desc limit 1)`,
      previousCommit: sql<
        string | null
      >`(select p.commit from asset_changes p where p.space_id = ${assetChanges.spaceId} and p.asset_id = ${assetChanges.assetId} and (p.service_updated_at, p.service_version) < (${assetChanges.serviceUpdatedAt}, ${assetChanges.serviceVersion}) order by p.service_updated_at desc, p.service_version desc limit 1)`,
    })
    .from(assetChanges)
    .innerJoin(assetIndex, and(eq(assetIndex.spaceId, assetChanges.spaceId), eq(assetIndex.assetId, assetChanges.assetId)))
    .leftJoin(parent, and(eq(parent.spaceId, assetIndex.spaceId), eq(parent.assetId, assetIndex.parentAssetId)))
    .where(and(...feedWhere(spaceId, f, policy)))
    .orderBy(desc(assetChanges.serviceUpdatedAt), desc(assetChanges.serviceVersion), assetChanges.assetId)
    .limit(limit + 1)
    .offset(offset);
  const items: FeedItem[] = rows.slice(0, limit).map((r) => ({
    assetId: r.assetId,
    assetType: r.assetType,
    name: assetLabel(policy, { assetType: r.assetType, name: r.name, assetId: r.assetId, metadata: r.metadata }),
    parentName: r.parentName ?? null,
    parentAssetId: r.parentAssetId,
    version: r.version,
    kind: KINDS.includes(r.kind) ? r.kind : "content",
    source: toChangeSource(r.source),
    sourceLabel: r.sourceLabel,
    principal: r.principal,
    at: r.at.toISOString(),
    commit: r.commit,
    provisional: r.provisional,
    hasReason: r.reason !== null,
    reason: r.reason,
    previousCommit: r.previousCommit,
    planId: r.planId,
  }));
  return { items, hasMore: rows.length > limit };
}

/** Recorded changes per source, every source present (zero when none). */
export async function countChangesBySource(spaceId: string): Promise<Record<ChangeSource, number>> {
  const rows = await db()
    .select({ source: assetChanges.changeSource, n: sql<number>`count(*)::int` })
    .from(assetChanges)
    .where(eq(assetChanges.spaceId, spaceId))
    .groupBy(assetChanges.changeSource);
  const out = Object.fromEntries(CHANGE_SOURCES.map((s) => [s, 0])) as Record<ChangeSource, number>;
  for (const r of rows) out[toChangeSource(r.source)] += Number(r.n);
  return out;
}

/** Unknown-source changes at or after `since` whose attribution is final (not provisional). */
export async function countSettledUnknownSince(spaceId: string, since: Date): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(assetChanges)
    .where(
      and(
        eq(assetChanges.spaceId, spaceId),
        eq(assetChanges.changeSource, "unknown"),
        eq(assetChanges.attributionProvisional, false),
        gte(assetChanges.serviceUpdatedAt, since),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Unknown-source changes of a space by why no source is known (words: `unknownReasonText` in src/server/attribution/words.ts). */
export interface UnknownReasonCounts {
  /** Older than the CloudTrail lookup period (`retentionSince`) */
  old: number;
  /** Recent; CloudTrail may not have delivered the event yet (provisional, looked up again later) */
  pending: number;
  /** The CloudTrail lookup failed */
  failed: number;
  /** Looked up, and CloudTrail had no matching event */
  noEvent: number;
}

export async function countUnknownByReason(spaceId: string, retentionSince: Date): Promise<UnknownReasonCounts> {
  const [row] = await db()
    .select({
      old: sql<number>`count(*) filter (where ${assetChanges.serviceUpdatedAt} < ${retentionSince})::int`,
      pending: sql<number>`count(*) filter (where ${assetChanges.serviceUpdatedAt} >= ${retentionSince} and ${assetChanges.attributionProvisional})::int`,
      failed: sql<number>`count(*) filter (where ${assetChanges.serviceUpdatedAt} >= ${retentionSince} and not ${assetChanges.attributionProvisional} and ${assetChanges.attributionMatchedBy} = 'error')::int`,
      noEvent: sql<number>`count(*) filter (where ${assetChanges.serviceUpdatedAt} >= ${retentionSince} and not ${assetChanges.attributionProvisional} and coalesce(${assetChanges.attributionMatchedBy}, 'none') <> 'error')::int`,
    })
    .from(assetChanges)
    .where(and(eq(assetChanges.spaceId, spaceId), eq(assetChanges.changeSource, "unknown")));
  return { old: Number(row?.old ?? 0), pending: Number(row?.pending ?? 0), failed: Number(row?.failed ?? 0), noEvent: Number(row?.noEvent ?? 0) };
}

/** Changes at or after `since`, per space, for the All spaces table. */
export async function countChangesSinceBySpace(spaceIds: readonly string[], since: Date): Promise<Map<string, number>> {
  if (spaceIds.length === 0) return new Map();
  const rows = await db()
    .select({ spaceId: assetChanges.spaceId, n: sql<number>`count(*)::int` })
    .from(assetChanges)
    .where(and(inArray(assetChanges.spaceId, [...spaceIds]), gte(assetChanges.serviceUpdatedAt, since)))
    .groupBy(assetChanges.spaceId);
  return new Map(rows.map((r) => [r.spaceId, Number(r.n)]));
}
