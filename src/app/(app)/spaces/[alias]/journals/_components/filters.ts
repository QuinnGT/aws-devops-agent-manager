/**
 * Filter state for the investigations list (and the analysis list) in URL
 * search params, so links and Back keep it. Pure.
 *
 *   q         task ID, incident ID or title contains
 *   status    comma-separated task statuses, e.g. COMPLETED,FAILED
 *   taskType  comma-separated task types, e.g. SYSTEM_LEARNING
 *   source    comma-separated: api, import
 *   from, to  created on or after / on or before, as YYYY-MM-DD in the viewer's time zone
 *   page      1-based page number
 */

export const JOURNAL_SOURCES = ["api", "import"] as const;
export type JournalSource = (typeof JOURNAL_SOURCES)[number];

export interface InvestigationFilterState {
  q: string;
  statuses: string[];
  taskTypes: string[];
  sources: JournalSource[];
  from: string | null;
  to: string | null;
  page: number;
}

export const EMPTY_FILTERS: InvestigationFilterState = { q: "", statuses: [], taskTypes: [], sources: [], from: null, to: null, page: 1 };

type Params = Record<string, string | string[] | undefined>;

const ENUM = /^[A-Z][A-Z0-9_]{0,63}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

function list(v: string | string[] | undefined): string[] {
  return [
    ...new Set(
      first(v)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].slice(0, 20);
}

/** A real calendar day as YYYY-MM-DD, or null. */
export function validDay(v: string | null | undefined): string | null {
  const m = DAY.exec(v?.trim() ?? "");
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? m[0] : null;
}

export function parseInvestigationFilters(sp: Params): InvestigationFilterState {
  const page = Number.parseInt(first(sp.page), 10);
  return {
    q: first(sp.q).trim().slice(0, 200),
    statuses: list(sp.status).filter((s) => ENUM.test(s)),
    taskTypes: list(sp.taskType).filter((s) => ENUM.test(s)),
    sources: list(sp.source).filter((s): s is JournalSource => (JOURNAL_SOURCES as readonly string[]).includes(s)),
    from: validDay(first(sp.from)),
    to: validDay(first(sp.to)),
    page: Number.isFinite(page) && page >= 1 && page <= 100_000 ? page : 1,
  };
}

/** True when any filter (not the page) is set. */
export function isFiltered(f: InvestigationFilterState): boolean {
  return !!(f.q || f.statuses.length || f.taskTypes.length || f.sources.length || f.from || f.to);
}

/** Query string (without "?") for the state; empty values are left out. */
export function filterQuery(f: InvestigationFilterState): string {
  const q = new URLSearchParams();
  if (f.q) q.set("q", f.q);
  if (f.statuses.length) q.set("status", f.statuses.join(","));
  if (f.taskTypes.length) q.set("taskType", f.taskTypes.join(","));
  if (f.sources.length) q.set("source", f.sources.join(","));
  if (f.from) q.set("from", f.from);
  if (f.to) q.set("to", f.to);
  if (f.page > 1) q.set("page", String(f.page));
  return q.toString();
}

/** Link to `base` with the state changed by `patch`. A filter change goes back to page 1. */
export function filterHref(base: string, f: InvestigationFilterState, patch: Partial<InvestigationFilterState> = {}): string {
  const next = { ...f, ...patch, page: patch.page ?? 1 };
  const qs = filterQuery(next);
  return qs ? `${base}?${qs}` : base;
}

/** Offset of `timeZone` from UTC at instant `t`, in milliseconds. */
function zoneOffsetMs(t: number, timeZone: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(p.find((x) => x.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** The instant the calendar day `day` (YYYY-MM-DD) starts in `timeZone`. */
export function zonedDayStart(day: string, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - zoneOffsetMs(guess, timeZone);
  // Across a DST change the offset at the result can differ from the offset at the guess.
  const second = guess - zoneOffsetMs(first, timeZone);
  return new Date(second);
}

/** The day after `day`, as YYYY-MM-DD. */
export function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Created range for the query: `from` inclusive, `to` through the end of that day, both in the viewer's zone. */
export function createdRange(f: Pick<InvestigationFilterState, "from" | "to">, timeZone: string): { createdFrom?: Date; createdBefore?: Date } {
  const out: { createdFrom?: Date; createdBefore?: Date } = {};
  if (f.from) out.createdFrom = zonedDayStart(f.from, timeZone);
  if (f.to) out.createdBefore = zonedDayStart(nextDay(f.to), timeZone);
  return out;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 1" this year, "Oct 1, 2025" otherwise (MASTER "Time zone" date format). */
export function formatDay(day: string, now: Date = new Date()): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const text = `${MONTHS[m - 1]} ${d}`;
  return y === now.getUTCFullYear() ? text : `${text}, ${y}`;
}

/** Toolbar label for the created range. */
export function createdLabel(from: string | null, to: string | null, now: Date = new Date()): string {
  if (from && to) return from === to ? `Created: ${formatDay(from, now)}` : `Created: ${formatDay(from, now)} to ${formatDay(to, now)}`;
  if (from) return `Created: from ${formatDay(from, now)}`;
  if (to) return `Created: until ${formatDay(to, now)}`;
  return "Created: Any time";
}
