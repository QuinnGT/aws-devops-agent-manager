import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatTime, formatUtcExact, toDate, type TimeFormat } from "./time-format";
import { getViewerZone } from "./viewer-zone";

/**
 * A point in time in the viewer's time zone (server component). The tooltip
 * shows the exact UTC time. In client components use `formatTime` from
 * ./time-format with a zone passed down from the server.
 */
export async function Time({ value, format, className }: { value: Date | string; format: TimeFormat; className?: string }) {
  const d = toDate(value);
  if (!d) return null;
  const zone = await getViewerZone();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={d.toISOString()} className={cn("tabular-nums", className)}>
          {formatTime(d, format, zone)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{formatUtcExact(d)}</TooltipContent>
    </Tooltip>
  );
}
