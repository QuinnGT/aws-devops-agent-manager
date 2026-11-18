import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/server/db/client";
import { audits, findings, plans, revisionChanges, revisions } from "@/server/db/schema";
import { validationFailedCount } from "@/server/plans/check";
import type { PlanSummary } from "@/server/plans/types";
import type { ChangelogFinding } from "./changelog";

/**
 * Postgres reads and writes for revisions. Callers check permissions first;
 * an ID from a client is always looked up together with the space ID.
 */

export type RevisionRow = typeof revisions.$inferSelect;
export type NewRevisionRow = typeof revisions.$inferInsert;
export type RevisionChangeRow = typeof revisionChanges.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (s: string): boolean => UUID_RE.test(s);

/** A revision of this space, or null. The ID alone never grants access to another space's revision. */
export async function getRevision(spaceId: string, revisionId: string): Promise<RevisionRow | null> {
  if (!isUuid(revisionId)) return null;
  const [row] = await db()
    .select()
    .from(revisions)
    .where(and(eq(revisions.spaceId, spaceId), eq(revisions.id, revisionId)));
  return row ?? null;
}

export async function getRevisionById(revisionId: string): Promise<RevisionRow | null> {
  if (!isUuid(revisionId)) return null;
  const [row] = await db().select().from(revisions).where(eq(revisions.id, revisionId));
  return row ?? null;
}

export async function getRevisionByNameKey(spaceId: string, nameKey: string): Promise<RevisionRow | null> {
  const [row] = await db()
    .select()
    .from(revisions)
    .where(and(eq(revisions.spaceId, spaceId), eq(revisions.nameKey, nameKey)));
  return row ?? null;
}

/** Names of the space's revisions that still hold their name (a failed one gives it back), for the New revision dialog. */
export async function revisionNames(spaceId: string): Promise<string[]> {
  const rows = await db().select({ name: revisions.name, state: revisions.state }).from(revisions).where(eq(revisions.spaceId, spaceId));
  return rows.filter((r) => r.state !== "failed").map((r) => r.name);
}

export async function listRevisionRows(spaceId: string, opts: { limit: number; offset: number }): Promise<RevisionRow[]> {
  return db().select().from(revisions).where(eq(revisions.spaceId, spaceId)).orderBy(desc(revisions.updatedAt), revisions.name).limit(opts.limit).offset(opts.offset);
}

export async function getRevisionByPlanId(planId: string): Promise<RevisionRow | null> {
  if (!isUuid(planId)) return null;
  const [row] = await db().select().from(revisions).where(eq(revisions.planId, planId));
  return row ?? null;
}

export async function updateRevision(revisionId: string, patch: Partial<Omit<NewRevisionRow, "id" | "spaceId">>): Promise<void> {
  await db()
    .update(revisions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(revisions.id, revisionId));
}

/** Changes of a revision, oldest first. */
export async function listChanges(revisionId: string): Promise<RevisionChangeRow[]> {
  return db().select().from(revisionChanges).where(eq(revisionChanges.revisionId, revisionId)).orderBy(asc(revisionChanges.createdAt), asc(revisionChanges.id));
}

/** Changes of many revisions, for the list page. */
export async function listChangesOf(revisionIds: readonly string[]): Promise<RevisionChangeRow[]> {
  if (!revisionIds.length) return [];
  return db()
    .select()
    .from(revisionChanges)
    .where(inArray(revisionChanges.revisionId, [...revisionIds]))
    .orderBy(asc(revisionChanges.createdAt));
}

/**
 * Findings of this space by ID, with their audit name and checked citations,
 * whatever their state (the change record keeps citing a finding that was
 * later rejected; the detail page says so).
 */
export async function findingsForChangelog(spaceId: string, ids: readonly string[]): Promise<(ChangelogFinding & { state: string; kind: string; auditId: string })[]> {
  const wanted = [...new Set(ids)].filter(isUuid);
  if (!wanted.length) return [];
  const rows = await db()
    .select({
      id: findings.id,
      auditId: findings.auditId,
      auditName: audits.name,
      incidentId: findings.incidentId,
      title: findings.title,
      kind: findings.kind,
      state: findings.state,
      citations: findings.citations,
    })
    .from(findings)
    .innerJoin(audits, eq(audits.id, findings.auditId))
    .where(and(eq(findings.spaceId, spaceId), inArray(findings.id, wanted)));
  return rows.map((r) => ({
    id: r.id,
    auditId: r.auditId,
    auditName: r.auditName,
    incidentId: r.incidentId,
    title: r.title,
    kind: r.kind,
    state: r.state,
    citations: (r.citations ?? []).map((c) => ({ record: c.record, quote: c.quote, ok: c.ok })),
  }));
}

export interface PlanStateRow {
  state: string;
  title: string;
  resultCommit: string | null;
  spaceId: string;
  origin: unknown;
  /** The last live-space check failed (the plan page's badge says "Check failed") */
  checkFailed: boolean;
  /** The last check found a validation error (the badge says "Validation failed") */
  validationFailed: boolean;
}

/** State, title, apply result and check outcome of plans by ID. */
export async function planStates(planIds: readonly string[]): Promise<Map<string, PlanStateRow>> {
  const ids = [...new Set(planIds)].filter(isUuid);
  if (!ids.length) return new Map();
  const rows = await db()
    .select({ id: plans.id, state: plans.state, title: plans.title, resultCommit: plans.resultCommit, spaceId: plans.spaceId, origin: plans.origin, checkError: plans.checkError, summary: plans.summary })
    .from(plans)
    .where(inArray(plans.id, ids));
  return new Map(
    rows.map(({ id, checkError, summary, ...r }) => [id, { ...r, checkFailed: Boolean(checkError), validationFailed: validationFailedCount(summary as PlanSummary | null) > 0 }]),
  );
}
