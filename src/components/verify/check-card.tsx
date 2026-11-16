"use client";

import { CircleX, Loader2, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { DisabledReason } from "@/components/common/disabled-reason";
import { JobProgress } from "@/components/job-progress";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { initialRunCheckState, type RunCheckState } from "./action-state";
import { CHECKING } from "./words";

type RunAction = (prev: RunCheckState) => Promise<RunCheckState>;

const noAction: RunAction = async (prev) => prev;

/**
 * One check card of the release Verification tab: the h2 and its meta line,
 * "Run check" (hidden without `sync.run`, disabled with the reason when the
 * check can't run), and the body. While a check is queued or running, the
 * button says "Checking" and JobProgress replaces the body; the page
 * refreshes when the job ends.
 */
export function CheckCard({
  titleId,
  title,
  meta,
  staleNote,
  action,
  openRunId,
  open,
  disabledReason,
  startedText,
  children,
}: {
  titleId: string;
  title: string;
  meta?: ReactNode;
  /** "New journals since the last check": shown next to the button */
  staleNote?: string | null;
  /** The bound Server Action; null hides the button (Viewers) */
  action: RunAction | null;
  /** job_runs id of the queued or running check, from the server */
  openRunId: string | null;
  /** A check is queued or running */
  open: boolean;
  disabledReason?: string | null;
  /** Toast when the check is queued */
  startedText: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [state, dispatch, pending] = useActionState(action ?? noAction, initialRunCheckState);
  const [, startTransition] = useTransition();
  const [doneRunId, setDoneRunId] = useState<string | null>(null);
  const toasted = useRef<RunCheckState | null>(null);

  const startedRunId = state.status === "started" ? state.runId : null;
  const runId = startedRunId ?? openRunId;
  const running = Boolean(runId && runId !== doneRunId);
  const checking = pending || running || (open && !doneRunId) || (state.status === "started" && !state.runId);

  useEffect(() => {
    if (state.status === "started" && toasted.current !== state) {
      toasted.current = state;
      toast.success(state.alreadyOpen ? "This check is already running." : startedText);
    }
  }, [state, startedText]);

  const onDone = useCallback(() => {
    setDoneRunId(runId);
    router.refresh();
  }, [router, runId]);

  const button = (
    <Button type="button" variant="outline" size="sm" disabled={checking} onClick={() => startTransition(() => dispatch())}>
      {checking ? <Loader2 className="motion-safe:animate-spin" aria-hidden /> : <Play aria-hidden />}
      {checking ? CHECKING : "Run check"}
    </Button>
  );

  return (
    <Card className="gap-0 py-0" role="region" aria-labelledby={titleId}>
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-4 py-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h2 id={titleId} className="text-sm font-semibold">
            {title}
          </h2>
          {meta ? <p className="text-xs text-muted-foreground">{meta}</p> : null}
        </div>
        {action ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {staleNote && !checking ? <span className="text-xs text-muted-foreground">{staleNote}</span> : null}
            {disabledReason && !checking ? <DisabledReason reason={disabledReason}>{button}</DisabledReason> : button}
          </div>
        ) : staleNote ? (
          <span className="text-xs text-muted-foreground">{staleNote}</span>
        ) : null}
      </div>
      {state.status === "error" ? (
        <p role="alert" className="flex items-start gap-1.5 border-b px-4 py-2 text-xs font-medium text-destructive-fg">
          <CircleX className="mt-px size-3.5 shrink-0" aria-hidden />
          {state.message}
        </p>
      ) : null}
      {running && runId ? (
        <div className="px-4 py-3" aria-live="polite">
          <JobProgress key={runId} runId={runId} onDone={onDone} />
        </div>
      ) : checking ? (
        <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
          The check is queued.
        </p>
      ) : (
        children
      )}
    </Card>
  );
}
