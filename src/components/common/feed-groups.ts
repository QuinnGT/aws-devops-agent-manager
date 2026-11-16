import type { ChangeKind, FeedItem } from "@/lib/assets/types";
import { displayPrincipal } from "./source-labels";
import { dayKey } from "./time-format";

/**
 * Change feed grouping and day headers (design-system pages/space-home.md,
 * "Recent changes"). Pure; the server ChangeFeed renders the result.
 */

export interface FeedTerms {
  /** Asset type label from policy ("Memory", "Instructions (AGENTS.md)") */
  typeLabel: (assetType: string) => string;
  /** Count noun from policy ("memory" / "memories") */
  noun: (assetType: string, count: number) => string;
}

export interface FeedSingle {
  kind: "single";
  key: string;
  item: FeedItem;
}

export interface FeedGroup {
  kind: "group";
  key: string;
  items: FeedItem[];
  title: string;
  detail: string;
}

export type FeedEntry = FeedSingle | FeedGroup;

export interface FeedDay {
  /** YYYY-MM-DD in the viewer's zone */
  day: string;
  /** An instant on that day, for the day header */
  at: string;
  entries: FeedEntry[];
}

export interface BuildFeedOptions {
  timeZone: string;
  terms: FeedTerms;
  /** Rows or groups to show; the rest is cut and `truncated` is set */
  limit?: number;
  minGroupSize?: number;
  windowMinutes?: number;
}

const PAST: Record<ChangeKind, string> = {
  created: "created",
  content: "updated",
  metadata: "changed",
  deleted: "deleted",
  baseline: "recorded",
};

/** What happened, as the detail line says it. */
export function whatHappened(item: Pick<FeedItem, "kind" | "version">): string {
  switch (item.kind) {
    case "created":
      return "created";
    case "content":
      return "content updated";
    case "metadata":
      return "status or metadata changed, version unchanged";
    case "deleted":
      return "deleted";
    case "baseline":
      return `first recorded at v${item.version}`;
  }
}

/** Same source, same parent (or, without a parent, same asset type). */
function groupKey(i: FeedItem): string {
  return `${i.source}|${i.parentAssetId ? `p:${i.parentAssetId}` : i.parentName ? `n:${i.parentName}` : `t:${i.assetType}`}`;
}

export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/**
 * One title pattern for every group, "<N> changes in <parent>" (or "<N>
 * changes to <type plural>" without a parent); the detail line says what
 * happened ("3 updated, 2 created") and names the assets. A group has no
 * version badge: only a single change has one version.
 */
export function describeGroup(items: readonly FeedItem[], terms: FeedTerms): Pick<FeedGroup, "title" | "detail"> {
  const first = items[0]!;
  const n = items.length;
  const parent = first.parentName;
  const title = parent ? `${n} changes in ${parent}` : `${n} changes to ${terms.noun(first.assetType, 2)}`;
  const kinds = (Object.keys(PAST) as ChangeKind[])
    .map((k) => [k, items.filter((i) => i.kind === k).length] as const)
    .filter(([, c]) => c > 0)
    .map(([k, c]) => `${c} ${PAST[k]}`);
  const names = [...new Set(items.map((i) => i.name))];
  return { title, detail: `${kinds.join(", ")}: ${listNames(names)}` };
}

/**
 * Newest first in, day sections out. Groups runs of `minGroupSize` or more
 * consecutive changes that share a group key, fall on the same day and lie
 * within `windowMinutes` of the run's first change.
 */
export function buildFeed(items: readonly FeedItem[], o: BuildFeedOptions): { days: FeedDay[]; truncated: boolean } {
  const limit = o.limit ?? Number.POSITIVE_INFINITY;
  const minGroup = o.minGroupSize ?? 3;
  const windowMs = (o.windowMinutes ?? 15) * 60_000;
  const entries: { day: string; at: string; entry: FeedEntry }[] = [];

  let i = 0;
  while (i < items.length) {
    const first = items[i]!;
    const day = dayKey(first.at, o.timeZone);
    const key = groupKey(first);
    const t0 = Date.parse(first.at);
    let j = i + 1;
    while (j < items.length) {
      const next = items[j]!;
      if (groupKey(next) !== key || dayKey(next.at, o.timeZone) !== day || Math.abs(t0 - Date.parse(next.at)) > windowMs) break;
      j++;
    }
    if (j - i >= minGroup) {
      const run = items.slice(i, j);
      entries.push({ day, at: first.at, entry: { kind: "group", key: `g:${first.commit}:${first.assetId}`, items: run, ...describeGroup(run, o.terms) } });
      i = j;
    } else {
      entries.push({ day, at: first.at, entry: { kind: "single", key: `${first.commit}:${first.assetId}`, item: first } });
      i++;
    }
  }

  const shown = entries.slice(0, limit);
  const days: FeedDay[] = [];
  for (const e of shown) {
    const last = days[days.length - 1];
    if (last && last.day === e.day) last.entries.push(e.entry);
    else days.push({ day: e.day, at: e.at, entries: [e.entry] });
  }
  return { days, truncated: entries.length > shown.length };
}

/** The detail line under a row's title. `longLabel` is the long source label. */
export function describeChange(item: FeedItem, terms: Pick<FeedTerms, "typeLabel">, longLabel: string): string {
  const where = item.parentName ? `${terms.typeLabel(item.assetType)} in ${item.parentName}` : terms.typeLabel(item.assetType);
  const what = whatHappened(item);
  const who = item.principal ? displayPrincipal(item.principal) : null;
  let how: string;
  switch (item.source) {
    case "agent":
      how = `${what} by the ${longLabel}`;
      break;
    case "console":
    case "cli": {
      const by = who ? ` by ${who}` : "";
      how = `${what}${by} ${item.source === "console" ? "in" : "with"} the ${longLabel}`;
      break;
    }
    case "app":
      how = who ? `${what} by ${who} in this app` : `${what} in this app`;
      break;
    case "unknown":
      how = what;
      break;
  }
  // The reason goes last, so a long reason never pushes who made the change out of the two-line detail.
  const parts = [where, how];
  if (item.reason) parts.push(`Reason: ${item.reason}`);
  return parts.join(" · ");
}
