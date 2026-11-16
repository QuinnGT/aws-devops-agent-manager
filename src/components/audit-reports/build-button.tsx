"use client";

import { FileText, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useReport } from "./report-context";

/** "Build the report" (first build) or "Rebuild the report" (stale). Narrative edits are kept. */
export function BuildReportButton({ rebuild }: { rebuild: boolean }) {
  const { alias, auditId, actions } = useReport();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const Icon = rebuild ? RefreshCw : FileText;
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await actions.build(alias, auditId);
            if (!r.ok) return setError(r.message);
            setError(null);
            toast.success(rebuild ? "Report rebuilt" : "Report built");
            router.refresh();
          })
        }
      >
        <Icon aria-hidden className={pending ? "motion-safe:animate-spin" : undefined} />
        {rebuild ? "Rebuild the report" : "Build the report"}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}
