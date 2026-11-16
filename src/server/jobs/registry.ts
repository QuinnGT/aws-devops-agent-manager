import type { z } from "zod";
import type { Actor } from "@/server/aws/clients";

/**
 * Job definitions. Each module defines its jobs in `src/server/<module>/jobs.ts`
 * with `defineJob`, and src/worker/handlers.ts lists every module's jobs.
 * Handlers are plain async functions, so they can be unit-tested without pg-boss.
 */

export interface JobContext {
  /** job_runs.id, for progress reporting */
  runId: string;
  /** The user who started the job (or "system:<schedule>") */
  actor: Actor;
  spaceId: string | null;
  /** Report progress (0..1) and a short message shown in the UI */
  progress(fraction: number, message?: string): Promise<void>;
  /** Log a line to the worker log, prefixed with the job name and run id */
  log(message: string, extra?: Record<string, unknown>): void;
  /** True once cancellation was requested; long loops should check it */
  cancelled(): Promise<boolean>;
}

export interface JobDefinition<S extends z.ZodType = z.ZodType, R = unknown> {
  /** Queue name, `<module>.<action>`, e.g. "sync.space" */
  name: string;
  input: S;
  /** pg-boss queue options */
  options?: {
    retryLimit?: number;
    retryDelay?: number;
    retryBackoff?: boolean;
    expireInSeconds?: number;
    /** Run at most this many of this job at once in the worker */
    localConcurrency?: number;
    /** pg-boss queue policy (default "standard"). singletonKey dedupes only under singleton, stately or exclusive. */
    queuePolicy?: "standard" | "short" | "singleton" | "stately" | "exclusive";
    /** At most one job per key under the queue policy (e.g. spaceId) */
    singletonKey?: (input: z.output<S>) => string | undefined;
    /** Leave start and finish lines out of the worker log (the every-minute scheduler tick); failures are always logged */
    quietLog?: boolean;
  };
  /** Optional cron schedule (UTC) with fixed input */
  schedule?: { cron: string; input: z.input<S> };
  handler: (input: z.output<S>, ctx: JobContext) => Promise<R>;
}

export function defineJob<S extends z.ZodType, R>(def: JobDefinition<S, R>): JobDefinition<S, R> {
  if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/.test(def.name)) {
    throw new Error(`job name must look like "<module>.<action>": ${def.name}`);
  }
  return def;
}

/** A test JobContext that records progress calls. */
export function testJobContext(overrides: Partial<JobContext> = {}): JobContext & { progressCalls: [number, string?][] } {
  const progressCalls: [number, string?][] = [];
  return {
    runId: "00000000-0000-0000-0000-000000000000",
    actor: { email: "test@example.com" },
    spaceId: null,
    progress: async (f, m) => {
      progressCalls.push([f, m]);
    },
    log: () => {},
    cancelled: async () => false,
    progressCalls,
    ...overrides,
  };
}
