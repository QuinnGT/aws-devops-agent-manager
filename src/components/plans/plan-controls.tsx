"use client";

import { CircleX, GitMerge, RefreshCw, Send, UserCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { DisabledReason } from "@/components/common/disabled-reason";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionButton, PlanActions } from "@/server/plans/actions";
import type { ActionResult } from "./action-state";
import { useReturnFocus } from "./return-focus";
import { reasonEditable } from "./words";

type Simple = (alias: string, planId: string) => Promise<ActionResult>;

export interface PlanControlActions {
  requestApproval: (alias: string, planId: string, reason: string | null) => Promise<ActionResult>;
  approve: Simple;
  reject: (alias: string, planId: string, note: string) => Promise<ActionResult>;
  apply: (alias: string, planId: string, reason: string | null) => Promise<ActionResult<{ applyRunId: string; writes: number }>>;
}

function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="flex items-start gap-1.5 text-xs text-destructive-fg">
      <CircleX className="mt-px size-3.5 shrink-0" aria-hidden />
      {children}
    </p>
  );
}

/**
 * The "Approve and apply" card body (plan-review.md): the change reason, the
 * approval facts (rendered by the server), and the first button row of the
 * buttons-by-role table that applies to this user and plan.
 */
export function ApproveApplyPanel({
  alias,
  planId,
  spaceName,
  actions,
  reason: initialReason,
  reasonRequired,
  reasonLocked = null,
  primaryReason,
  facts,
  confirm,
  closedNote,
  run,
}: {
  alias: string;
  planId: string;
  spaceName: string;
  actions: PlanActions;
  reason: string | null;
  reasonRequired: boolean;
  /** Why the reason is read only (reasonLockedText), shown next to it */
  reasonLocked?: string | null;
  /** Shown instead of the primary button's disabledReason (a failed check: the cause and the next step, with a link) */
  primaryReason?: ReactNode;
  facts: ReactNode;
  confirm: { title: string; counts: { label: string; n: number }[]; skippedNames: string[]; button: string };
  /** Shown instead of buttons on a closed plan ("Applied Nov 10, 3:12 PM") */
  closedNote: ReactNode;
  run: PlanControlActions;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState(initialReason ?? "");
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const reasonId = useId();
  const reasonErrId = useId();
  const confirmFocus = useReturnFocus();
  const rejectFocus = useReturnFocus();
  const noteId = useId();
  const primary = actions.primary;
  // The reason is saved with "Request approval" and with apply; someone who can apply may type it before Apply unlocks.
  const editable = reasonEditable(actions);
  const reasonError = result && !result.ok ? (result.fieldErrors.reason ?? null) : null;
  const pageError = result && !result.ok && !result.fieldErrors.reason ? result.message : null;
  const text = () => (reason.trim() ? reason.trim() : null);

  const runAction = (fn: () => Promise<ActionResult<unknown>>, done: string, after?: () => void) => {
    startTransition(async () => {
      const r = await fn();
      setResult(r);
      if (r.ok) {
        toast.success(done);
        after?.();
        router.refresh();
      }
    });
  };

  const onPrimary = () => {
    if (!primary?.enabled) return;
    if (primary.action === "apply") {
      if (reasonRequired && !text()) {
        setResult({ ok: false, message: "", fieldErrors: { reason: "Enter a change reason. This space requires one." } });
        return;
      }
      setResult(null);
      confirmFocus.remember();
      setConfirmOpen(true);
    } else if (primary.action === "request-approval") {
      runAction(() => run.requestApproval(alias, planId, text()), "Approval requested");
    } else {
      runAction(() => run.approve(alias, planId), "Plan approved");
    }
  };

  const onApply = () => {
    setConfirmOpen(false);
    runAction(() => run.apply(alias, planId, text()), confirm.button.replace(/^Apply/, "Applying"));
  };

  const onReject = () => {
    if (!note.trim()) {
      setNoteError("Enter a note for the author.");
      return;
    }
    setNoteError(null);
    startTransition(async () => {
      const r = await run.reject(alias, planId, note);
      if (!r.ok) {
        setNoteError(r.fieldErrors.note ?? r.message);
        return;
      }
      setRejectOpen(false);
      setNote("");
      toast.success("Plan sent back to the author");
      router.refresh();
    });
  };

  const icon = primary?.action === "request-approval" ? <Send aria-hidden /> : primary?.action === "approve" ? <UserCheck aria-hidden /> : <GitMerge aria-hidden />;
  const button = primary ? (
    <Button className="w-full" onClick={onPrimary} disabled={pending}>
      {icon}
      {primary.label}
    </Button>
  ) : null;

  return (
    <div className="space-y-4 px-4 py-4">
      <div className="space-y-1.5">
        <Label htmlFor={reasonId} className="block text-[13px] font-medium">
          Change reason {reasonRequired ? <span className="font-normal text-muted-foreground">(required for this space)</span> : null}
        </Label>
        {editable ? (
          <Textarea
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="min-h-20 text-[13px] md:text-[13px]"
            aria-invalid={reasonError ? true : undefined}
            aria-describedby={`${reasonId}-help${reasonError ? ` ${reasonErrId}` : ""}`}
          />
        ) : (
          <p id={reasonId} aria-describedby={`${reasonId}-help`} className="rounded-md border bg-muted/30 px-3 py-2 text-[13px] whitespace-pre-wrap">
            {initialReason ?? <span className="text-muted-foreground">No reason entered yet.</span>}
          </p>
        )}
        <p id={`${reasonId}-help`} className="text-xs text-muted-foreground">
          {/* The same role reason sits next to the disabled button below; say it once. */}
          {!editable && reasonLocked && reasonLocked !== primary?.disabledReason ? `${reasonLocked} ` : null}Saved with this change in the history and shown on the History page.
        </p>
        {reasonError ? <FieldError id={reasonErrId}>{reasonError}</FieldError> : null}
      </div>

      {facts}

      {primary ? (
        <div className="space-y-2">
          {primary.enabled ? (
            button
          ) : (
            <DisabledReason reason={primaryReason ?? primary.disabledReason} className="flex-col items-stretch">
              {button}
            </DisabledReason>
          )}
          {actions.reject ? (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                rejectFocus.remember();
                setRejectOpen(true);
              }}
              disabled={pending}
            >
              Reject
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="text-[13px] text-muted-foreground">{closedNote}</div>
      )}
      {pageError ? <FieldError id={`${reasonId}-page`}>{pageError}</FieldError> : null}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent onCloseAutoFocus={confirmFocus.onCloseAutoFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-left text-[13px] text-foreground">
                <ul className="list-disc space-y-0.5 pl-5">
                  {confirm.counts.map((c) => (
                    <li key={c.label}>
                      <span className="tabular-nums">{c.n}</span> {(c.n === 1 ? c.label.replace(/s$/, "") : c.label).toLowerCase()}
                    </li>
                  ))}
                </ul>
                {confirm.skippedNames.length ? (
                  <p>
                    Skipped because live changed: <span className="font-medium">{confirm.skippedNames.join(", ")}</span>
                  </p>
                ) : null}
                <div>
                  <p className="text-xs text-muted-foreground">Change reason</p>
                  <p className="whitespace-pre-wrap">{text() ?? "None"}</p>
                </div>
                <p className="text-xs text-muted-foreground">Writes go to {spaceName}. There is no undo: to go back, restore an earlier version as a new plan.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onApply}>
              <GitMerge aria-hidden />
              {confirm.button}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <AlertDialogContent onCloseAutoFocus={rejectFocus.onCloseAutoFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject this plan?</AlertDialogTitle>
            <AlertDialogDescription>The plan goes back to its author with your note. Nothing is written to the space.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={noteId} className="text-[13px]">
              Note for the author
            </Label>
            <Textarea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} className="min-h-20 text-[13px] md:text-[13px]" aria-invalid={noteError ? true : undefined} aria-describedby={noteError ? `${noteId}-err` : undefined} />
            {noteError ? <FieldError id={`${noteId}-err`}>{noteError}</FieldError> : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" onClick={onReject} disabled={pending}>
              Reject plan
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** A callout or header action that runs one plan action and refreshes; errors show beside it. */
export function PlanActionButton({
  button,
  run,
  done,
  variant = "outline",
  navigateTo,
  icon,
  confirmTitle,
  confirmBody,
  confirmLabel,
}: {
  button: ActionButton<string>;
  run: () => Promise<ActionResult<{ planId?: string }>>;
  /** Toast after success */
  done?: string;
  variant?: "outline" | "ghost" | "default";
  /** Go here after success; "{planId}" is replaced with the plan ID the action returned */
  navigateTo?: string;
  icon?: "recheck";
  confirmTitle?: string;
  confirmBody?: string;
  confirmLabel?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const focus = useReturnFocus();
  const go = () =>
    startTransition(async () => {
      const r = await run();
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setError(null);
      if (done) toast.success(done);
      if (navigateTo) router.push(navigateTo.replace("{planId}", encodeURIComponent(r.planId ?? "")));
      else router.refresh();
    });
  const btn = (
    <Button
      variant={variant}
      size="sm"
      disabled={pending}
      onClick={
        confirmTitle
          ? () => {
              focus.remember();
              setOpen(true);
            }
          : go
      }
    >
      {icon === "recheck" ? <RefreshCw aria-hidden /> : null}
      {button.label}
    </Button>
  );
  if (!button.enabled) return <DisabledReason reason={button.disabledReason}>{btn}</DisabledReason>;
  return (
    <div className="flex flex-col items-end gap-1">
      {btn}
      {error ? (
        <p role="alert" className="text-xs text-destructive-fg">
          {error}
        </p>
      ) : null}
      {confirmTitle ? (
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogContent onCloseAutoFocus={focus.onCloseAutoFocus}>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
              {confirmBody ? <AlertDialogDescription>{confirmBody}</AlertDialogDescription> : null}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  setOpen(false);
                  go();
                }}
              >
                {confirmLabel ?? button.label}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}
