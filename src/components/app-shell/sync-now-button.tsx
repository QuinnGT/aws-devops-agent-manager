"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { syncNowAction } from "./actions";

/**
 * "Sync now": requests a sync, confirms with a toast, and shows a failure next to the button.
 * With `disabledReason` (the caller's role can't sync), the button is disabled and the
 * reason shows in a tooltip and to screen readers, so the control doesn't just vanish.
 */
export function SyncNowButton({ alias, variant = "outline", disabledReason }: { alias: string; variant?: "outline" | "default"; disabledReason?: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  if (disabledReason) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A disabled button gets no pointer or focus events, so the wrapper carries the tooltip. */}
          <span tabIndex={0} className="inline-flex rounded-md" aria-describedby={reasonId}>
            <Button type="button" variant={variant} size="sm" disabled aria-describedby={reasonId}>
              <RefreshCw aria-hidden />
              Sync now
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{disabledReason}</TooltipContent>
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      </Tooltip>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant={variant}
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await syncNowAction(alias);
            if (r.ok) {
              setError(null);
              toast.success(r.message);
              router.refresh();
            } else setError(r.message);
          })
        }
      >
        <RefreshCw aria-hidden className={pending ? "motion-safe:animate-spin" : undefined} />
        Sync now
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-destructive-fg">
          {error}
        </span>
      ) : null}
    </span>
  );
}
