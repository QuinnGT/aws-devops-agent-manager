import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/server/db/client";
import { jobRuns } from "@/server/db/schema";
import { analyzersRunJob } from "@/server/analyzers/jobs";
import { boss } from "@/server/jobs/boss";
import { testJobContext } from "@/server/jobs/registry";
import { PLAN_APPLY_QUEUE, PLAN_CHECK_QUEUE } from "@/server/plans/jobs";
import { CREATE_RELEASE_QUEUE } from "@/server/releases/jobs";
import { SYNC_SPACE_QUEUE } from "@/server/sync/contract";
import { VERIFY_QUEUES } from "@/server/verify/config";
import { allJobs } from "@/worker/handlers";

/**
 * The seed plays the worker. Jobs it queues through the services run here,
 * in this process, with testJobContext(), and leave pg-boss afterwards so no
 * worker runs them again.
 *
 * Only the queues below run generically: they read and write the database,
 * the history repository and the mocked Agent Space. Audit reviews and
 * report drafts call a model, so their seed parts run those handlers with
 * fakes; anything else left queued at the end is cancelled.
 */
export const INLINE_QUEUES: ReadonlySet<string> = new Set([
  SYNC_SPACE_QUEUE,
  "sync.reconcile",
  PLAN_CHECK_QUEUE,
  PLAN_APPLY_QUEUE,
  CREATE_RELEASE_QUEUE,
  VERIFY_QUEUES.live,
  VERIFY_QUEUES.reads,
  analyzersRunJob.name,
]);

/** Take a run's job out of pg-boss (if it has one). */
async function dropBossJob(row: { queue: string; bossJobId: string | null }): Promise<void> {
  if (!row.bossJobId) return;
  const b = await boss();
  await b.cancel(row.queue, [row.bossJobId]).catch(() => {});
  await b.deleteJob(row.queue, row.bossJobId).catch(() => {});
}

/** Mark a job the seed ran inline as finished, and take it out of pg-boss. */
export async function settle(runId: string, result?: unknown): Promise<void> {
  const [row] = await db()
    .update(jobRuns)
    .set({ status: "succeeded", progress: 1, ...(result !== undefined ? { result: result as object } : {}), startedAt: new Date(), finishedAt: new Date() })
    .where(eq(jobRuns.id, runId))
    .returning();
  if (row) await dropBossJob(row);
}

/** Run one queued job (by job_runs id) in this process, as the worker would. */
export async function runQueued(runId: string | null | undefined, what = "job"): Promise<unknown> {
  if (!runId) throw new Error(`${what}: no job run`);
  const [row] = await db().select().from(jobRuns).where(eq(jobRuns.id, runId));
  if (!row) throw new Error(`${what}: job run ${runId} not found`);
  if (row.status !== "queued") return row.result;
  if (!INLINE_QUEUES.has(row.queue)) throw new Error(`${what}: the seed does not run ${row.queue} jobs`);
  const job = allJobs.find((j) => j.name === row.queue);
  if (!job) throw new Error(`${what}: no handler for ${row.queue}`);
  await dropBossJob(row);
  await db().update(jobRuns).set({ status: "running", startedAt: new Date(), error: null }).where(eq(jobRuns.id, runId));
  const ctx = testJobContext({
    runId,
    actor: { email: row.actorEmail },
    spaceId: row.spaceId,
    progress: async (fraction, message) => {
      await db()
        .update(jobRuns)
        .set({ progress: Math.max(0, Math.min(1, fraction)), ...(message !== undefined ? { message } : {}) })
        .where(eq(jobRuns.id, runId));
    },
  });
  try {
    const result = await job.handler(job.input.parse(row.input), ctx);
    await db()
      .update(jobRuns)
      .set({ status: "succeeded", progress: 1, result: (result ?? null) as object | null, finishedAt: new Date() })
      .where(eq(jobRuns.id, runId));
    return result;
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await db().update(jobRuns).set({ status: "failed", error: message, finishedAt: new Date() }).where(eq(jobRuns.id, runId));
    throw new Error(`${what} (${row.queue}) failed: ${message}`);
  }
}

/** Run every queued job of the inline queues, oldest first, including jobs those jobs queue. Returns how many ran. */
export async function drain(spaceId: string): Promise<number> {
  let ran = 0;
  for (let guard = 0; guard < 200; guard++) {
    const [next] = await db()
      .select({ id: jobRuns.id, queue: jobRuns.queue })
      .from(jobRuns)
      .where(and(eq(jobRuns.spaceId, spaceId), eq(jobRuns.status, "queued"), inArray(jobRuns.queue, [...INLINE_QUEUES])))
      .orderBy(asc(jobRuns.createdAt))
      .limit(1);
    if (!next) return ran;
    await runQueued(next.id, next.queue);
    ran++;
  }
  throw new Error("drain: more than 200 queued jobs");
}

/** Cancel every job still queued in the space (the seed does not run them), in job_runs and pg-boss. Returns the queues. */
export async function cancelLeftovers(spaceId: string): Promise<string[]> {
  const rows = await db()
    .update(jobRuns)
    .set({ status: "cancelled", message: "Cancelled by the demo seed", finishedAt: new Date() })
    .where(and(eq(jobRuns.spaceId, spaceId), eq(jobRuns.status, "queued")))
    .returning();
  for (const r of rows) await dropBossJob(r);
  return rows.map((r) => r.queue);
}
