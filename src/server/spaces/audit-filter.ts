import { z } from "zod";

/**
 * Audit log filters from the page's query string or the export URL. Pure, so
 * the page, the export route and the tests read them the same way. List
 * filters are comma-separated (`action=space.update,space.register`).
 */

export const AUDIT_RESULTS = ["ok", "error", "denied"] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

function first(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

function blankToUndefined(v: unknown): unknown {
  v = first(v);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** "a,b" (or repeated params) becomes ["a", "b"]; blank becomes undefined. */
function commaList(v: unknown): unknown {
  const values = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");
  const items = [...new Set(values.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean))];
  return items.length ? items : undefined;
}

const day = z.preprocess(blankToUndefined, z.iso.date("Use a date like 2026-11-11.").optional());

export const auditFilterSchema = z.object({
  space: z.preprocess(commaList, z.array(z.uuid()).max(100).optional()),
  action: z.preprocess(commaList, z.array(z.string().max(100)).max(100).optional()),
  actor: z.preprocess(blankToUndefined, z.string().max(200).optional()),
  /** Matches the target type, the target ID, the space alias, or the name, title, alias or subject in the details */
  target: z.preprocess(blankToUndefined, z.string().max(200).optional()),
  result: z.preprocess(commaList, z.array(z.enum(AUDIT_RESULTS)).optional()),
  /** Calendar days in the viewer's time zone, inclusive */
  from: day,
  to: day,
  /** Keyset cursor: only events with a smaller id */
  before: z.preprocess(blankToUndefined, z.coerce.number().int().positive().optional()),
});

export type AuditFilter = z.output<typeof auditFilterSchema>;

/** URL query keys the audit log page and export share, in display order. */
export const AUDIT_FILTER_KEYS = ["space", "action", "actor", "target", "result", "from", "to"] as const;

/** The filter as a query string ("?a=b", or "" when empty), plus extra params. */
export function auditFilterQuery(filter: AuditFilter, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  for (const k of AUDIT_FILTER_KEYS) {
    const v = filter[k];
    if (Array.isArray(v) ? v.length : v) p.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function hasAuditFilters(filter: AuditFilter): boolean {
  return auditFilterQuery(filter) !== "";
}

/** Milliseconds the zone is ahead of UTC at `instant`. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - Math.floor(instant / 1000) * 1000;
}

/** The instant a calendar day (YYYY-MM-DD) starts in a time zone. `addDays` moves the day first. */
export function zonedDayStart(day: string, timeZone: string, addDays = 0): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d + addDays);
  // Two passes settle the offset on days when the zone changes it (daylight saving time).
  const guess = wall - zoneOffsetMs(wall, timeZone);
  return new Date(wall - zoneOffsetMs(guess, timeZone));
}

/** Page size for "Show more" on the audit log page. */
export const AUDIT_PAGE_SIZE = 50;
/** Most rows the page shows; the export has every event. */
export const AUDIT_MAX_ROWS = 1000;

/** How many rows to show, from the `show` param: a multiple of the page size, at most AUDIT_MAX_ROWS. */
export function auditShowCount(raw: unknown): number {
  const n = Number(first(raw));
  if (!Number.isFinite(n) || n < AUDIT_PAGE_SIZE) return AUDIT_PAGE_SIZE;
  return Math.min(AUDIT_MAX_ROWS, Math.ceil(n / AUDIT_PAGE_SIZE) * AUDIT_PAGE_SIZE);
}
