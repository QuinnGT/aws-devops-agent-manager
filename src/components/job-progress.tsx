"use client";

import { CircleX, Clock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Progress } from "@/components/ui/progress";
import { JOB_STATUS_WORDS, type JobRunStatus, WORKER_WAIT_TEXT } from "@/server/jobs/words";

export interface JobStatus {
  status: JobRunStatus;
  progress: number;
  message: string | null;
  /** A plain sentence (the route words it) */
  error: string | null;
  /** The raw error behind the sentence, for a "Details" disclosure */
  errorDetails?: string | null;
  result: unknown;
  /** Queued past policy api.workerWaitSeconds with no worker picking it up */
  waitingForWorker?: boolean;
}

const FINISHED: readonly JobRunStatus[] = ["succeeded", "failed", "cancelled"];

/**
 * Polls /api/jobs/<runId> every `intervalMs` until the job finishes, then
 * calls `onDone` once. `onChange` sees every new status (state or waiting
 * changed). Null runId: no polling.
 */
export function useJobStatus(
  runId: string | null | undefined,
  opts: { onDone?: (s: JobStatus) => void; onChange?: (s: JobStatus, previous: JobStatus | null) => void; intervalMs?: number } = {},
): JobStatus | null {
  const [s, setS] = useState<{ runId: string; status: JobStatus } | null>(null);
  const handlers = useRef(opts);
  useEffect(() => {
    handlers.current = opts;
  });
  const intervalMs = opts.intervalMs ?? 1500;
  useEffect(() => {
    if (!runId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    let last: JobStatus | null = null;
    const tick = async () => {
      const res = await fetch(`/api/jobs/${runId}`, { cache: "no-store" }).catch(() => null);
      if (stop) return;
      if (res?.ok) {
        const body = (await res.json()) as JobStatus;
        if (stop) return;
        setS({ runId, status: body });
        if (!last || last.status !== body.status || Boolean(last.waitingForWorker) !== Boolean(body.waitingForWorker)) {
          handlers.current.onChange?.(body, last);
        }
        last = body;
        if (FINISHED.includes(body.status)) {
          handlers.current.onDone?.(body);
          return;
        }
      }
      timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [runId, intervalMs]);
  return s && s.runId === runId ? s.status : null;
}

/** Polls /api/jobs/<runId> until the job finishes; says when no worker has picked it up, and shows a failure as a sentence. */
export function JobProgress({ runId, onDone }: { runId: string; onDone?: (s: JobStatus) => void }) {
  const s = useJobStatus(runId, { onDone });

  if (!s) return <p className="text-sm text-muted-foreground">Checking the job…</p>;
  if (s.status === "failed") {
    return (
      <div role="alert" className="space-y-1">
        <p className="flex items-start gap-1.5 text-sm text-destructive-fg">
          <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>Failed. {s.error ?? "The job stopped without an error message."}</span>
        </p>
        {s.errorDetails ? (
          <details className="pl-5.5 text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer underline-offset-4 hover:text-foreground hover:underline">Details</summary>
            <p className="mt-1 font-mono break-words whitespace-pre-wrap">{s.errorDetails}</p>
          </details>
        ) : null}
      </div>
    );
  }
  if (s.waitingForWorker) {
    return (
      <p role="status" className="flex items-start gap-1.5 text-sm text-muted-foreground">
        <Clock className="mt-0.5 size-4 shrink-0 text-warning-fg" aria-hidden />
        <span>{WORKER_WAIT_TEXT}</span>
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <Progress value={Math.round(s.progress * 100)} aria-label="Job progress" />
      <p className="text-sm text-muted-foreground">
        {JOB_STATUS_WORDS[s.status]}
        {s.message ? ` · ${s.message}` : ""}
      </p>
    </div>
  );
}
