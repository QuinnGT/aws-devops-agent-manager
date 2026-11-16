import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/server/db/client";
import { jobRuns } from "@/server/db/schema";
import { getAppPolicy } from "@/server/policy";
import { boss } from "./boss";
import { errorDetails, isAppError, plainErrorText } from "./error-text";
import type { JobRunStatus } from "./words";

/**
 * Job progress for the UI (/api/jobs/<id>, the plan page, SyncStatus).
 * job_runs says what the worker reported; pg-boss says whether a worker has
 * picked the job up. A job still "queued" after policy api.workerWaitSeconds
 * that pg-boss has not handed to a worker is waiting for a worker that may
 * not be running, and the UI says so instead of spinning.
 */

/** pg-boss job state, or "missing" when pg-boss no longer has the job */
export type BossJobState = "created" | "retry" | "active" | "completed" | "cancelled" | "failed" | "missing";

export interface BossJobInfo {
  state: BossJobState;
  /** When pg-boss may start the job (later than creation for delayed jobs) */
  startAfter: Date | null;
}

type JobRunRow = typeof jobRuns.$inferSelect;

export interface JobStatusView {
  id: string;
  queue: string;
  status: JobRunStatus;
  progress: number;
  message: string | null;
  /** The error as a plain sentence */
  error: string | null;
  /** The raw error behind the sentence, credentials removed, for a "Details" disclosure; null when it adds nothing */
  errorDetails: string | null;
  result: unknown;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Queued past the wait threshold and no worker has picked it up */
  waitingForWorker: boolean;
}

export function workerWaitSeconds(): number {
  return getAppPolicy().policy.api.workerWaitSeconds;
}

/** Whether a job waits for a worker: still queued, past the threshold, and pg-boss has not started it. Pure. */
export function isWaitingForWorker(run: { status: JobRunStatus; createdAt: Date }, bossInfo: BossJobInfo | null, now: Date, waitSeconds: number): boolean {
  if (run.status !== "queued") return false;
  if (bossInfo && bossInfo.state !== "created" && bossInfo.state !== "retry") return false;
  const since = Math.max(run.createdAt.getTime(), bossInfo?.startAfter?.getTime() ?? 0);
  return now.getTime() - since >= waitSeconds * 1000;
}

async function defaultBossInfo(queue: string, bossJobId: string): Promise<BossJobInfo | null> {
  try {
    const job = await (await boss()).getJobById(queue, bossJobId);
    return job ? { state: job.state, startAfter: job.startAfter ? new Date(job.startAfter) : null } : { state: "missing", startAfter: null };
  } catch {
    return null;
  }
}

export interface JobStatusDeps {
  bossInfo?: (queue: string, bossJobId: string) => Promise<BossJobInfo | null>;
  now?: Date;
  waitSeconds?: number;
}

/** The UI view of a job_runs row. Asks pg-boss only for a job that has been queued past the threshold. */
export async function jobStatusView(run: JobRunRow, deps: JobStatusDeps = {}): Promise<JobStatusView> {
  const now = deps.now ?? new Date();
  const waitSeconds = deps.waitSeconds ?? workerWaitSeconds();
  let waitingForWorker = isWaitingForWorker(run, null, now, waitSeconds);
  if (waitingForWorker && run.bossJobId) {
    const info = await (deps.bossInfo ?? defaultBossInfo)(run.queue, run.bossJobId);
    waitingForWorker = isWaitingForWorker(run, info, now, waitSeconds);
  }
  return {
    id: run.id,
    queue: run.queue,
    status: run.status,
    progress: run.progress,
    message: run.message,
    error: plainErrorText(run.error),
    errorDetails: errorDetails(run.error),
    result: run.result,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    waitingForWorker,
  };
}

/** One job's view by job_runs id, or null. The caller has checked access. */
export async function loadJobStatus(runId: string | null, deps: JobStatusDeps = {}): Promise<JobStatusView | null> {
  if (!runId) return null;
  const [run] = await db().select().from(jobRuns).where(eq(jobRuns.id, runId));
  return run ? jobStatusView(run, deps) : null;
}

/** The newest queued or running job of a queue in a space (a requested sync, for SyncStatus), or null. */
export async function latestOpenRunId(spaceId: string, queue: string): Promise<string | null> {
  const [row] = await db()
    .select({ id: jobRuns.id })
    .from(jobRuns)
    .where(and(eq(jobRuns.spaceId, spaceId), eq(jobRuns.queue, queue), inArray(jobRuns.status, ["queued", "running"])))
    .orderBy(desc(jobRuns.createdAt))
    .limit(1);
  return row?.id ?? null;
}

export interface FailedRun {
  queue: string;
  /** Plain sentence */
  error: string;
  finishedAt: Date;
}

/**
 * The newest job of the space that failed after `after` for a reason other
 * than one of this app's own rules (a live read, credentials, the network):
 * Home uses it so "Connected" is never shown over a later failure.
 */
export async function latestFailedRun(spaceId: string, after: Date | null): Promise<FailedRun | null> {
  const where = [eq(jobRuns.spaceId, spaceId), eq(jobRuns.status, "failed")];
  if (after) where.push(gt(jobRuns.finishedAt, after));
  const rows = await db()
    .select({ queue: jobRuns.queue, error: jobRuns.error, finishedAt: jobRuns.finishedAt })
    .from(jobRuns)
    .where(and(...where))
    .orderBy(desc(jobRuns.finishedAt))
    .limit(10);
  const hit = rows.find((r) => r.finishedAt && (!r.error || !isAppError(r.error)));
  return hit ? { queue: hit.queue, error: plainErrorText(hit.error) ?? "It stopped without an error message.", finishedAt: hit.finishedAt! } : null;
}
