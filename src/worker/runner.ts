import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { db } from "@/server/db/client";
import { jobRuns } from "@/server/db/schema";
import type { JobEnvelope } from "@/server/jobs/enqueue";
import type { JobContext, JobDefinition } from "@/server/jobs/registry";

/** Register one job definition with pg-boss and wrap it with job_runs bookkeeping. */
export async function registerJob(b: PgBoss, job: JobDefinition): Promise<void> {
  await b.createQueue(job.name, { policy: job.options?.queuePolicy ?? "standard" }).catch(() => {});
  await b.work<JobEnvelope>(job.name, { localConcurrency: job.options?.localConcurrency ?? 1 }, async (batch) => {
    for (const j of batch) await runOne(job, j.data);
  });
  if (job.schedule) {
    // Scheduled runs create their job_runs row lazily (runId "scheduled").
    await b.schedule(job.name, job.schedule.cron, {
      runId: "scheduled",
      actor: { email: `system:${job.name}` },
      spaceId: null,
      input: job.schedule.input,
    } satisfies JobEnvelope);
  }
}

async function runOne(job: JobDefinition, env: JobEnvelope): Promise<void> {
  let runId = env.runId;
  if (runId === "scheduled") {
    const [row] = await db()
      .insert(jobRuns)
      .values({ queue: job.name, actorEmail: env.actor.email, spaceId: env.spaceId, input: env.input as object })
      .returning({ id: jobRuns.id });
    runId = row!.id;
  }
  await db().update(jobRuns).set({ status: "running", startedAt: new Date(), error: null }).where(eq(jobRuns.id, runId));

  const ctx: JobContext = {
    runId,
    actor: env.actor,
    spaceId: env.spaceId,
    progress: async (fraction, message) => {
      await db()
        .update(jobRuns)
        .set({ progress: Math.max(0, Math.min(1, fraction)), ...(message !== undefined ? { message } : {}) })
        .where(eq(jobRuns.id, runId));
    },
    log: (message, extra) => console.log(`[${job.name} ${runId}] ${message}`, extra ?? ""),
    cancelled: async () => {
      const [row] = await db().select({ status: jobRuns.status }).from(jobRuns).where(eq(jobRuns.id, runId));
      return row?.status === "cancelled";
    },
  };

  try {
    const input = job.input.parse(env.input);
    if (!job.options?.quietLog) console.log(`[${job.name} ${runId}] started${env.spaceId ? ` for space ${env.spaceId}` : ""}`);
    const started = Date.now();
    const result = await job.handler(input, ctx);
    await db()
      .update(jobRuns)
      .set({ status: "succeeded", progress: 1, result: (result ?? null) as object | null, finishedAt: new Date() })
      .where(eq(jobRuns.id, runId));
    if (!job.options?.quietLog) console.log(`[${job.name} ${runId}] ${finishWords(result)} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await db().update(jobRuns).set({ status: "failed", error: message, finishedAt: new Date() }).where(eq(jobRuns.id, runId));
    // Every failure goes to the worker log, quiet jobs included. The message has no credentials (AWS SDK errors don't carry them).
    console.error(`[${job.name} ${runId}] failed: ${message.replace(/\s+/g, " ").slice(0, 500)}`);
    throw err; // let pg-boss apply the retry policy
  }
}

/**
 * The finish line's words. A job can finish without throwing yet report a
 * failure in its result (an apply where some items failed returns status
 * "failed" with a count), and the log must not call that a success.
 */
export function finishWords(result: unknown): string {
  const r = result && typeof result === "object" ? (result as { status?: unknown; failed?: unknown }) : {};
  if (r.status !== "failed") return "succeeded";
  return typeof r.failed === "number" ? `finished with ${r.failed} failed item${r.failed === 1 ? "" : "s"}` : "finished with failures";
}
