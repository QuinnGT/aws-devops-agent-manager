/**
 * Time formatting for the UI (design-system MASTER "Time zone"). Pure, so the
 * server component `Time`, the client `RelativeTime` and `SyncStatus` all
 * read the same way. Formats in the viewer's time zone; with no known zone,
 * UTC with "UTC" appended to the text.
 */

export type TimeFormat = "time" | "date" | "datetime" | "day";

export interface ViewerZone {
  timeZone: string;
  /** True when the viewer's zone is unknown and UTC is used instead */
  fallback: boolean;
}

export const UTC_ZONE: ViewerZone = { timeZone: "UTC", fallback: true };

/** The `tz` cookie value when it names a time zone this runtime knows, else UTC (fallback). */
export function resolveTimeZone(value: string | null | undefined): ViewerZone {
  if (!value || value.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) return UTC_ZONE;
  try {
    const timeZone = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
    return { timeZone, fallback: false };
  } catch {
    return UTC_ZONE;
  }
}

export function toDate(value: Date | string | number): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parts(d: Date, timeZone: string): { year: string; month: string; day: string } {
  const p = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** Calendar day of an instant in a zone, as YYYY-MM-DD (for grouping and "today"). */
export function dayKey(value: Date | string, timeZone: string): string {
  const d = toDate(value);
  if (!d) return "";
  const { year, month, day } = parts(d, timeZone);
  return `${year}-${month}-${day}`;
}

const fmt = (timeZone: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone, ...o });

/**
 * - time: "3:38 PM"
 * - date: "Nov 10" this year, "Nov 10, 2025" otherwise
 * - datetime: "3:38 PM" today, "Nov 10, 3:38 PM" this year, "Nov 10, 2025" otherwise
 * - day: "Monday, Nov 10" this year, "Monday, Nov 10, 2025" otherwise
 */
export function formatTime(value: Date | string, format: TimeFormat, zone: ViewerZone, now: Date = new Date()): string {
  const d = toDate(value);
  if (!d) return "";
  const tz = zone.timeZone;
  const sameYear = parts(d, tz).year === parts(now, tz).year;
  const clock = fmt(tz, { hour: "numeric", minute: "2-digit" }).format(d);
  let text: string;
  switch (format) {
    case "time":
      text = clock;
      break;
    case "date":
      text = fmt(tz, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" }).format(d);
      break;
    case "datetime":
      if (dayKey(d, tz) === dayKey(now, tz)) text = clock;
      else if (sameYear) text = `${fmt(tz, { month: "short", day: "numeric" }).format(d)}, ${clock}`;
      else text = fmt(tz, { month: "short", day: "numeric", year: "numeric" }).format(d);
      break;
    case "day":
      text = fmt(tz, sameYear ? { weekday: "long", month: "short", day: "numeric" } : { weekday: "long", month: "short", day: "numeric", year: "numeric" }).format(d);
      break;
  }
  // Day headers name a day, not a time; every other format says when UTC stands in for the viewer's zone.
  return zone.fallback && format !== "day" && format !== "date" ? `${text} UTC` : text;
}

/** Exact UTC for tooltips: "2026-11-10 23:38:13 UTC". */
export function formatUtcExact(value: Date | string): string {
  const d = toDate(value);
  return d ? `${d.toISOString().slice(0, 19).replace("T", " ")} UTC` : "";
}

/** "just now", "12 min ago", "2 h ago", "3 days ago". Freshness only, never history rows. */
export function formatRelative(value: Date | string, now: Date = new Date()): string {
  const d = toDate(value);
  if (!d) return "";
  const minutes = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

/** The instant `days` days before `now`. */
export function daysAgo(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * 86_400_000);
}
