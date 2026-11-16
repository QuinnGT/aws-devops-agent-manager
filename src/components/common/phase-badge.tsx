import { cn } from "@/lib/utils";

/** Dashed "Planned" badge for features a later phase adds; the phase number is only in its tooltip. */
export function PhaseBadge({ phase, className }: { phase: number; className?: string }) {
  return (
    <span
      title={`Planned for phase ${phase}`}
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full border border-dashed border-border px-2 text-xs font-medium whitespace-nowrap text-muted-foreground",
        className,
      )}
    >
      Planned
    </span>
  );
}
