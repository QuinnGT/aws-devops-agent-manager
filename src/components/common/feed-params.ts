import { CHANGE_SOURCES, type ChangeSource } from "@/lib/assets/types";

/**
 * Change feed filter state in URL search params, shared by Home and History
 * so "Show older changes" carries the filters over. Pure.
 *
 *   source  comma-separated change sources, e.g. agent,console
 *   type    comma-separated asset types, e.g. memory,skill
 *   range   7d | 30d | 90d | all
 *   q       asset name contains
 */

export const FEED_RANGES = [
  { value: "7d", label: "Last 7 days", days: 7 },
  { value: "30d", label: "Last 30 days", days: 30 },
  { value: "90d", label: "Last 90 days", days: 90 },
  { value: "all", label: "All time", days: null },
] as const;

export type FeedRange = (typeof FEED_RANGES)[number]["value"];

export interface FeedFilterState {
  sources: ChangeSource[];
  types: string[];
  range: FeedRange;
  q: string;
}

export const FEED_PARAM_KEYS = ["source", "type", "range", "q"] as const;

type Params = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

function list(v: string | string[] | undefined): string[] {
  return [...new Set(first(v).split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 20);
}

export function parseFeedFilters(sp: Params, defaults: { range: FeedRange } = { range: "all" }): FeedFilterState {
  const range = FEED_RANGES.find((r) => r.value === first(sp.range))?.value ?? defaults.range;
  return {
    sources: list(sp.source).filter((s): s is ChangeSource => (CHANGE_SOURCES as readonly string[]).includes(s)),
    types: list(sp.type).filter((t) => /^[a-z][a-z0-9_]{0,63}$/.test(t)),
    range,
    q: first(sp.q).trim().slice(0, 200),
  };
}

/** Lower bound for the range, or undefined for all time. */
export function feedSince(range: FeedRange, now: Date = new Date()): Date | undefined {
  const days = FEED_RANGES.find((r) => r.value === range)?.days ?? null;
  return days === null ? undefined : new Date(now.getTime() - days * 86_400_000);
}

/** Query string (without "?") for the filters, e.g. for "Show older changes". */
export function feedFilterQuery(f: FeedFilterState): string {
  const q = new URLSearchParams();
  if (f.sources.length) q.set("source", f.sources.join(","));
  if (f.types.length) q.set("type", f.types.join(","));
  q.set("range", f.range);
  if (f.q) q.set("q", f.q);
  return q.toString();
}
