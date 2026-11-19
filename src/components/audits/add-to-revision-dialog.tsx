"use client";

import { GitBranch } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { addToRevisionAction } from "@/app/(app)/spaces/[alias]/audits/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { nameProblem } from "@/components/revisions/words";
import { confirmRevisionLabel, plural } from "./words";

/** An open revision a finding can go to (RevisionOption, with the time as text so it crosses to the client). */
export interface RevisionChoice {
  id: string;
  name: string;
  /** "open", "creating" */
  state: string;
  toAddress: number;
  linked: number;
  updatedAt: string;
}

export interface AddToRevisionDialogProps {
  alias: string;
  /** The findings to send: one, or every accepted package fix not in a revision */
  findings: { id: string; title: string }[];
  /** The findings are still proposed: accept them first */
  acceptFirst: boolean;
  /** Newest first; empty when there is no open revision */
  options: RevisionChoice[];
  nameRule: { pattern: string; hint: string; maxLength: number };
  /** The button that opens the dialog */
  trigger: (open: () => void, disabled: boolean) => ReactNode;
}

const NEW = "new";

/**
 * "Add to revision…" and "Accept and add to revision…" (pages/audit-detail.md,
 * "What happens next"): choose an open revision, or start one with a name.
 * Adding puts the finding on the revision's to-address list. Nothing is
 * written to the Agent Space: that happens when the revision's plan is applied.
 */
export function AddToRevisionDialog(p: AddToRevisionDialogProps) {
  const router = useRouter();
  const ids = { name: useId(), note: useId(), nameError: useId(), group: useId() };
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string>(p.options[0]?.id ?? NEW);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [busy, start] = useTransition();
  // The button that opened the dialog gets focus back when it closes (the dialog has no trigger of its own).
  const [opener, setOpener] = useState<HTMLElement | null>(null);

  const one = p.findings.length === 1;
  const creating = choice === NEW;
  const picked = p.options.find((o) => o.id === choice) ?? null;
  const trimmed = name.trim();
  const problem = creating ? nameProblem(trimmed, p.nameRule) : null;
  const nameError = problem ?? (error?.field === "name" ? error.message : null);

  const submit = () =>
    start(async () => {
      if (creating && !trimmed) return setError({ message: "Name the revision.", field: "name" });
      if (problem) return setError({ message: problem, field: "name" });
      const r = await addToRevisionAction(p.alias, {
        findingIds: p.findings.map((f) => f.id),
        acceptFirst: p.acceptFirst,
        target: creating ? { kind: "new", name: trimmed, note: note.trim() || undefined } : { kind: "existing", revisionId: choice },
      });
      if (!r.ok) {
        setError({ message: r.message, field: r.fieldErrors.name ? "name" : undefined });
        // A finding that was accepted stays accepted: show it.
        if (r.details?.accepted) router.refresh();
        return;
      }
      setError(null);
      setOpen(false);
      const where = r.created ? `a new revision, ${r.revisionName}` : (picked?.name ?? "the revision");
      toast.success(
        r.alreadyThere && !r.added
          ? `Already in ${where}`
          : `${r.accepted ? `Accepted and added` : "Added"} ${plural(r.added, "fix", "fixes")} to ${where}${r.alreadyThere ? `. ${plural(r.alreadyThere, "was", "were")} already there` : ""}`,
      );
      router.refresh();
    });

  return (
    <>
      {p.trigger(() => {
        setOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
        setError(null);
        setOpen(true);
      }, busy)}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
          onCloseAutoFocus={(e) => {
            if (opener?.isConnected) {
              e.preventDefault();
              opener.focus();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{one ? (p.acceptFirst ? "Accept this fix and add it to a revision" : "Add this fix to a revision") : `Add ${p.findings.length} package fixes to a revision`}</DialogTitle>
            <DialogDescription>
              A revision is a copy of the package where the fix is made. The {one ? "fix goes" : "fixes go"} on its to-address list, and a save that links {one ? "it" : "them"} takes {one ? "it" : "them"} off the list. Nothing changes in the Agent Space until the
              revision&apos;s plan is applied.
            </DialogDescription>
          </DialogHeader>
          {!one ? (
            <ul className="max-h-28 list-disc space-y-0.5 overflow-y-auto pl-5 text-[13px] text-muted-foreground">
              {p.findings.map((f) => (
                <li key={f.id} className="line-clamp-2 [overflow-wrap:anywhere]">
                  {f.title}
                </li>
              ))}
            </ul>
          ) : null}
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-[13px] font-medium">Which revision</legend>
            {p.options.map((o) => (
              <label key={o.id} className={cn("flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-[13px] has-[:checked]:border-foreground/40 has-[:checked]:bg-muted/50 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring")}>
                <input type="radio" name={ids.group} value={o.id} checked={choice === o.id} onChange={() => setChoice(o.id)} className="mt-0.5 size-4 accent-foreground" />
                <span className="min-w-0">
                  <span className="block font-semibold [overflow-wrap:anywhere]">{o.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {o.state === "creating" ? "Being created. " : ""}
                    {plural(o.toAddress, "fix", "fixes")} to address, {o.linked} linked
                  </span>
                </span>
              </label>
            ))}
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-[13px] has-[:checked]:border-foreground/40 has-[:checked]:bg-muted/50 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring">
              <input type="radio" name={ids.group} value={NEW} checked={creating} onChange={() => setChoice(NEW)} className="mt-0.5 size-4 accent-foreground" />
              <span className="min-w-0">
                <span className="block font-semibold">Start a new revision</span>
                <span className="block text-xs text-muted-foreground">From the live space. You name it; the package is copied in the background.</span>
              </span>
            </label>
          </fieldset>
          {creating ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor={ids.name}>Revision name</Label>
                <Input
                  id={ids.name}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError(null);
                  }}
                  maxLength={p.nameRule.maxLength}
                  placeholder="v2.4"
                  autoComplete="off"
                  aria-invalid={nameError ? true : undefined}
                  aria-describedby={nameError ? ids.nameError : undefined}
                />
                {nameError ? (
                  <p id={ids.nameError} role="alert" className="text-xs text-destructive-fg">
                    {nameError}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">{p.nameRule.hint}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={ids.note}>Note (optional)</Label>
                <Textarea id={ids.note} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} placeholder="What this revision is for" />
              </div>
            </div>
          ) : null}
          {error && error.field !== "name" ? (
            <p role="alert" className="text-[13px] text-destructive-fg">
              {error.message}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" onClick={submit} disabled={busy || (creating && (!trimmed || !!problem))}>
              <GitBranch aria-hidden />
              {confirmRevisionLabel({ acceptFirst: p.acceptFirst, target: creating ? "new" : { name: picked?.name ?? "the revision" } })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
