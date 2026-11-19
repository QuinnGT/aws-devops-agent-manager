"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { acceptAllAction } from "@/app/(app)/spaces/[alias]/audits/actions";
import { Button } from "@/components/ui/button";
import { plural } from "./words";

/**
 * Bulk accept for one incident: "Accept <N>" when every proposed finding
 * passed the citation check, "Accept the <N> without problems" otherwise.
 * The service leaves out findings with a failed citation either way.
 */
export function AcceptIncidentButton({
  alias,
  auditId,
  itemId,
  incident,
  eligible,
  flagged,
  compact = false,
}: {
  alias: string;
  auditId: string;
  itemId: string;
  incident: string;
  eligible: number;
  flagged: number;
  /** A small button, for a list's group header */
  compact?: boolean;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (eligible === 0) return null;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size={compact ? "xs" : "sm"}
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
