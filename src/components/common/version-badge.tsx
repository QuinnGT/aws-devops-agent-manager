import { cn } from "@/lib/utils";

/** "v24", "new" or "deleted" in monospace on bg-muted. */
export function VersionBadge({ version, className }: { version: number | "new" | "deleted"; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 items-center rounded-md bg-muted px-1.5 font-mono text-xs font-medium text-muted-foreground tabular-nums whitespace-nowrap", className)}>
      {typeof version === "number" ? `v${version}` : version}
    </span>
  );
}
