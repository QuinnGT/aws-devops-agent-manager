/**
 * Compare the committed state of an asset (asset.json at HEAD) with the live
 * asset from GetAsset. Pure; unit-tested.
 */

export interface CommittedState {
  serviceVersion: number;
  serviceUpdatedAt: string;
  metadata: Record<string, unknown>;
}

export interface LiveState {
  version: number;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export type LiveRead = { ok: true; asset: LiveState } | { ok: false; notFound: boolean; error: string };

export type SyncStatus =
  | { kind: "in-sync"; version: number }
  | { kind: "live-newer"; committedVersion: number; liveVersion: number }
  | { kind: "metadata-changed"; version: number; committedUpdatedAt: string; liveUpdatedAt: string }
  | { kind: "committed-newer"; committedVersion: number; liveVersion: number }
  | { kind: "not-committed"; liveVersion: number | null }
  | { kind: "live-missing"; committedVersion: number | null }
  | { kind: "live-unavailable"; error: string };

/** JSON with sorted keys, so key order never counts as a difference. */
export function stableStringify(v: unknown): string {
  if (v === undefined) return "undefined";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x)}`).join(",")}}`;
}

function sameInstant(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) ? ta === tb : a === b;
}

export function compareCommittedToLive(committed: CommittedState | null, live: LiveRead): SyncStatus {
  if (!live.ok) {
    if (live.notFound) return { kind: "live-missing", committedVersion: committed?.serviceVersion ?? null };
    return { kind: "live-unavailable", error: live.error };
  }
  const l = live.asset;
  if (!committed) return { kind: "not-committed", liveVersion: l.version };
  if (l.version > committed.serviceVersion) {
    return { kind: "live-newer", committedVersion: committed.serviceVersion, liveVersion: l.version };
  }
  if (l.version < committed.serviceVersion) {
    return { kind: "committed-newer", committedVersion: committed.serviceVersion, liveVersion: l.version };
  }
  if (!sameInstant(l.updatedAt, committed.serviceUpdatedAt) || stableStringify(l.metadata) !== stableStringify(committed.metadata)) {
    return { kind: "metadata-changed", version: l.version, committedUpdatedAt: committed.serviceUpdatedAt, liveUpdatedAt: l.updatedAt };
  }
  return { kind: "in-sync", version: l.version };
}

/** One-line description for the UI. */
export function describeSyncStatus(s: SyncStatus): { tone: "ok" | "warn" | "error" | "muted"; text: string } {
  switch (s.kind) {
    case "in-sync":
      return { tone: "ok", text: `In sync: git holds live version ${s.version}.` };
    case "live-newer":
      return { tone: "warn", text: `Out of sync: the space has version ${s.liveVersion}, git has version ${s.committedVersion}. The next sync records it.` };
    case "metadata-changed":
      return {
        tone: "warn",
        text: `Out of sync: version ${s.version} changed in place (metadata or status) after it was committed. The next sync records it.`,
      };
    case "committed-newer":
      return { tone: "error", text: `Git has version ${s.committedVersion}, but the space reports version ${s.liveVersion}. Check the asset in the space.` };
    case "not-committed":
      return { tone: "warn", text: "This asset is not in git yet. The next sync records it." };
    case "live-missing":
      return { tone: "error", text: "The space no longer has this asset. The daily reconcile records the deletion." };
    case "live-unavailable":
      return { tone: "muted", text: `Could not read the live asset: ${s.error}` };
  }
}
