"use client";

import { useRouter } from "next/navigation";
import { useActionState, useCallback, useState, useTransition } from "react";
import { JobProgress } from "@/components/job-progress";
import { Button } from "@/components/ui/button";
import { FieldError } from "./field";
import { type FormState, initialFormState } from "./form-state";
import { useSavedToast } from "./use-action-form";

/**
 * A button that runs a Server Action which starts a job, confirms with a
 * toast, then shows the job's progress and refreshes the page when it ends.
 * With `doneText`, the finished job's result is left to the refreshed page
 * (so a failure's cause isn't shown twice) and `doneText` replaces the progress.
 */
export function StartJobButton({
  action,
  label,
  pendingLabel,
  initialRunId = null,
  variant = "default",
  size = "default",
  doneText,
}: {
  action: (prev: FormState) => Promise<FormState>;
  label: string;
  pendingLabel: string;
  initialRunId?: string | null;
  variant?: "default" | "outline";
  size?: "default" | "sm";
  doneText?: string;
}) {
  const [state, dispatch, pending] = useActionState(action, { ...initialFormState, runId: initialRunId });
  const [, startTransition] = useTransition();
  const router = useRouter();
  const [doneRunId, setDoneRunId] = useState<string | null>(null);
  const runId = state.runId ?? null;
  const onDone = useCallback(() => {
    if (doneText) setDoneRunId(runId);
    router.refresh();
  }, [router, doneText, runId]);
  useSavedToast(state);
  return (
    <div className="space-y-2">
      <Button type="button" variant={variant} size={size} disabled={pending} onClick={() => startTransition(() => dispatch())}>
        {pending ? pendingLabel : label}
      </Button>
      <FieldError error={state.message && !state.ok ? state.message : undefined} />
      {runId && runId === doneRunId ? (
        <p role="status" className="text-xs text-muted-foreground">
          {doneText}
        </p>
      ) : runId ? (
        <JobProgress key={runId} runId={runId} onDone={onDone} />
      ) : null}
    </div>
  );
}
