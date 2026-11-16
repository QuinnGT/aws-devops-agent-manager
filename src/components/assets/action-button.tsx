"use client";

import { Copy, Undo2 } from "lucide-react";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

/**
 * A button that runs a Server Action which redirects on success ("Edit as
 * draft", "Restore v23 as a plan"). A refusal shows next to the button with
 * role="alert"; there is no toast, since the page changes on success.
 * With `confirm`, the click opens an AlertDialog first (restores).
 */
export function ActionButton({
  action,
  children,
  pendingLabel,
  variant = "outline",
  icon,
  className,
  confirm,
}: {
  action: () => Promise<ActionResult | void>;
  children: ReactNode;
  pendingLabel: string;
  variant?: "default" | "outline";
  icon?: "restore";
  className?: string;
  /** Ask first: title, body and the confirm button's label */
  confirm?: { title: string; body: string; label: string };
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = () =>
    start(async () => {
      const r = await action();
      if (r && !r.ok) setError(r.message);
    });
  const button = (
    <Button type="button" variant={variant} size="sm" disabled={pending} onClick={confirm ? undefined : run}>
      {icon === "restore" ? <Undo2 aria-hidden /> : null}
      {pending ? pendingLabel : children}
    </Button>
  );
  return (
    <span className={cn("inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1", className)}>
      {error ? (
        <span role="alert" className="max-w-[48ch] text-right text-xs text-destructive-fg">
          {error}
        </span>
      ) : null}
      {confirm ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>{button}</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
              <AlertDialogDescription>{confirm.body}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={run}>{confirm.label}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : (
        button
      )}
    </span>
  );
}

/** Says what the short ID chip is: its tooltip, and the start of its accessible name. */
export const ASSET_ID_LABEL = "Asset ID in the Agent Space";

/** Ghost button with the short asset ID; copies the full ID. The tooltip says what the ID is. */
export function CopyIdButton({ id, short }: { id: string; short: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-1.5 font-mono text-xs text-foreground"
          aria-label={`${ASSET_ID_LABEL}: ${id}. Copy`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(id);
              toast.success("Asset ID copied");
            } catch {
              toast.message(id);
            }
          }}
        >
          <Copy aria-hidden />
          {short}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{ASSET_ID_LABEL}. Click to copy.</TooltipContent>
    </Tooltip>
  );
}

