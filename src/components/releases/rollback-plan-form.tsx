"use client";

import { GitPullRequest } from "lucide-react";
import { useActionState, useId } from "react";
import { Callout } from "@/components/common/callout";
import { DisabledReason } from "@/components/common/disabled-reason";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { RollbackPlanAction, RollbackPlanState } from "./action-state";

const IDLE: RollbackPlanState = { status: "idle" };

/**
 * The "Create the restore plan" form: the plan title and the button. The
 * action creates the plan and goes to the plan page; a refusal shows here.
 */
export function RollbackPlanForm({
  action,
  defaultTitle,
  titleMaxChars,
  disabledReason,
}: {
  /** createRollbackPlanAction bound to the space alias and release name */
  action: RollbackPlanAction;
  defaultTitle: string;
  titleMaxChars: number;
  /** Why the plan can't be created now, or null */
  disabledReason: string | null;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const id = useId();
  const errId = useId();
  const titleError = state.status === "error" ? state.fieldErrors.title : undefined;
  const button = (
    <Button type="submit" className="w-full" disabled={pending}>
      <GitPullRequest aria-hidden />
      {pending ? "Creating the plan…" : "Create restore plan"}
    </Button>
  );
  return (
    <form action={formAction} className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor={id}>Plan title</Label>
        <Input
          id={id}
          name="title"
          defaultValue={defaultTitle}
          maxLength={titleMaxChars}
          required
          aria-invalid={titleError ? true : undefined}
          aria-describedby={titleError ? errId : undefined}
        />
        {titleError ? (
          <p id={errId} role="alert" className="text-xs text-destructive-fg">
            {titleError}
          </p>
        ) : null}
      </div>
      {state.status === "error" && !titleError ? (
        <Callout tone="destructive" title="The restore plan wasn't created" afterAction>
          <p>{state.message}</p>
          {state.problems.length ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {state.problems.slice(0, 10).map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          ) : null}
        </Callout>
      ) : null}
      {disabledReason ? (
        <DisabledReason reason={disabledReason} className="flex-col items-stretch">
          {button}
        </DisabledReason>
      ) : (
        button
      )}
    </form>
  );
}
