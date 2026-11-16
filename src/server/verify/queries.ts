import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, lt, sql, type SQL } from "drizzle-orm";
import type { DeployedVsReadOutput } from "@/server/analyzers/deployed-vs-read";
import { db } from "@/server/db/client";
import { analyzerRuns, applyRuns, journalTasks, planItems, plans, releases, verificationRuns } from "@/server/db/schema";
import type { VerifyPolicy } from "@/server/policy/sections/verify";
import { parseManifest } from "@/server/releases/manifest";
import type { ReleaseRow } from "@/server/releases/queries";
import { VERIFY } from "./config";
import type { VerifyKind } from "./types";
import { readsWindow, type ReadsWindow } from "./window";

/**
 * Postgres reads and writes for the verify module. verification_runs is
 * ours; releases, journal_tasks and analyzer_runs belong to other modules and
 * are only read here. Callers check permissions first.
 */

export type VerificationRow = typeof verificationRuns.$inferSelect;
export type NewVerificationRow = typeof verificationRuns.$inferInsert;

export async function insertVerification(row: NewVerificationRow): Promise<VerificationRow> {
  const [inserted] = await db().insert(verificationRuns).values(row).returning();
  return inserted!;
}

export async function getVerification(id: string): Promise<VerificationRow | null> {
  const [row] = await db().select().from(verificationRuns).where(eq(verificationRuns.id, id));
  return row ?? null;
}

export async function updateVerification(id: string, patch: Partial<NewVerificationRow>): Promise<void> {
  await db().update(verificationRuns).set(patch).where(eq(verificationRuns.id, id));
}

/** Runs of one check of a release, newest first. */
export async function listVerifications(spaceId: string, releaseId: string, kind: VerifyKind, limit: number = VERIFY.maxListed): Promise<VerificationRow[]> {
  return db()
    .select()
    .from(verificationRuns)
    .where(and(eq(verificationRuns.spaceId, spaceId), eq(verificationRuns.releaseId, releaseId), eq(verificationRuns.kind, kind)))
    .orderBy(desc(verificationRuns.createdAt), desc(verificationRuns.id))
    .limit(limit);
}

/** A queued or running check of the release, if there is one. */
export async function openVerification(spaceId: string, releaseId: string, kind: VerifyKind): Promise<VerificationRow | null> {
  const [row] = await db()
    .select()
    .from(verificationRuns)
    .where(
      and(
        eq(verificationRuns.spaceId, spaceId),
        eq(verificationRuns.releaseId, releaseId),
        eq(verificationRuns.kind, kind),
        inArray(verificationRuns.state, ["queued", "running"]),
      ),
    )
    .orderBy(desc(verificationRuns.createdAt))
    .limit(1);
  return row ?? null;
}

/** The release created after this one, or null. */
export async function nextRelease(spaceId: string, release: Pick<ReleaseRow, "id" | "createdAt">): Promise<ReleaseRow | null> {
  const [row] = await db()
    .select()
    .from(releases)
    .where(and(eq(releases.spaceId, spaceId), gt(releases.createdAt, release.createdAt)))
    .orderBy(asc(releases.createdAt), asc(releases.name))
    .limit(1);
  return row ?? null;
}

/** The newest release (latest) or the newest release tagged after applying a plan (latest-applied). */
export async function releaseForAuto(spaceId: string, which: "latest" | "latest-applied"): Promise<ReleaseRow | null> {
  const where = which === "latest-applied" ? and(eq(releases.spaceId, spaceId), isNotNull(releases.planId)) : eq(releases.spaceId, spaceId);
  const [row] = await db().select().from(releases).where(where).orderBy(desc(releases.createdAt), releases.name).limit(1);
  return row ?? null;
}

export interface WindowTask {
  taskId: string;
  incidentId: string | null;
  createdAt: Date | null;
}

/** Investigations in the journal cache created in [from, to), newest first, at most `limit`, with the total in the window. */
export async function investigationsInWindow(spaceId: string, from: Date, to: Date | null, limit: number): Promise<{ total: number; tasks: WindowTask[] }> {
  const where: SQL[] = [eq(journalTasks.spaceId, spaceId), gte(journalTasks.createdAt, from)];
  if (to) where.push(lt(journalTasks.createdAt, to));
  const cond = and(...where);
  const [{ total } = { total: 0 }] = await db().select({ total: count() }).from(journalTasks).where(cond);
  if (!total) return { total: 0, tasks: [] };
  const tasks = await db()
    .select({ taskId: journalTasks.taskId, incidentId: journalTasks.incidentId, createdAt: journalTasks.createdAt })
    .from(journalTasks)
    .where(cond)
    .orderBy(desc(journalTasks.createdAt), asc(journalTasks.taskId))
    .limit(limit);
  return { total, tasks };
}

