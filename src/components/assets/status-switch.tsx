"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export type StatusResult = { ok: true; message: string } | { ok: false; message: string };

/**
 * The Active switch for a user with drafts.write: toggling it adds the status
 * change to the user's draft of the asset (it never writes to the space), and
 * a toast confirms. A failure shows next to the switch.
 */
export function StatusSwitch({
  active,
  liveActive,
  assetName,
  action,
  className,
}: {
  /** The status in the user's draft, else the live status */
  active: boolean;
  liveActive: boolean;
  assetName: string;
  action: (status: "ACTIVE" | "INACTIVE") => Promise<StatusResult>;
  className?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const on = optimistic ?? active;
  const label = on ? "Active" : "Inactive";
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-2 gap-y-1", className)}>
      <span className="inline-flex min-h-6 items-center gap-2">
        <Switch
          id={id}
          checked={on}
          disabled={pending}
          aria-label={`${label}: ${assetName}`}
          className="data-[state=unchecked]:border-muted-foreground"
          onCheckedChange={(next) =>
            start(async () => {
              setOptimistic(next);
              const r = await action(next ? "ACTIVE" : "INACTIVE");
              if (r.ok) {
                setError(null);
                toast.success(r.message);
                router.refresh();
              } else {
                setError(r.message);
              }
              setOptimistic(null);
            })
          }
        />
        <label htmlFor={id} className="text-[13px] font-medium">
          {label}
        </label>
      </span>
      {on !== liveActive ? <span className="text-xs text-muted-foreground">In your draft. Live is {liveActive ? "Active" : "Inactive"}.</span> : null}
      {error ? (
        <span role="alert" className="text-xs text-destructive-fg">
          {error}
        </span>
      ) : null}
    </span>
  );
}
