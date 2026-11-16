import { and, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import { recordAuditEvent } from "@/server/audit-log";
import { db } from "@/server/db/client";
import { applyRuns, jobRuns, planItems } from "@/server/db/schema";
import { boss } from "@/server/jobs/boss";
import { PLAN_APPLY_QUEUE, planApplyJob } from "./jobs";
import { dbPlanStore } from "./store";
import type { PlanState } from "./types";

/**
 * A plan whose apply job gave up (pg-boss used every retry, or the job was
 * cancelled) would stay "applying" forever, because only the job moves it
 * on. The plan page and the plan list call settleIfApplyGaveUp: when the job
 * is finished for good, the plan becomes "failed" with every unfinished item
 * failed, so "Create a plan for the failed items" and "Discard plan" work.
 */

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
/** pg-boss job state, or "missing" when pg-boss no longer has the job (archived or deleted) */
export type BossState = "created" | "retry" | "active" | "completed" | "cancelled" | "failed" | "missing";

export interface ApplyJobView {
  runId: string;
  status: JobStatus;
  progress: number;
  message: string | null;
  error: string | null;
  finishedAt: Date | null;
}

/** Seconds after which a "running" job_runs row is worth asking pg-boss about (the job's own expiry). */
const STALE_RUNNING_SECONDS = planApplyJob.options?.expireInSeconds ?? 2 * 60 * 60;

/** Whether the apply job of an "applying" plan is finished for good. Pure. */
export function applyGaveUp(planState: PlanState, job: Pick<ApplyJobView, "status"> | null, bossState: BossState | null): boolean {
  if (planState !== "applying" || !job || job.status === "succeeded") return false;
  if (bossState === "failed" || bossState === "cancelled") return true;
  return bossState === "missing" && (job.status === "failed" || job.status === "cancelled");
}

/** Whether pg-boss needs to be asked: the job_runs row says failed or cancelled, or it has been "running" longer than the job may run. Pure. */
export function shouldAskBoss(job: Pick<ApplyJobView, "status"> & { startedAt: Date | null }, now: Date = new Date()): boolean {
  if (job.status === "failed" || job.status === "cancelled") return true;
  return job.status === "running" && job.startedAt !== null && now.getTime() - job.startedAt.getTime() > STALE_RUNNING_SECONDS * 1000;
}

export interface StuckDeps {
  /** pg-boss state of a job; null when it can't be read */
  bossState?: (bossJobId: string) => Promise<BossState | null>;
}

async function defaultBossState(bossJobId: string): Promise<BossState | null> {
  try {
    const job = await (await boss()).getJobById(PLAN_APPLY_QUEUE, bossJobId);
    return job ? job.state : "missing";
  } catch {
    return null;
  }
}

/** The apply job's job_runs row, for the page's job state. */
export async function loadApplyJob(applyRunId: string | null): Promise<(ApplyJobView & { bossJobId: string | null; startedAt: Date | null }) | null> {
  if (!applyRunId) return null;
  const [row] = await db().select().from(jobRuns).where(eq(jobRuns.id, applyRunId));
  if (!row) return null;
  return {
    runId: row.id,
    status: row.status,
    progress: row.progress,
    message: row.message,
    error: row.error,
    finishedAt: row.finishedAt,
    bossJobId: row.bossJobId,
    startedAt: row.startedAt,
  };
}

/**
 * Settle a plan whose apply job gave up. Returns true when the plan was
 * moved to "failed". Safe to call on every page load: it does nothing unless
 * the plan is applying and pg-boss has finished with its job.
 */
export async function settleIfApplyGaveUp(plan: { id: string; spaceId: string; state: PlanState; applyRunId: string | null }, deps: StuckDeps = {}): Promise<boolean> {
  if (plan.state !== "applying") return false;
  const job = await loadApplyJob(plan.applyRunId);
  if (!job || !job.bossJobId || !shouldAskBoss(job)) return false;
  const bossState = await (deps.bossState ?? defaultBossState)(job.bossJobId);
  if (!applyGaveUp(plan.state, job, bossState)) return false;
  return settleAbandonedApply(plan, job.error ?? (job.status === "cancelled" ? "The apply job was cancelled." : "The apply job stopped."));
}

/** Move an applying plan to failed: unfinished items fail with `error`, drafts settle as after a failed apply. */
export async function settleAbandonedApply(plan: { id: string; spaceId: string }, error: string): Promise<boolean> {
  const moved = await dbPlanStore.updatePlan(plan.id, { state: "failed", finishedAt: new Date() }, { whereStates: ["applying"] });
  if (!moved) return false;
  const message = `The apply job stopped before this item finished. ${error}`.slice(0, 500);
  await db()
    .update(planItems)
    .set({ progress: "failed", progressMessage: message, updatedAt: new Date() })
    .where(and(eq(planItems.planId, plan.id), or(isNull(planItems.progress), notInArray(planItems.progress, ["done", "skipped", "failed"]))));
  await db()
    .update(applyRuns)
    .set({ status: "failed", error: error.slice(0, 500), finishedAt: new Date() })
    .where(and(eq(applyRuns.planId, plan.id), eq(applyRuns.status, "running")));
  const items = await dbPlanStore.getItems(plan.id);
  const draftOf = (i: (typeof items)[number]) => (i.draftId ? [i.draftId] : []);
  await dbPlanStore.settleDrafts(
    plan.id,
    items.filter((i) => i.progress === "done").flatMap(draftOf),
    items.filter((i) => i.progress !== "done").flatMap(draftOf),
  );
  await recordAuditEvent({
    actor: { email: `system:${PLAN_APPLY_QUEUE}` },
    action: "plan.apply.fail",
    spaceId: plan.spaceId,
    targetType: "plan",
    targetId: plan.id,
    result: "error",
    details: { gaveUp: true, error: error.slice(0, 300), failedItems: items.filter((i) => i.progress === "failed").map((i) => i.name) },
  });
  return true;
}

/** Settle every applying plan in the list whose job gave up; returns the IDs that changed. */
export async function settleGaveUpPlans(rows: readonly { id: string; spaceId: string; state: PlanState; applyRunId?: string | null }[], deps: StuckDeps = {}): Promise<string[]> {
  const applying = rows.filter((r) => r.state === "applying");
  if (!applying.length) return [];
  const runIds = applying.map((r) => r.applyRunId).filter((id): id is string => Boolean(id));
  if (!runIds.length) return [];
  const runs = await db().select({ id: jobRuns.id, status: jobRuns.status }).from(jobRuns).where(inArray(jobRuns.id, runIds));
  const changed: string[] = [];
  for (const r of applying) {
    if (!runs.some((j) => j.id === r.applyRunId && j.status !== "succeeded")) continue;
    if (await settleIfApplyGaveUp({ id: r.id, spaceId: r.spaceId, state: r.state, applyRunId: r.applyRunId ?? null }, deps)) changed.push(r.id);
  }
  return changed;
}
