import { eq } from "drizzle-orm";
import type { z } from "zod";
import type { Actor } from "@/server/aws/clients";
import { db } from "@/server/db/client";
import { jobRuns } from "@/server/db/schema";
import { boss } from "./boss";
import type { JobDefinition } from "./registry";

export interface EnqueueOptions {
  actor: Actor;
  spaceId?: string | null;
  /** Delay start by this many seconds */
  startAfterSeconds?: number;
}

/**
 * Validate input, record a job_runs row and send the job to pg-boss.
 * Callers (Server Actions, Route Handlers) must have checked permissions already.
 * Returns the job_runs id, which the UI polls at /api/jobs/<id>.
 */
export async function enqueue<S extends z.ZodType>(job: JobDefinition<S>, input: z.input<S>, opts: EnqueueOptions): Promise<string> {
  const parsed = job.input.parse(input);
  const [run] = await db()
    .insert(jobRuns)
    .values({ queue: job.name, actorEmail: opts.actor.email, spaceId: opts.spaceId ?? null, input: parsed as object })
    .returning({ id: jobRuns.id });
  const runId = run!.id;
  const b = await boss();
  await b.createQueue(job.name, { policy: job.options?.queuePolicy ?? "standard" }).catch(() => {});
  const singletonKey = job.options?.singletonKey?.(parsed);
  const bossId = await b.send(
    job.name,
    { runId, actor: opts.actor, spaceId: opts.spaceId ?? null, input: parsed },
    {
      retryLimit: job.options?.retryLimit ?? 2,
      retryDelay: job.options?.retryDelay ?? 30,
      retryBackoff: job.options?.retryBackoff ?? true,
      expireInSeconds: job.options?.expireInSeconds ?? 60 * 60,
      ...(singletonKey ? { singletonKey } : {}),
      ...(opts.startAfterSeconds ? { startAfter: opts.startAfterSeconds } : {}),
    },
  );
  if (!bossId) {
    await db().update(jobRuns).set({ status: "cancelled", message: "A job with the same key is already queued", finishedAt: new Date() }).where(eq(jobRuns.id, runId));
  } else {
    await db().update(jobRuns).set({ bossJobId: bossId }).where(eq(jobRuns.id, runId));
  }
  return runId;
}

/** Envelope sent through pg-boss. */
export interface JobEnvelope<T = unknown> {
  runId: string;
  actor: Actor;
  spaceId: string | null;
  input: T;
}
