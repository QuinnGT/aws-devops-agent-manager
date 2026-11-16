import type { JobRunStatus } from "@/server/jobs/words";
import { formatRelative, toDate } from "./time-format";

/**
 * Sync status states (design-system MASTER "Sync status states"). Pure.
 *
 * - running: a sync job is running
 * - waiting: a requested sync has waited past policy api.workerWaitSeconds and no worker picked it up
 * - requested: a sync was requested and has not started yet
 * - disconnected: the space can't be reached (connectionView in src/server/spaces/connection-state.ts)
 * - failed: the last sync failed
 * - never: no sync has finished
 * - stale: the last sync finished 2 x interval ago or more
 * - ok: otherwise
 */

export type SyncState = "ok" | "stale" | "running" | "waiting" | "requested" | "disconnected" | "failed" | "never";

export interface SyncStatusInput {
  /** sync_state.last_sync_completed_at */
  lastCompletedAt: Date | string | null;
  /** sync_state.status: "never" | "running" | "succeeded" | "error" | "cancelled" */
  status: string | null;
  /** The space's syncIntervalMinutes, or policy sync.intervalMinutes */
  intervalMinutes: number;
  /** The newest requested sync job, from /api/jobs/<id>, while it is queued or running */
  job?: { status: JobRunStatus; waitingForWorker?: boolean } | null;
  /** True when connectionView says the space isn't connected */
  connectionFailed?: boolean;
}

/** Minutes without a finished sync after which the status is stale. */
export function staleAfterMinutes(intervalMinutes: number): number {
  return 2 * intervalMinutes;
}

export function syncState(input: SyncStatusInput, now: Date = new Date()): SyncState {
  if (input.status === "running" || input.job?.status === "running") return "running";
  if (input.job?.status === "queued") return input.job.waitingForWorker ? "waiting" : "requested";
  if (input.connectionFailed) return "disconnected";
  if (input.status === "error") return "failed";
  const last = input.lastCompletedAt ? toDate(input.lastCompletedAt) : null;
  if (!last) return "never";
  return now.getTime() - last.getTime() >= staleAfterMinutes(input.intervalMinutes) * 60_000 ? "stale" : "ok";
}

/** The text that always accompanies the dot. */
export function syncStatusText(state: SyncState, lastCompletedAt: Date | string | null, now: Date = new Date()): string {
  switch (state) {
    case "running":
      return "Syncing";
    case "waiting":
      return "Sync waiting for the worker";
    case "requested":
      return "Sync requested";
    case "disconnected":
      return "Connection failed";
    case "failed":
      return "Sync failed";
    case "never":
      return "Not synced yet";
    case "ok":
      return `Synced ${formatRelative(lastCompletedAt ?? now, now)}`;
    case "stale":
      return `Last sync ${formatRelative(lastCompletedAt ?? now, now)}`;
  }
}

/** Words for the polite live region; only state changes are announced, not the minutes. */
export const SYNC_STATE_ANNOUNCEMENT: Record<SyncState, string> = {
  ok: "Sync status: up to date",
  stale: "Sync status: stale",
  running: "Sync status: syncing",
  waiting: "Sync status: waiting for the background worker",
  requested: "Sync status: sync requested",
  disconnected: "Sync status: connection failed",
  failed: "Sync status: last sync failed",
  never: "Sync status: not synced yet",
};
