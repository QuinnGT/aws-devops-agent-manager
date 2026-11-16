import { TRAILERS, type ChangeSource } from "@/lib/assets/types";

/**
 * Per-asset history: git commits for the asset directory, asset_changes rows
 * (change source and principal from attribution) and the live versions from
 * ListAssetVersions, merged into one timeline. Pure; unit-tested.
 *
 * Versions are matched on (version, updatedAt), because a metadata-only change
 * such as the Active switch keeps the version number and moves updatedAt.
 */

export interface HistoryCommit {
  hash: string;
  date: string;
  authorName: string;
  authorEmail: string;
  message: string;
  trailers: Record<string, string>;
}

export interface HistoryChangeRow {
  serviceVersion: number;
  serviceUpdatedAt: Date | string;
  changeKind: string;
  commit: string;
  changeSource: string;
  changeSourceLabel: string | null;
  principal: string | null;
  cloudTrailEventId: string | null;
  planId: string | null;
}

export interface LiveVersion {
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type HistoryState =
  /** In git, and the service still reports this version and timestamp */
  | "recorded"
  /** The service reports it, git doesn't have it yet */
  | "not-synced"
  /** In git; the service still has the version but a later in-place change moved its updatedAt */
  | "superseded-in-place"
  /** In git; the service no longer lists this version */
  | "not-held-by-service"
  /** The deletion of the asset */
  | "deleted";

export interface HistoryEntry {
  key: string;
  version: number | null;
  /** The version's updatedAt (ISO), or the commit date when no version is recorded */
  updatedAt: string | null;
  commit: HistoryCommit | null;
  /** Commit hash, from the commit or the asset_changes row */
  commitHash: string | null;
  changeKind: string | null;
  source: ChangeSource;
  sourceLabel: string;
  principal: string | null;
  cloudTrailEventId: string | null;
  planId: string | null;
  inGit: boolean;
  /** null when the live version list could not be read */
  inLive: boolean | null;
  state: HistoryState;
}

const SOURCES: readonly ChangeSource[] = ["app", "console", "cli", "agent", "unknown"];

export function isChangeSource(s: string | null | undefined): s is ChangeSource {
  return typeof s === "string" && (SOURCES as readonly string[]).includes(s);
}

function toIso(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  const t = d instanceof Date ? d.getTime() : Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function versionKey(version: number, updatedAt: Date | string): string {
  const iso = toIso(updatedAt);
  return `${version}@${iso ?? String(updatedAt)}`;
}

function intOrNull(s: string | undefined): number | null {
  if (s === undefined || !/^\d+$/.test(s.trim())) return null;
  return Number(s.trim());
}

export function resolveSource(
  change: Pick<HistoryChangeRow, "changeSource" | "changeSourceLabel"> | null,
  trailers: Record<string, string> | null,
  labels: Readonly<Record<ChangeSource, string>>,
): { source: ChangeSource; label: string } {
  if (change) {
    const source = isChangeSource(change.changeSource) ? change.changeSource : "unknown";
    return { source, label: change.changeSourceLabel ?? labels[source] };
  }
  const t = trailers?.[TRAILERS.changeSource];
  if (t) {
    if (isChangeSource(t)) return { source: t, label: labels[t] };
    // A label written in place of the source key: keep the text
    const byLabel = SOURCES.find((s) => labels[s] === t);
    return { source: byLabel ?? "unknown", label: t };
  }
  return { source: "unknown", label: labels.unknown };
}

export function mergeAssetHistory(input: {
  commits: readonly HistoryCommit[];
  changes: readonly HistoryChangeRow[];
  live: readonly LiveVersion[] | null;
  labels: Readonly<Record<ChangeSource, string>>;
}): HistoryEntry[] {
  const { commits, changes, live, labels } = input;
  const changeByCommit = new Map<string, HistoryChangeRow>();
  for (const c of changes) changeByCommit.set(c.commit, c);
  const commitByHash = new Map(commits.map((c) => [c.hash, c]));

  const recorded = new Map<string, HistoryEntry>();
  const addRecorded = (hash: string, commit: HistoryCommit | null, change: HistoryChangeRow | null) => {
    const version = change?.serviceVersion ?? intOrNull(commit?.trailers[TRAILERS.serviceVersion]);
    const updatedAt = toIso(change?.serviceUpdatedAt) ?? toIso(commit?.trailers[TRAILERS.serviceUpdatedAt]) ?? toIso(commit?.date);
    const key = version !== null && updatedAt ? versionKey(version, updatedAt) : `commit:${hash}`;
    const { source, label } = resolveSource(change, commit?.trailers ?? null, labels);
    const entry: HistoryEntry = {
      key,
      version,
      updatedAt,
      commit,
      commitHash: hash,
      changeKind: change?.changeKind ?? null,
      source,
      sourceLabel: label,
      principal: change?.principal ?? commit?.trailers[TRAILERS.principal] ?? null,
      cloudTrailEventId: change?.cloudTrailEventId ?? commit?.trailers[TRAILERS.cloudTrailEventId] ?? null,
      planId: change?.planId ?? commit?.trailers[TRAILERS.planId] ?? null,
      inGit: true,
      inLive: null,
      state: change?.changeKind === "deleted" ? "deleted" : "recorded",
    };
    // Two commits for the same version and timestamp (a re-sync): keep the newer commit
    const prev = recorded.get(key);
    if (!prev || (Date.parse(commit?.date ?? "") || 0) >= (Date.parse(prev.commit?.date ?? "") || 0)) {
      recorded.set(key, entry);
    }
  };

  for (const c of commits) addRecorded(c.hash, c, changeByCommit.get(c.hash) ?? null);
  for (const ch of changes) if (!commitByHash.has(ch.commit)) addRecorded(ch.commit, null, ch);

  const entries = [...recorded.values()];
  if (live) {
    const liveKeys = new Map(live.map((v) => [versionKey(v.version, v.updatedAt), v]));
    const liveVersions = new Set(live.map((v) => v.version));
    for (const e of entries) {
      if (e.state === "deleted") {
        e.inLive = false;
        continue;
      }
      if (e.version === null) continue;
      if (liveKeys.has(e.key)) {
        e.inLive = true;
        liveKeys.delete(e.key);
      } else {
        e.inLive = false;
        e.state = liveVersions.has(e.version) ? "superseded-in-place" : "not-held-by-service";
      }
    }
    for (const [key, v] of liveKeys) {
      entries.push({
        key,
        version: v.version,
        updatedAt: toIso(v.updatedAt),
        commit: null,
        commitHash: null,
        changeKind: null,
        source: "unknown",
        sourceLabel: "Not synced yet",
        principal: null,
        cloudTrailEventId: null,
        planId: null,
        inGit: false,
        inLive: true,
        state: "not-synced",
      });
    }
  }

  return entries.sort((a, b) => {
    const ta = Date.parse(a.updatedAt ?? "") || 0;
    const tb = Date.parse(b.updatedAt ?? "") || 0;
    return tb - ta || (b.version ?? -1) - (a.version ?? -1);
  });
}

export function describeHistoryState(s: HistoryState): string {
  switch (s) {
    case "recorded":
      return "Recorded";
    case "not-synced":
      return "Not synced yet";
    case "superseded-in-place":
      return "Timestamp later overwritten in the space";
    case "not-held-by-service":
      return "No longer listed by the space";
    case "deleted":
      return "Deleted";
  }
}
