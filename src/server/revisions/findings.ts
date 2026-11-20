import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAuditEvent } from "@/server/audit-log";
import { listLinkableFindings } from "@/server/audits/linkable";
import { db } from "@/server/db/client";
import { revisionChanges, revisions } from "@/server/db/schema";
import { policyForSpace } from "@/server/journals/policy";
import type { Space } from "@/server/spaces/queries";
import { existingReleaseIds, findingStates, isUuid, listChangesOf, planStates, getRevision, type RevisionRow } from "./queries";
import { requestCreateRevision } from "./service";
import { acceptedOnList, mergeToAddress, takeOffList } from "./to-address";
import { RevisionError, type RevisionActor } from "./types";

/**
 * CONTRACT between audits and revisions: accepted package fixes go from an
 * audit into a revision. A revision keeps a "to address" list of findings sent
 * to it; a save that links a finding takes it off the list. The audit page
 * shows, for each finding, the revisions it went to and how far they got.
 *
 * Do not change these exported shapes; add optional fields or new exports only.
 *
 * The list holds finding IDs. A finding that is reopened or rejected on its
 * audit stays on it, and the pages show it as no longer accepted (it can't be
 * linked until it is accepted again, and it isn't counted in `toAddress`).
 * The callers hold `revisions.build` for the space (REVISION_PERMISSIONS.build).
 */

/** A revision a finding can be sent to (state open, or creating). */
export interface RevisionOption {
  id: string;
  name: string;
  state: string;
  packageName: string;
  /** Findings on its to-address list that are accepted now */
  toAddress: number;
  /** Distinct findings linked by its saves */
  linked: number;
  updatedAt: Date;
}

/** Where one finding went: a revision that has it to address, or a save that linked it. */
export interface FindingRevisionLink {
  revisionId: string;
  revisionName: string;
  revisionState: string;
  kind: "to-address" | "linked";
  /** The revision's plan, once one was made from it */
  planId: string | null;
  planState: string | null;
  /** The release tagged when that plan was applied; null until the release exists */
  releaseName: string | null;
}

/** States of a revision that takes findings: its create job may still be running. */
const TAKES_FINDINGS = ["creating", "open"] as const;
const takesFindings = (state: string): boolean => (TAKES_FINDINGS as readonly string[]).includes(state);

function badRequest(err: z.ZodError): RevisionError {
  const issue = err.issues[0];
  return new RevisionError("bad-request", issue?.message ?? "The request is not valid.", issue?.path.length ? { [String(issue.path[0])]: issue.message } : {});
}

const findingIdsSchema = z.array(z.string().uuid("Choose accepted findings.")).min(1, "Choose at least one finding.");
const addSchema = z.object({ revisionId: z.string().uuid("Choose a revision."), findingIds: findingIdsSchema });
const removeSchema = z.object({ revisionId: z.string().uuid("Choose a revision."), findingId: z.string().uuid("Choose a finding.") });
const createSchema = z.object({ name: z.string().trim(), findingIds: findingIdsSchema, note: z.string().optional() });

/** Why findings can't go to a revision, in plain words. `states` has the findings of this space that exist. */
function notAddable(missing: readonly string[], states: ReadonlyMap<string, string>): RevisionError {
  const fieldErrors = { findingIds: "Send only accepted findings of this space." };
  if (missing.length > 1) {
    return new RevisionError("finding-not-linkable", `${missing.length} of the findings can't go to a revision: they aren't accepted findings of this space that a revision can link.`, fieldErrors);
  }
  const state = states.get(missing[0]!);
  const why = state === undefined ? "it isn't a finding of this space" : state !== "accepted" ? "it isn't accepted" : "its kind of finding can't be linked to a revision";
  return new RevisionError("finding-not-linkable", `That finding can't go to a revision: ${why}.`, fieldErrors);
}

/** Refuse (RevisionError) a finding that isn't accepted, isn't linkable in its audit's profile, or isn't of this space. Returns the IDs without repeats. */
async function requireAddable(spaceId: string, findingIds: readonly string[], maxFindings: number): Promise<string[]> {
  const ids = [...new Set(findingIds)];
  if (ids.length > maxFindings) throw new RevisionError("too-large", `A revision's to-address list holds at most ${maxFindings} findings.`, { findingIds: "Too many findings." });
  const ok = new Set((await listLinkableFindings(spaceId, { ids, limit: ids.length })).map((f) => f.id));
  const missing = ids.filter((id) => !ok.has(id));
  if (missing.length) throw notAddable(missing, await findingStates(spaceId, missing));
  return ids;
}

