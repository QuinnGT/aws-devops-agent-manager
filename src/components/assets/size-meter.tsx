import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { formatBytes, type SizeMeter } from "@/server/assets/size-meter";
import { cn } from "@/lib/utils";

/**
 * Instruction file size against the service limit and lines against the
 * recommended length, both from policy limits. Tones: success under the
 * recommended lines, warning above, destructive over the limit.
 */
export function SizeMeterView({ meter }: { meter: SizeMeter }) {
  const pct = Math.min(100, Math.round(meter.fraction * 100));
  const tone = meter.overLimit ? "destructive" : meter.overRecommendedLines ? "warning" : "success";
  const Icon = tone === "destructive" ? CircleX : tone === "warning" ? TriangleAlert : CircleCheck;
  return (
    <div className="space-y-1.5">
      <Progress
        value={pct}
        aria-label={`Size: ${pct}% of the ${formatBytes(meter.maxBytes)} limit`}
        className={cn(tone === "destructive" && "[&>div]:bg-destructive", tone === "warning" && "[&>div]:bg-warning", tone === "success" && "[&>div]:bg-success")}
      />
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground tabular-nums">
        <Icon className={cn("size-3.5", tone === "destructive" ? "text-destructive-fg" : tone === "warning" ? "text-warning-fg" : "text-success-fg")} aria-hidden />
        {formatBytes(meter.bytes)} of {formatBytes(meter.maxBytes)} ({pct}%) · {meter.lines} of {meter.recommendedLines} recommended lines
      </p>
      {meter.overLimit ? <p className="text-xs text-destructive-fg">Above the {formatBytes(meter.maxBytes)} limit. The service rejects a file this large.</p> : null}
      {meter.overRecommendedLines ? <p className="text-xs text-warning-fg">Longer than the recommended {meter.recommendedLines} lines. Consider moving detail into skills.</p> : null}
    </div>
  );
}
