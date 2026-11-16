import { Lock, Power, PowerOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ManagedLabel } from "@/server/assets/catalog";
import { cn } from "@/lib/utils";

/**
 * Small labels for asset pages. Status words for plans and validation use
 * the shared StatusBadge; change sources use SourceBadge.
 */

/** The asset type, as a plain outline badge ("Memory"). */
export function TypeBadge({ label }: { label: string }) {
  return (
    <Badge variant="outline" className="h-[22px] px-2 font-medium text-muted-foreground">
      {label}
    </Badge>
  );
}

/** "Managed store" (or "Managed") with a lock, when policy marks the asset or its store as managed by DevOps Agent. */
export function ManagedBadge({ managed, compact = false }: { managed: ManagedLabel; compact?: boolean }) {
  if (!managed.managed) return null;
  const detail = managed.via === "store" ? `In the managed store ${managed.storeName ?? ""}`.trim() : "Managed by DevOps Agent";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="h-[22px] gap-1 px-2 font-medium text-muted-foreground">
          <Lock aria-hidden />
          {compact ? "Managed" : "Managed store"}
          <span className="sr-only">: {detail}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}

export function DeletedBadge({ deleted }: { deleted: boolean }) {
  return deleted ? (
    <Badge variant="outline" className="h-[22px] border-destructive/45 bg-destructive/12 px-2 font-medium text-destructive-fg">
      Deleted
    </Badge>
  ) : null;
}

/** Status for a viewer who can't change it: the words with a Power or PowerOff icon, never a colored word alone. */
export function StatusWord({ status, className }: { status: string | null; className?: string }) {
  if (!status) return <span className="text-xs text-muted-foreground">No status</span>;
  const active = status === "ACTIVE";
  const Icon = active ? Power : PowerOff;
  const label = active ? "Active" : status === "INACTIVE" ? "Inactive" : status;
  return (
    <span className={cn("inline-flex min-h-6 items-center gap-1.5 text-[13px] font-medium", !active && "text-muted-foreground", className)}>
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}
