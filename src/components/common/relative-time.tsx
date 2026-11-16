"use client";

import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import { formatRelative, toDate } from "./time-format";

/** "12 min ago", refreshed every 30 s. Use only for freshness (sync, connection check), never for history rows. */
export function RelativeTime({ value, className }: { value: Date | string; className?: string }) {
  const now = useNow();
  const d = toDate(value);
  if (!d) return null;
  return (
    // Server and browser clocks differ by a few seconds, so the first client render may change the text.
    <time dateTime={d.toISOString()} className={cn("tabular-nums", className)} suppressHydrationWarning>
      {formatRelative(d, now)}
    </time>
  );
}
