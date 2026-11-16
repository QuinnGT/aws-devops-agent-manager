import type { StoreCommitPolicy } from "@/server/policy/sections/sync";

/**
 * Pure change detection and ordering. A change is a new service version, or a new updatedAt on a
 * version already recorded (a metadata-only update such as the Active switch,
 * which changes the current version in place).
 */

export interface LiveVersion {
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export type ChangeKind = "created" | "baseline" | "content" | "metadata";

export interface CandidateChange {
  assetId: string;
  assetType: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  /** True for a version newer than the last recorded one; false for an in-place metadata change */
  newVersion: boolean;
}

export interface PlannedChange extends CandidateChange {
  kind: ChangeKind;
}

export interface RecordedState {
  /** Last committed version, or null when nothing of this asset is in git yet */
  lastSyncedVersion: number | null;
  lastSyncedUpdatedAt: Date | null;
  /** Latest recorded updatedAt per committed version */
  recorded: ReadonlyMap<number, Date>;
  /** The asset was marked deleted and is live again: re-add its current version */
  reappeared?: boolean;
}

/** Every change in `versions` that is not in git yet, oldest version first. */
export function detectChanges(asset: { assetId: string; assetType: string }, versions: readonly LiveVersion[], state: RecordedState): CandidateChange[] {
  const sorted = [...versions].sort((a, b) => a.version - b.version || a.updatedAt.getTime() - b.updatedAt.getTime());
  const recorded = new Map(state.recorded);
  if (state.lastSyncedVersion !== null && state.lastSyncedUpdatedAt) {
    const r = recorded.get(state.lastSyncedVersion);
    if (!r || r < state.lastSyncedUpdatedAt) recorded.set(state.lastSyncedVersion, state.lastSyncedUpdatedAt);
  }
  const out: CandidateChange[] = [];
  for (const v of sorted) {
    const base = { assetId: asset.assetId, assetType: asset.assetType, version: v.version, createdAt: v.createdAt, updatedAt: v.updatedAt };
    if (state.lastSyncedVersion === null || v.version > state.lastSyncedVersion) {
      out.push({ ...base, newVersion: true });
      continue;
    }
    const rec = recorded.get(v.version);
    if (rec && v.updatedAt.getTime() > rec.getTime()) out.push({ ...base, newVersion: false });
  }
  if (state.reappeared && out.length === 0) {
    const latest = sorted.at(-1);
    if (latest) out.push({ assetId: asset.assetId, assetType: asset.assetType, ...latest, newVersion: true });
  }
  return out;
}

/** Start of the UTC day containing `d`, as epoch milliseconds. */
export function utcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Apply a store commit policy to one asset's candidate changes.
 * - every-version: all changes.
 * - ignore: none.
 * - daily: the last change of each UTC day, only for days that are over;
 *   changes from the current UTC day are deferred to a later sync.
 */
export function applyCommitPolicy<T extends CandidateChange>(changes: readonly T[], policy: StoreCommitPolicy, now: Date): { commit: T[]; deferred: number } {
  if (policy === "ignore") return { commit: [], deferred: 0 };
  if (policy === "every-version") return { commit: [...changes], deferred: 0 };
  const today = utcDay(now);
  const lastPerDay = new Map<number, T>();
  let deferred = 0;
  for (const c of changes) {
    const day = utcDay(c.updatedAt);
    if (day >= today) {
      deferred++;
      continue;
    }
    const prev = lastPerDay.get(day);
    if (!prev || c.updatedAt > prev.updatedAt || (c.updatedAt.getTime() === prev.updatedAt.getTime() && c.version > prev.version)) {
      lastPerDay.set(day, c);
    }
  }
  const commit = [...lastPerDay.values()].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.version - b.version);
  return { commit, deferred };
}

/**
 * Label each change. The first commit of an asset is "created" when it is
 * version 1 and "baseline" when earlier history is not in git; later new
 * versions are "content"; in-place updates are "metadata".
 */
export function assignKinds(changes: readonly CandidateChange[], hasPriorCommits: boolean): PlannedChange[] {
  let first = !hasPriorCommits;
  return changes.map((c) => {
    let kind: ChangeKind;
    if (first) kind = c.version === 1 ? "created" : "baseline";
    else kind = c.newVersion ? "content" : "metadata";
    first = false;
    return { ...c, kind };
  });
}

/** Time order across assets; ties broken by type order (stores before memories), asset ID and version. */
export function orderChanges<T extends { updatedAt: Date; assetType: string; assetId: string; version: number }>(changes: readonly T[], typeOrder: readonly string[]): T[] {
  const rank = (t: string) => {
    const i = typeOrder.indexOf(t);
    return i === -1 ? typeOrder.length : i;
  };
  return [...changes].sort(
    (a, b) =>
      a.updatedAt.getTime() - b.updatedAt.getTime() ||
      rank(a.assetType) - rank(b.assetType) ||
      (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0) ||
      a.version - b.version,
  );
}

/** Commit policy for a memory store by name: space setting, then policy override, then policy default. */
export function resolveStorePolicy(
  storeName: string | null | undefined,
  policy: { defaultStoreCommitPolicy: StoreCommitPolicy; storeCommitPolicies: Record<string, StoreCommitPolicy> },
  spaceOverrides: Record<string, StoreCommitPolicy>,
): StoreCommitPolicy {
  if (!storeName) return policy.defaultStoreCommitPolicy;
  return spaceOverrides[storeName] ?? policy.storeCommitPolicies[storeName] ?? policy.defaultStoreCommitPolicy;
}
