import { cn } from "@/lib/utils";

/** "+20 −19" in success-fg and destructive-fg, with words for screen readers. No server imports, so client components can use it. */
export function DiffCounts({ added, removed, className }: { added: number; removed: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-mono text-xs font-semibold tabular-nums", className)}>
      <span className="text-success-fg">
        +{added}
        <span className="sr-only"> {added === 1 ? "line" : "lines"} added</span>
      </span>
      <span className="text-destructive-fg">
        {"\u2212"}
        {removed}
        <span className="sr-only"> {removed === 1 ? "line" : "lines"} removed</span>
      </span>
    </span>
  );
}
