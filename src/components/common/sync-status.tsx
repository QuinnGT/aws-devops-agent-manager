"use client";

import { CircleX, Clock, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useJobStatus } from "@/components/job-progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import { WORKER_WAIT_TEXT } from "@/server/jobs/words";
import { staleAfterMinutes, SYNC_STATE_ANNOUNCEMENT, syncState, syncStatusText, type SyncState } from "./sync-status-state";
import { toDate } from "./time-format";

const DOT: Record<Exclude<SyncState, "running" | "failed" | "disconnected" | "waiting" | "requested">, string> = {
  ok: "bg-success",
  stale: "bg-warning",
  never: "bg-muted-foreground",
};

function exactLocal(value: string | null): string {
  const d = value ? toDate(value) : null;
  if (!d) return "";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
}

/**
 * Space sync freshness (design-system MASTER "Sync status states"). Re-renders
 * its relative time every 30 s, refreshes the page every 30 s while a sync is
 * running, and announces state changes (not minutes) in one polite live region.
 * With `runId` (a requested sync that is queued or running) it polls the job,
 * says when no worker has picked it up, and refreshes the page when it moves on.
 */
export function SyncStatus({
  lastCompletedAt,
  status,
  error,
  intervalMinutes,
  runId = null,
  compact = false,
  connection = null,
}: {
  /** ISO time of the last finished sync, or null */
  lastCompletedAt: string | null;
  /** sync_state.status, or null when the space has no sync state yet */
  status: string | null;
  /** The last sync's error as a plain sentence */
  error?: string | null;
  intervalMinutes: number;
  /** job_runs id of the newest queued or running sync of the space */
  runId?: string | null;
  /** Set when the space isn't connected: the cause and the caller's next step (connectionView, connectionNextStep) */
  connection?: { cause: string | null; nextStep: string | null } | null;
  /** Plain text for tables; the default is a 28 px top bar control */
  compact?: boolean;
}) {
  const now = useNow();
  const router = useRouter();
  // Refresh on every change after the first look, and at once when the job already finished.
  const job = useJobStatus(runId, {
    intervalMs: 5000,
    onChange: (s, previous) => {
      if (previous || (s.status !== "queued" && s.status !== "running")) router.refresh();
    },
  });
  const state = syncState(
    { lastCompletedAt, status, intervalMinutes, job: job && (job.status === "queued" || job.status === "running") ? job : null, connectionFailed: Boolean(connection) },
    now,
  );
  const text = syncStatusText(state, lastCompletedAt, now);

  // Announce state changes only (adjusting state during render, not in an effect).
  const [shown, setShown] = useState(state);
  const [announcement, setAnnouncement] = useState("");
  if (shown !== state) {
    setShown(state);
    setAnnouncement(SYNC_STATE_ANNOUNCEMENT[state]);
  }

  useEffect(() => {
    if (state !== "running") return;
    const t = setInterval(() => router.refresh(), 30_000);
    return () => clearInterval(t);
  }, [state, router]);

  const indicator =
    state === "running" ? (
      <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
    ) : state === "failed" || state === "disconnected" ? (
      <CircleX className="size-3.5 text-destructive-fg" aria-hidden />
    ) : state === "waiting" || state === "requested" ? (
      <Clock className={cn("size-3.5", state === "waiting" && "text-warning-fg")} aria-hidden />
    ) : (
      <span className={cn("size-2 shrink-0 rounded-full", DOT[state])} aria-hidden />
    );

  const last = exactLocal(lastCompletedAt);
  const stale = staleAfterMinutes(intervalMinutes);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-2 rounded-md text-muted-foreground transition-colors",
              compact ? "min-h-6 text-sm" : "h-7 px-2.5 text-xs hover:bg-muted hover:text-foreground",
            )}
          >
            {indicator}
            <span suppressHydrationWarning>{text}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent className="block max-w-sm">
          {state === "waiting" ? <p className="mb-1">{WORKER_WAIT_TEXT}</p> : null}
          {state === "disconnected" && connection ? (
            <p className="mb-1 break-words">{[connection.cause, connection.nextStep].filter(Boolean).join(" ")}</p>
          ) : null}
          <p>{last ? `Last sync ${last}.` : "No sync has finished yet."} Syncs every {intervalMinutes} min.</p>
          <p>Shown as stale after {stale} min without a finished sync, and as failed when one fails.</p>
          {state === "failed" && error ? <p className="mt-1 break-words">{error}</p> : null}
        </TooltipContent>
      </Tooltip>
      <span role="status" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