function requireTakesFindings(row: RevisionRow): void {
  if (!takesFindings(row.state)) throw new RevisionError("not-open", `The revision is ${row.state}, so its to-address list can't change.`);
}

/** Findings the revision's saves linked (distinct). */
function linkedIds(changes: readonly { findingIds: string[] }[]): Set<string> {
  return new Set(changes.flatMap((c) => c.findingIds));
}

/** Revisions of the space that can take findings, newest first. */
export async function listRevisionOptions(space: Space): Promise<RevisionOption[]> {
  const rows = await db()
    .select()
    .from(revisions)
    .where(and(eq(revisions.spaceId, space.id), inArray(revisions.state, [...TAKES_FINDINGS])))
    .orderBy(desc(revisions.updatedAt), revisions.name);
  if (!rows.length) return [];
  const [changes, states] = await Promise.all([listChangesOf(rows.map((r) => r.id)), findingStates(space.id, rows.flatMap((r) => r.toAddressFindingIds))]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    state: r.state,
    packageName: r.packageName,
    toAddress: acceptedOnList(r.toAddressFindingIds, states),
    linked: linkedIds(changes.filter((c) => c.revisionId === r.id)).size,
    updatedAt: r.updatedAt,
  }));
}

/**
 * Put accepted, linkable findings of this space on an open (or creating) revision's
 * to-address list. Findings already on the list or already linked are counted, not added.
 * Refuses (RevisionError) a finding that is not accepted, not linkable or of another space.
 * Permission revisions.build. Records an audit event.
 */
export async function addFindingsToRevision(space: Space, input: { revisionId: string; findingIds: string[] }, actor: RevisionActor): Promise<{ revisionId: string; added: number; alreadyThere: number }> {
  const parsed = addSchema.safeParse(input);
  if (!parsed.success) throw badRequest(parsed.error);
  const req = parsed.data;
  const { policy } = await policyForSpace(space);
  const max = policy.revisions.toAddress.maxFindings;
  const row = await getRevision(space.id, req.revisionId);
  if (!row) throw new RevisionError("not-found", "There is no such revision in this space.");
  requireTakesFindings(row);
  const ids = await requireAddable(space.id, req.findingIds, max);

  // The row's lock orders this against a save that links findings (save.ts) and against another add.
  const result = await db().transaction(async (tx) => {
    const [cur] = await tx.select().from(revisions).where(and(eq(revisions.id, row.id), eq(revisions.spaceId, space.id))).for("update");
    if (!cur) throw new RevisionError("not-found", "There is no such revision in this space.");
    requireTakesFindings(cur);
    const changes = await tx.select({ findingIds: revisionChanges.findingIds }).from(revisionChanges).where(eq(revisionChanges.revisionId, cur.id));
    const merged = mergeToAddress(cur.toAddressFindingIds, linkedIds(changes), ids);
    if (merged.next.length > max) throw new RevisionError("too-large", `The to-address list holds at most ${max} findings, and this would make ${merged.next.length}.`, { findingIds: "Too many findings." });
    if (merged.added.length) await tx.update(revisions).set({ toAddressFindingIds: merged.next, updatedAt: new Date() }).where(eq(revisions.id, cur.id));
    return { name: cur.name, ...merged };
  });
  if (result.added.length) {
    await recordAuditEvent({
      actor,
      action: "revision.findings.add",
      spaceId: space.id,
      targetType: "revision",
      targetId: row.id,
      details: { name: result.name, findingIds: result.added, added: result.added.length, alreadyThere: result.alreadyThere },
    });
  }
  return { revisionId: row.id, added: result.added.length, alreadyThere: result.alreadyThere };
}

/**
 * Take one finding off a revision's to-address list (a person decided it isn't
 * for this revision). `removed` is false when it was not on the list. The revision
 * must be open or creating. Permission revisions.build. Records an audit event.
 */
