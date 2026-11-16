import type { ChangeSource } from "@/lib/assets/types";
import type { HistoryEntry } from "./history";

/**
 * Version helpers for the asset page (design-system pages/asset-detail.md):
 * tabs in the URL, the version strip, compare references, the cadence line
 * and the short asset ID. Pure; unit-tested.
 */

export const ASSET_TABS = ["content", "versions", "metadata", "files"] as const;
export type AssetTab = (typeof ASSET_TABS)[number];

export function parseAssetTab(v: string | undefined): AssetTab {
  return (ASSET_TABS as readonly string[]).includes(v ?? "") ? (v as AssetTab) : "content";
}

/** The strip is shown up to this many versions; the table is always shown. */
export const VERSION_STRIP_MAX = 60;

/** Versions in the summary card on the Content tab. */
export const SUMMARY_VERSIONS = 4;

/** One source must make at least this many versions for the cadence line. */
export const CADENCE_MIN_VERSIONS = 5;

export interface VersionPoint {
  version: number;
  source: ChangeSource;
  sourceLabel: string;
  principal: string | null;
  /** The version's updatedAt (ISO) */
  at: string | null;
  commit: string;
  changeKind: string | null;
}

type Recorded<E extends HistoryEntry> = E & { version: number; commitHash: string };

function recorded<E extends HistoryEntry>(e: E): e is Recorded<E> {
  return e.inGit && e.version !== null && e.commitHash !== null && e.state !== "deleted";
}

/**
 * One point per recorded version number, oldest first. A version changed in
 * place (the Active switch keeps the number) is represented by its newest
 * entry, the same state a rollback to that version restores.
 */
export function versionPoints(entries: readonly HistoryEntry[]): VersionPoint[] {
  const byVersion = new Map<number, Recorded<HistoryEntry>>();
  for (const e of entries) {
    if (!recorded(e)) continue;
    const prev = byVersion.get(e.version);
    if (!prev || (Date.parse(e.updatedAt ?? "") || 0) > (Date.parse(prev.updatedAt ?? "") || 0)) byVersion.set(e.version, e);
  }
  return [...byVersion.values()]
    .sort((a, b) => a.version - b.version)
    .map((e) => ({ version: e.version, source: e.source, sourceLabel: e.sourceLabel, principal: e.principal, at: e.updatedAt, commit: e.commitHash, changeKind: e.changeKind }));
}

const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * A compare reference from the URL: a version number ("23", its newest
 * recorded entry) or a commit hash of one of the asset's own entries.
 */
export function resolveVersionRef<E extends HistoryEntry>(entries: readonly E[], ref: string | undefined): Recorded<E> | null {
  const r = ref?.trim().toLowerCase() ?? "";
  if (/^\d{1,9}$/.test(r)) {
    const version = Number(r);
    const point = versionPoints(entries).find((p) => p.version === version);
    return point ? (entries.find((e): e is Recorded<E> => recorded(e) && e.commitHash === point.commit) ?? null) : null;
  }
  if (COMMIT_RE.test(r)) return entries.find((e): e is Recorded<E> => recorded(e) && e.commitHash === r) ?? null;
  return null;
}

/** The URL reference for an entry: its version number when it is that version's newest entry, else its commit. */
export function versionRef(entries: readonly HistoryEntry[], e: Pick<HistoryEntry, "version" | "commitHash">): string | null {
  if (!e.commitHash) return null;
  if (e.version === null) return e.commitHash;
  const point = versionPoints(entries).find((p) => p.version === e.version);
  return point?.commit === e.commitHash ? String(e.version) : e.commitHash;
}

/** The recorded entry before `e` (entries are newest first), skipping the deletion row. */
export function previousEntry<E extends HistoryEntry>(entries: readonly E[], e: Pick<HistoryEntry, "commitHash">): Recorded<E> | null {
  const list = entries.filter((x): x is Recorded<E> => recorded(x));
  const i = list.findIndex((x) => x.commitHash === e.commitHash);
  return i >= 0 ? (list[i + 1] ?? null) : null;
}

/**
 * The version a row's "Restore this version" restores, or null when the row
 * offers none: only the newest entry of each recorded version (the state a
 * restore writes), and not the current version unless the asset was deleted.
 */
export function restorableVersion(entries: readonly HistoryEntry[], e: Pick<HistoryEntry, "version" | "commitHash">, opts: { deleted: boolean }): number | null {
  if (e.version === null || !e.commitHash) return null;
  const points = versionPoints(entries);
  if (points.find((p) => p.version === e.version)?.commit !== e.commitHash) return null;
  if (!opts.deleted && points.at(-1)?.version === e.version) return null;
  return e.version;
}

/** Older first: swap when the URL names them the other way round. */
export function orderPair<T extends { version: number; updatedAt: string | null }>(a: T, b: T): [T, T] {
  const ta = Date.parse(a.updatedAt ?? "") || 0;
  const tb = Date.parse(b.updatedAt ?? "") || 0;
  return a.version > b.version || (a.version === b.version && ta > tb) ? [b, a] : [a, b];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface Cadence {
  source: ChangeSource;
  count: number;
  /** Median time between that source's versions, in milliseconds */
  medianMs: number;
}

/** The known source that made the most versions, when it made at least `min` of them. Unknown is not a source to name. */
export function versionCadence(points: readonly VersionPoint[], min = CADENCE_MIN_VERSIONS): Cadence | null {
  const bySource = new Map<ChangeSource, number[]>();
  for (const p of points) {
    if (p.source === "unknown") continue;
    const t = Date.parse(p.at ?? "");
    if (!Number.isFinite(t)) continue;
    bySource.set(p.source, [...(bySource.get(p.source) ?? []), t]);
  }
  let best: { source: ChangeSource; times: number[] } | null = null;
  for (const [source, times] of bySource) if (!best || times.length > best.times.length) best = { source, times };
  if (!best || best.times.length < min) return null;
  const times = [...best.times].sort((a, b) => a - b);
  const gaps = times.slice(1).map((t, i) => t - times[i]!);
  return { source: best.source, count: times.length, medianMs: median(gaps) };
}

/** "4 days", "6 hours", "20 minutes": the interval in the cadence line. */
export function describeInterval(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 90) return minutes === 1 ? "minute" : `${minutes} minutes`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 20) return hours === 1 ? "hour" : `${hours} hours`;
  const days = Math.round(ms / 86_400_000);
  return days === 1 ? "day" : `${days} days`;
}

/** Version numbers labeled under the strip: the first, every fifth, the last, and the selected ones. */
export function stripLabels(points: readonly Pick<VersionPoint, "version">[], selected: readonly number[] = []): Set<number> {
  const out = new Set<number>();
  const first = points[0]?.version;
  const last = points.at(-1)?.version;
  for (const p of points) if (p.version === first || p.version === last || p.version % 5 === 0 || selected.includes(p.version)) out.add(p.version);
  return out;
}

/** "ki-9184fa09" for "ki-9184fa09-8e79-...": the prefix and first group. */
export function shortAssetId(id: string): string {
  const m = /^([a-z]+-[0-9a-f]{8})-/i.exec(id);
  return m ? m[1]! : id.length > 14 ? id.slice(0, 12) : id;
}

/** Words for a change kind in the version table. */
export function changeKindLabel(kind: string | null): string {
  switch (kind) {
    case "created":
      return "Created";
    case "baseline":
      return "First recorded";
    case "content":
      return "Content updated";
    case "metadata":
      return "Status or metadata";
    case "deleted":
      return "Deleted";
    default:
      return "Recorded";
  }
}
