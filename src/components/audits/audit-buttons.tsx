"use client";

import { RefreshCw } from "lucide-react";
import { useRouter, useSelectedLayoutSegment } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { cancelAuditAction, rerunFailedAction, rerunItemAction } from "@/app/(app)/spaces/[alias]/audits/actions";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { plural } from "./words";

/** The audit header and tabs for the current tab; nothing on an incident page, which has its own header. */
export function AuditChrome({ chrome }: { chrome: { investigations: ReactNode; findings: ReactNode; report: ReactNode } }) {
  const seg = useSelectedLayoutSegment();
  if (seg === null) return <>{chrome.investigations}</>;
  if (seg === "findings") return <>{chrome.findings}</>;
  if (seg === "report") return <>{chrome.report}</>;
  return null;
}

function ErrorText({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-xs text-destructive-fg">
      {message}
    </p>
  ) : null;
}

/** "Rerun <N> failed reviews" (audits.run). Failed reviews have no findings, so no confirmation is needed. */
export function RerunFailedButton({ alias, auditId, count }: { alias: string; auditId: string; count: number }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() =>
          start(async () => {
            const r = await rerunFailedAction(alias, auditId);
            if (!r.ok) return setError(r.message);
            setError(null);
            toast.success(`Queued ${plural(r.queued, "review")} again`);
            router.refresh();
          })
        }
      >
        <RefreshCw aria-hidden />
        Rerun {plural(count, "failed review")}
      </Button>
      <ErrorText message={error} />
    </div>
  );
}

/** "Cancel audit" with its confirmation (audits.run, running audits only). */
export function CancelAuditButton({ alias, auditId, name }: { alias: string; auditId: string; name: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="sm" disabled={busy}>
            Cancel audit
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel {name}?</AlertDialogTitle>
            <AlertDialogDescription>Reviews in progress stop after their current step. Finished reviews and findings are kept.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep running</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                start(async () => {
                  const r = await cancelAuditAction(alias, auditId);
                  if (!r.ok) return setError(r.message);
                  toast.success("Audit cancelled");
                  router.refresh();
                })
              }
            >
              Cancel audit
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ErrorText message={error} />
    </div>
  );
}

/**
 * "Rerun review" for one investigation (audits.run). When its current review
 * has accepted or rejected findings the service asks for confirmation; the
 * dialog shows the service's sentence and repeats the call with it.
 */
export function RerunItemButton({ alias, auditId, itemId, label = "Rerun review", variant = "outline" }: { alias: string; auditId: string; itemId: string; label?: string; variant?: "outline" | "ghost" }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (confirmReplace: boolean) =>
    start(async () => {
      const r = await rerunItemAction(alias, auditId, itemId, confirmReplace);
      if (!r.ok) {
        if (r.code === "confirm") return setConfirm(r.message);
        return setError(r.message);
      }
      setConfirm(null);
      setError(null);
      toast.success("Review queued");
      router.refresh();
    });
  return (
    <div className="flex flex-col items-start gap-1">
      <Button variant={variant} size="sm" disabled={busy} onClick={() => run(false)}>
        <RefreshCw aria-hidden />
        {label}
      </Button>
      <ErrorText message={error} />
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Review this investigation again?</AlertDialogTitle>
            <AlertDialogDescription>{confirm}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the current review</AlertDialogCancel>
            <AlertDialogAction onClick={() => run(true)}>Review again</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
