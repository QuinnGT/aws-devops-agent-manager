"use client";

import { Check, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { acceptAllAction, findingAction } from "@/app/(app)/spaces/[alias]/audits/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { plural } from "./words";

/**
 * Reject with an optional note, in a small popover (pages/audit-detail.md,
 * "Rejecting"). The note is stored as the finding's review note.
 */
export function RejectPopover({
  onReject,
  trigger,
  open,
  onOpenChange,
}: {
  onReject: (note: string) => void | Promise<void>;
  trigger: ReactNode;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
}) {
  const [inner, setInner] = useState(false);
  const isOpen = open ?? inner;
  const setOpen = onOpenChange ?? setInner;
  const [note, setNote] = useState("");
  const id = useId();
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await onReject(note.trim());
            setNote("");
            setOpen(false);
          }}
          className="space-y-2"
        >
          <Label htmlFor={id}>Why, for the record</Label>
          <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} placeholder="Optional" />
          <div className="flex justify-end">
            <Button type="submit" size="sm">
              <X aria-hidden />
              Reject
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** Accept and Reject for one finding row of the Findings tab. */
export function FindingRowActions({ alias, findingId, title }: { alias: string; findingId: string; title: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const act = (action: "accept" | "reject", note?: string) =>
    start(async () => {
      const r = await findingAction(alias, findingId, action === "accept" ? { action } : { action, note: note || undefined });
      if (!r.ok) return setError(r.message);
      setError(null);
      router.refresh();
    });
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => act("accept")} aria-label={`Accept ${title}`}>
          Accept
        </Button>
        <RejectPopover
          onReject={(n) => act("reject", n)}
          trigger={
            <Button variant="ghost" size="sm" disabled={busy} aria-label={`Reject ${title}`}>
              Reject
            </Button>
          }
        />
      </div>
      {error ? (
        <p role="alert" className="max-w-56 text-right text-xs text-destructive-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Bulk accept for one incident: "Accept <N>" when every proposed finding
 * passed the citation check, "Accept the <N> without problems" otherwise.
 * The service leaves out findings with a failed citation either way.
 */
export function AcceptIncidentButton({ alias, auditId, itemId, incident, eligible, flagged }: { alias: string; auditId: string; itemId: string; incident: string; eligible: number; flagged: number }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (eligible === 0) return null;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() =>
          start(async () => {
            const r = await acceptAllAction(alias, auditId, itemId);
            if (!r.ok) return setError(r.message);
            setError(null);
            toast.success(`Accepted ${plural(r.accepted, "finding")} in ${incident}`);
            router.refresh();
          })
        }
      >
        <Check aria-hidden />
        {flagged ? `Accept the ${eligible} without problems` : `Accept ${eligible}`}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}
