"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import type { ActionResult } from "@/components/plans/action-state";
import { useReturnFocus } from "@/components/plans/return-focus";
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

export type AbandonRevisionAction = (revisionId: string, note: string) => Promise<ActionResult>;

/**
 * "Abandon" with its confirmation: the revision becomes read only and its
 * branch stays in the history repository. Needs `revisions.build`.
 */
export function AbandonButton({ revisionId, name, action, disabled }: { revisionId: string; name: string; action: AbandonRevisionAction; disabled?: boolean }) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const focus = useReturnFocus();

  const confirm = () =>
    start(async () => {
      setError(null);
      const r = await action(revisionId, note);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setOpen(false);
      router.refresh();
    });

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled || pending}
        onClick={() => {
          focus.remember();
          setOpen(true);
        }}
      >
        Abandon
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent onCloseAutoFocus={focus.onCloseAutoFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>Abandon revision {name}?</AlertDialogTitle>
            <AlertDialogDescription>The revision becomes read only. Its branch and saves stay in the history repository, and nothing changes in the space.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={id}>
              Note <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} placeholder="For example: superseded by v2.5" />
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive-fg">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                confirm();
              }}
            >
              {pending ? "Abandoning…" : "Abandon revision"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
