"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { shortCommit } from "./words";

/** The short commit hash, in mono. Pressing it copies the full hash. */
export function CopyCommit({ commit }: { commit: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 px-1.5 font-mono text-xs text-foreground"
      aria-label={`Commit ${commit}. Copy the full hash`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(commit);
          toast.success("Commit hash copied");
        } catch {
          toast.message(commit);
        }
      }}
    >
      <Copy aria-hidden />
      {shortCommit(commit)}
    </Button>
  );
}