/**
 * The newest stored deployed-vs-read output per investigation for one
 * package (its digest is in the output), as analyzers.run stored it.
 */
export async function storedDeployedOutputs(
  spaceId: string,
  taskIds: readonly string[],
  analyzer: { id: string; version: string },
  packageDigest: string,
): Promise<Map<string, DeployedVsReadOutput>> {
  if (!taskIds.length) return new Map();
  const rows = await db()
    .selectDistinctOn([analyzerRuns.taskId], { taskId: analyzerRuns.taskId, output: analyzerRuns.output })
    .from(analyzerRuns)
    .where(
      and(
        eq(analyzerRuns.spaceId, spaceId),
        eq(analyzerRuns.analyzer, analyzer.id),
        eq(analyzerRuns.analyzerVersion, analyzer.version),
        inArray(analyzerRuns.taskId, [...taskIds]),
        sql`${analyzerRuns.output}->>'packageDigest' = ${packageDigest}`,
      ),
    )
    .orderBy(analyzerRuns.taskId, desc(analyzerRuns.createdAt));
  return new Map(rows.map((r) => [r.taskId, r.output as DeployedVsReadOutput]));
}

/** The investigations window of a release (policy verify.reads.window), with the next release read from Postgres. */
export async function loadReleaseWindow(spaceId: string, release: ReleaseRow, mode: VerifyPolicy["reads"]["window"]): Promise<ReadsWindow> {
  const next = await nextRelease(spaceId, release);
  const assets = (row: ReleaseRow) => parseManifest(row.manifest)?.assets ?? [];
  return readsWindow({ name: release.name, createdAt: release.createdAt, assets: assets(release) }, next ? { name: next.name, createdAt: next.createdAt, assets: assets(next) } : null, mode);
}

/** Titles of cached investigations, for record links ("<title> · R<n>"). */
export async function investigationTitles(spaceId: string, taskIds: readonly string[]): Promise<Map<string, string | null>> {
  if (!taskIds.length) return new Map();
  const rows = await db()
    .select({ taskId: journalTasks.taskId, title: journalTasks.title })
    .from(journalTasks)
    .where(and(eq(journalTasks.spaceId, spaceId), inArray(journalTasks.taskId, [...new Set(taskIds)])));
  return new Map(rows.map((r) => [r.taskId, r.title]));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the apply job read back for the plan a release was tagged after (plans and apply_runs belong to the plans module; read only). */
export interface ApplyReadBack {
  planId: string;
  title: string;
  /** When the apply finished: the newest succeeded apply run, else the plan's finish time */
  at: string | null;
  /** Plan items the apply read back, and how many matched what it wrote */
  total: number;
  matched: number;
  /** Names of the items whose read-back didn't match */
  mismatched: string[];
}

export async function applyReadBack(spaceId: string, planId: string | null): Promise<ApplyReadBack | null> {
  if (!planId || !UUID_RE.test(planId)) return null;
  const [plan] = await db()
    .select({ id: plans.id, title: plans.title, finishedAt: plans.finishedAt })
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.spaceId, spaceId)));
  if (!plan) return null;
  const [items, [run]] = await Promise.all([
    db().select({ name: planItems.name, verification: planItems.verification }).from(planItems).where(eq(planItems.planId, planId)).orderBy(asc(planItems.position)),
    db()
      .select({ finishedAt: applyRuns.finishedAt })
      .from(applyRuns)
      .where(and(eq(applyRuns.planId, planId), eq(applyRuns.status, "succeeded")))
      .orderBy(desc(applyRuns.startedAt))
      .limit(1),
  ]);
  const read = items.filter((i) => i.verification && typeof i.verification === "object");
  const mismatched = read.filter((i) => (i.verification as { ok?: unknown }).ok !== true).map((i) => i.name);
  const at = run?.finishedAt ?? plan.finishedAt;
  return { planId: plan.id, title: plan.title, at: at ? at.toISOString() : null, total: read.length, matched: read.length - mismatched.length, mismatched };
}
