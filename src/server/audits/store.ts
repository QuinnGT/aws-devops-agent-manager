import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/server/db/client";
import { auditItems, audits, evidenceDocs, findings, journalTasks, reviews } from "@/server/db/schema";
import type { AuditProfile } from "@/server/policy/sections/audits";
import { snapshotProfile } from "./profiles";
import { itemReadiness, type ItemReadiness } from "./readiness";

/** Database edge of the audits module. Callers check permissions first; every read is scoped to a space. */

export type AuditRow = typeof audits.$inferSelect;
export type AuditItemRow = typeof auditItems.$inferSelect;
export type EvidenceDocRow = typeof evidenceDocs.$inferSelect;
export type ReviewRow = typeof reviews.$inferSelect;
export type FindingRow = typeof findings.$inferSelect;

export async function getAudit(spaceId: string, auditId: string): Promise<AuditRow | null> {
  if (!isUuid(auditId)) return null;
  const [row] = await db()
    .select()
    .from(audits)
    .where(and(eq(audits.spaceId, spaceId), eq(audits.id, auditId)));
  return row ?? null;
}

export async function getAuditById(auditId: string): Promise<AuditRow | null> {
  if (!isUuid(auditId)) return null;
  const [row] = await db().select().from(audits).where(eq(audits.id, auditId));
  return row ?? null;
}

export async function listAuditItems(auditId: string): Promise<AuditItemRow[]> {
  return db().select().from(auditItems).where(eq(auditItems.auditId, auditId)).orderBy(asc(auditItems.createdAt), asc(auditItems.taskId));
}

export async function getAuditItem(auditId: string, itemId: string): Promise<AuditItemRow | null> {
  if (!isUuid(itemId)) return null;
  const [row] = await db()
    .select()
    .from(auditItems)
    .where(and(eq(auditItems.auditId, auditId), eq(auditItems.id, itemId)));
  return row ?? null;
}

/** Current (not superseded) ground-truth documents for these incidents, optionally of these kinds. */
export async function currentEvidenceDocs(spaceId: string, incidentIds: string[], kinds?: string[]): Promise<EvidenceDocRow[]> {
  const ids = [...new Set(incidentIds)];
  if (!ids.length) return [];
  return db()
    .select()
    .from(evidenceDocs)
    .where(
      and(
        eq(evidenceDocs.spaceId, spaceId),
        inArray(evidenceDocs.incidentId, ids),
        isNull(evidenceDocs.supersededAt),
        kinds ? inArray(evidenceDocs.kind, kinds.length ? kinds : ["\0"]) : undefined,
      ),
    )
    .orderBy(asc(evidenceDocs.incidentId), asc(evidenceDocs.kind));
}

/** Task IDs of these that are in the space's journal cache. */
export async function cachedTaskIds(spaceId: string, taskIds: string[]): Promise<Set<string>> {
  if (!taskIds.length) return new Set();
  const rows = await db()
    .select({ taskId: journalTasks.taskId })
    .from(journalTasks)
    .where(and(eq(journalTasks.spaceId, spaceId), inArray(journalTasks.taskId, taskIds)));
  return new Set(rows.map((r) => r.taskId));
}

/** Readiness of each item: journal in the cache, required ground truth stored. */
export async function readinessOf(spaceId: string, items: readonly Pick<AuditItemRow, "id" | "taskId" | "incidentId">[], profile: AuditProfile): Promise<ItemReadiness[]> {
  const [cached, docs] = await Promise.all([
    cachedTaskIds(
      spaceId,
      items.map((i) => i.taskId),
    ),
    currentEvidenceDocs(
      spaceId,
      items.flatMap((i) => (i.incidentId ? [i.incidentId] : [])),
      profile.inputs.map((i) => i.kind),
    ),
  ]);
  const kindsByIncident = new Map<string, Set<string>>();
  for (const d of docs) {
    const s = kindsByIncident.get(d.incidentId) ?? new Set<string>();
    s.add(d.kind);
    kindsByIncident.set(d.incidentId, s);
  }
  return items.map((i) =>
    itemReadiness(i, { journalPresent: cached.has(i.taskId), docKinds: (i.incidentId && kindsByIncident.get(i.incidentId)) || new Set() }, profile),
  );
}

export function profileOf(audit: Pick<AuditRow, "profileSnapshot">): AuditProfile {
  return snapshotProfile(audit.profileSnapshot);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);