export async function removeFindingFromRevision(space: Space, input: { revisionId: string; findingId: string }, actor: RevisionActor): Promise<{ revisionId: string; removed: boolean }> {
  const parsed = removeSchema.safeParse(input);
  if (!parsed.success) throw badRequest(parsed.error);
  const req = parsed.data;
  const row = await getRevision(space.id, req.revisionId);
  if (!row) throw new RevisionError("not-found", "There is no such revision in this space.");
  requireTakesFindings(row);

  const removed = await db().transaction(async (tx) => {
    const [cur] = await tx.select().from(revisions).where(and(eq(revisions.id, row.id), eq(revisions.spaceId, space.id))).for("update");
    if (!cur) throw new RevisionError("not-found", "There is no such revision in this space.");
    requireTakesFindings(cur);
    if (!cur.toAddressFindingIds.includes(req.findingId)) return false;
    await tx
      .update(revisions)
      .set({ toAddressFindingIds: takeOffList(cur.toAddressFindingIds, [req.findingId]), updatedAt: new Date() })
      .where(eq(revisions.id, cur.id));
    return true;
  });
  if (removed) {
    await recordAuditEvent({ actor, action: "revision.findings.remove", spaceId: space.id, targetType: "revision", targetId: row.id, details: { name: row.name, findingId: req.findingId } });
  }
  return { revisionId: row.id, removed };
}

/**
 * Create a revision based on the live space with these findings on its to-address list
 * (the create job runs in the worker, like requestCreateRevision). Same refusals as
 * addFindingsToRevision, plus the revision name rules.
 */
export async function createRevisionForFindings(
  space: Space,
  input: { name: string; findingIds: string[]; note?: string },
  actor: RevisionActor,
): Promise<{ revisionId: string; runId: string; branch: string }> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw badRequest(parsed.error);
  const req = parsed.data;
  const { policy } = await policyForSpace(space);
  const ids = await requireAddable(space.id, req.findingIds, policy.revisions.toAddress.maxFindings);
  const created = await requestCreateRevision(space, { name: req.name, base: { kind: "live" }, note: req.note }, actor, { toAddressFindingIds: ids });
  await recordAuditEvent({
    actor,
    action: "revision.create-for-findings",
    spaceId: space.id,
    targetType: "revision",
    targetId: created.revisionId,
    details: { name: req.name, branch: created.branch, findingIds: ids, runId: created.runId },
  });
  return created;
}

/** For each finding ID, the revisions it went to (empty array when none). */
export async function findingRevisionLinks(spaceId: string, findingIds: string[]): Promise<Map<string, FindingRevisionLink[]>> {
  const out = new Map<string, FindingRevisionLink[]>(findingIds.map((id) => [id, []]));
  const wanted = new Set(findingIds.filter(isUuid));
  if (!wanted.size) return out;
  const rows = await db().select().from(revisions).where(eq(revisions.spaceId, spaceId)).orderBy(desc(revisions.updatedAt), revisions.name);
  if (!rows.length) return out;
  const changes = await db()
    .select({ revisionId: revisionChanges.revisionId, findingIds: revisionChanges.findingIds })
    .from(revisionChanges)
    .where(and(eq(revisionChanges.spaceId, spaceId), sql`jsonb_array_length(${revisionChanges.findingIds}) > 0`));
  const [plans, releases] = await Promise.all([planStates(rows.flatMap((r) => (r.planId ? [r.planId] : []))), existingReleaseIds(rows.map((r) => r.releaseId))]);

  // Newest revision first within each finding (the rows are in that order).
  for (const r of rows) {
    const linked = linkedIds(changes.filter((c) => c.revisionId === r.id));
    const plan = r.planId ? (plans.get(r.planId) ?? null) : null;
    const base = {
      revisionId: r.id,
      revisionName: r.name,
      revisionState: r.state,
      planId: r.planId,
      planState: plan?.state ?? null,
      releaseName: r.releaseId && releases.has(r.releaseId) ? r.releaseName : null,
    };
    for (const id of wanted) {
      const kind = linked.has(id) ? "linked" : r.toAddressFindingIds.includes(id) ? "to-address" : null;
      if (kind) out.get(id)?.push({ ...base, kind });
    }
  }
  return out;
}
