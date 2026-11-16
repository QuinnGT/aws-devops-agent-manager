/**
 * Words for background jobs in the UI. Pure and free of server imports, so
 * client components (JobProgress, SyncStatus) and server pages share them.
 */

export type JobRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** Shown once a job has waited longer than policy api.workerWaitSeconds without a worker picking it up. */
export const WORKER_WAIT_TEXT =
  "Waiting for the background worker. If this doesn't change, the worker may not be running: start it with pnpm dev:worker (local) or check the worker service.";

export const JOB_STATUS_WORDS: Record<JobRunStatus, string> = {
  queued: "Waiting to start",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const JOB_LABELS: Record<string, string> = {
  "sync.space": "The sync",
  "sync.reconcile": "The full sync",
  "plans.check": "A plan check",
  "plans.apply": "Applying a plan",
  "releases.create": "Creating a release",
  "journals.export": "A journal export",
  "journals.import": "A journal import",
  "analyzers.run": "An analysis run",
  "assets.add-reason": "Adding a reason",
  "spaces.connection-test": "The connection test",
};

/** "The sync", "Creating a release", ...: the subject of a sentence about a job of this queue. */
export function jobLabel(queue: string): string {
  return JOB_LABELS[queue] ?? "A background job";
}
