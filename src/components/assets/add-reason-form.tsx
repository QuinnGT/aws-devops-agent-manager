"use client";

import { MessageSquareText } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useCallback, useId, useState } from "react";
import { JobProgress } from "@/components/job-progress";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type AddReasonState = { status: "idle" } | { status: "error"; message: string } | { status: "queued"; runId: string };

/**
 * "Add reason" for one change made outside the app: a dialog that queues the
 * worker job (a git note on the commit) and shows its progress. Focus stays
 * in the dialog and returns to the button on close.
 */
export function AddReasonButton({
  alias,
  assetId,
  commit,
  target,
  action,
  variant = "outline",
  label = "Add reason",
  defaultOpen = false,
}: {
  alias: string;
  assetId: string;
  commit: string;
  /** What the reason is for, in the dialog title and the button's accessible name: "overview v24" */
  target: string;
  action: (prev: AddReasonState, formData: FormData) => Promise<AddReasonState>;
  variant?: "outline" | "ghost";
  label?: string;
  /** Open the dialog on first render (a link to ?reason=<version>) */
  defaultOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [key, setKey] = useState(0);
  const refresh = useCallback(() => router.refresh(), [router]);
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setKey((k) => k + 1);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant={variant} size="sm">
          {variant === "outline" ? <MessageSquareText aria-hidden /> : null}
          {label}
          <span className="sr-only"> for {target}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a reason for {target}</DialogTitle>
          <DialogDescription>Saved with this change in the history, so anyone can see why it was made.</DialogDescription>
        </DialogHeader>
        <ReasonForm key={key} alias={alias} assetId={assetId} commit={commit} action={action} onDone={refresh} />
      </DialogContent>
    </Dialog>
  );
}

function ReasonForm({
  alias,
  assetId,
  commit,
  action,
  onDone,
}: {
  alias: string;
  assetId: string;
  commit: string;
  action: (prev: AddReasonState, formData: FormData) => Promise<AddReasonState>;
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as AddReasonState);
  const id = useId();
  if (state.status === "queued") {
    return (
      <div className="space-y-4">
        <JobProgress runId={state.runId} onDone={onDone} />
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" size="sm">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </div>
    );
  }
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="alias" value={alias} />
      <input type="hidden" name="assetId" value={assetId} />
      <input type="hidden" name="commit" value={commit} />
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-text`}>Why was this change made?</Label>
        <Textarea id={`${id}-text`} name="reason" required maxLength={2000} rows={4} aria-describedby={state.status === "error" ? `${id}-err` : undefined} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-link`}>Link (optional)</Label>
        <Input id={`${id}-link`} name="link" type="url" placeholder="https://" />
        <p className="text-xs text-muted-foreground">A ticket or document about the change. Only http and https links are kept.</p>
      </div>
      {state.status === "error" ? (
        <p id={`${id}-err`} role="alert" className="text-xs text-destructive-fg">
          {state.message}
        </p>
      ) : null}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" size="sm">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving" : "Save reason"}
        </Button>
      </DialogFooter>
    </form>
  );
}
