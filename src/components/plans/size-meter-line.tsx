import { cn } from "@/lib/utils";
import type { SizeMeter } from "@/server/assets/size-meter";

/**
 * Size meter for instructions in the plan and draft pages: "4.6 KB of 25 KB ·
 * 95 lines (about 120 recommended)" over a bar in the asset-detail.md tones
 * (success under the recommended lines, warning above, destructive over the
 * limit). The text and the bar come from the same SizeMeter.
 */
export function sizeMeterText(m: Pick<SizeMeter, "bytes" | "maxBytes" | "lines" | "recommendedLines">): string {
  return `${formatSize(m.bytes)} of ${formatSize(m.maxBytes)} · ${m.lines} ${m.lines === 1 ? "line" : "lines"} (about ${m.recommendedLines} recommended)`;
}

/** "4.6 KB", "25 KB", "812 B" (1 KB = 1024 bytes, as the service limit). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const unit = bytes < 1024 * 1024 ? 1024 : 1024 * 1024;
  const n = (bytes / unit).toFixed(1).replace(/\.0$/, "");
  return `${n} ${unit === 1024 ? "KB" : "MB"}`;
}

const BAR = { ok: "bg-success", warning: "bg-warning", error: "bg-destructive" } as const;
const TEXT = { ok: "text-muted-foreground", warning: "text-warning-fg", error: "text-destructive-fg" } as const;

export function SizeMeterLine({ meter, label = "Size", live = false, className }: { meter: SizeMeter; label?: string; live?: boolean; className?: string }) {
  const pct = Math.min(100, Math.max(0, Math.round(meter.fraction * 100)));
  return (
    <div className={cn("space-y-1.5 border-b px-4 py-2.5", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-[12.5px]">
        <span>{label}</span>
        <span className={cn("tabular-nums", TEXT[meter.level])} {...(live ? { role: "status", "aria-atomic": true } : {})}>
          {sizeMeterText(meter)}
          {meter.overLimit ? ". Above the limit: the service rejects a file this large." : meter.overRecommendedLines ? ". Longer than recommended." : ""}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className={cn("h-full rounded-full", BAR[meter.level])} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
