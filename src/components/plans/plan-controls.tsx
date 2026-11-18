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
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
 * Approve and apply in the page header (plan-review.md "Approve and apply"):
 * Reject when the viewer can, and the first button of the buttons-by-role
 * table, disabled with its reason when it can't run yet. The button opens one
 * dialog that is also the confirmation: what apply writes, the change reason
 * (typed in when the viewer may, else read only), the approval facts and,
 * for apply, what apply does.
 */
export function ApprovalControls({
  alias,
  planId,
  spaceName,
  actions,
  reason: initialReason,
  reasonRequired,
  reasonLocked = null,
  facts,
  confirm,
  steps,
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
  facts: ReactNode;
  confirm: { title: string; counts: { label: string; n: number }[]; skippedNames: string[]; button: string };
  /** "What apply does", in the apply dialog */
  steps: readonly string[];
  /** Shown instead of buttons on a closed plan ("Applied Nov 10, 3:12 PM") */
  closedNote: ReactNode;
  run: PlanControlActions;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState(initialReason ?? "");
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [open, setOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const reasonId = useId();
  const reasonErrId = useId();
  const openFocus = useReturnFocus();
  const rejectFocus = useReturnFocus();
  const noteId = useId();
  const primary = actions.primary;
  // The reason is saved with "Request approval" and with apply; not next to "Approve", which doesn't save it.
  const editable = reasonEditable(actions);
  const reasonError = result && !result.ok ? (result.fieldErrors.reason ?? null) : null;
  const pageError = result && !result.ok && !result.fieldErrors.reason ? result.message : null;
  const text = () => (reason.trim() ? reason.trim() : null);

  const runAction = (fn: () => Promise<ActionResult<unknown>>, done: string) => {
    startTransition(async () => {
      const r = await fn();
      setResult(r);
      if (r.ok) {
        toast.success(done);
        setOpen(false);
        router.refresh();
      }
    });
  };

  const onSubmit = () => {
    if (!primary?.enabled || pending) return;
    if (primary.action === "apply") {
      if (reasonRequired && !text()) {
        setResult({ ok: false, message: "", fieldErrors: { reason: "Enter a change reason. This space requires one." } });
        return;
      }
      runAction(() => run.apply(alias, planId, text()), confirm.button.replace(/^Apply/, "Applying"));
    } else if (primary.action === "request-approval") {
      runAction(() => run.requestApproval(alias, planId, text()), "Approval requested");
    } else {
      runAction(() => run.approve(alias, planId), "Plan approved");
    }
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

  if (!primary) return <p className="max-w-md text-[13px] text-muted-foreground">{closedNote}</p>;

  const icon = primary.action === "request-approval" ? <Send aria-hidden /> : primary.action === "approve" ? <UserCheck aria-hidden /> : <GitMerge aria-hidden />;
  const apply = primary.action === "apply";
  const title = apply ? confirm.title : primary.action === "request-approval" ? "Request approval for this plan?" : "Approve this plan?";
  const description = apply
    ? `Writes go to ${spaceName}. There is no undo: to go back, restore an earlier version as a new plan.`
    : primary.action === "request-approval"
      ? "The plan waits for a second person to approve it. The change reason is saved with the request."
      : "Approving lets the plan be applied. Nothing is written to the space until then.";
  const button = (
    <Button
      size="sm"
      disabled={pending}
      onClick={() => {
        setResult(null);
        openFocus.remember();
        setOpen(true);
      }}
    >
      {icon}
      {primary.label}
    </Button>
  );

  return (
    <>
      {actions.reject ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            rejectFocus.remember();
            setRejectOpen(true);
          }}
          disabled={pending}
        >
          Reject
        </Button>
      ) : null}
      {primary.enabled ? button : <DisabledReason reason={primary.disabledReason}>{button}</DisabledReason>}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[560px]" onCloseAutoFocus={openFocus.onCloseAutoFocus}>
          <form
            className="grid min-w-0 gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            {apply ? (
              <div className="space-y-1 text-[13px]">
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
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor={reasonId} className="block text-[13px] font-medium">
                Change reason {reasonRequired ? <span className="font-normal text-muted-foreground">(required for this space)</span> : null}
              </Label>
              {editable ? (
                <Textarea
                  id={reasonId}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="max-h-48 min-h-20 text-[13px] md:text-[13px]"
                  aria-invalid={reasonError ? true : undefined}
                  aria-describedby={`${reasonId}-help${reasonError ? ` ${reasonErrId}` : ""}`}
                />
              ) : (
                <p id={reasonId} aria-describedby={`${reasonId}-help`} className="max-h-48 overflow-y-auto rounded-md border bg-muted/30 px-3 py-2 text-[13px] whitespace-pre-wrap">
                  {initialReason ?? <span className="text-muted-foreground">No reason entered yet.</span>}
                </p>
              )}
              <p id={`${reasonId}-help`} className="text-xs text-muted-foreground">
                {!editable && reasonLocked ? `${reasonLocked} ` : null}Saved with this change in the history and shown on the History page.
              </p>
              {reasonError ? <FieldError id={reasonErrId}>{reasonError}</FieldError> : null}
            </div>
            {facts}
            {apply && steps.length ? (
              <div>
                <p className="text-xs font-medium text-muted-foreground">What apply does</p>
                <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
                  {steps.map((st) => (
                    <li key={st}>{st}</li>
                  ))}
                </ol>
              </div>
            ) : null}
            {pageError ? <FieldError id={`${reasonId}-page`}>{pageError}</FieldError> : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={pending}>
                {icon}
                {pending ? "Working…" : apply ? confirm.button : primary.label}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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
    </>
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
