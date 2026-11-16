import { existsSync } from "node:fs";
import { inArray } from "drizzle-orm";
import type { Actor } from "@/server/aws/clients";
import { db } from "@/server/db/client";
import { historyRepos, syncState } from "@/server/db/schema";
import { HistoryRepo } from "@/server/git/history-repo";
import { getPolicyForRepo } from "@/server/policy";
import { listSpaces, toHistoryRepoConfig } from "@/server/spaces/queries";

/** Scheduling for sync.tick: which spaces are due for a sync. */

export interface DueInput {
  intervalMinutes: number;
  lastEnqueuedAt: Date | null;
  lastSyncStartedAt: Date | null;
}

/** A space is due when its interval has passed since the later of the last enqueue and the last start. */
export function isDue(now: Date, s: DueInput): boolean {
  const last = Math.max(s.lastEnqueuedAt?.getTime() ?? 0, s.lastSyncStartedAt?.getTime() ?? 0);
  if (last === 0) return true;
  return now.getTime() - last >= s.intervalMinutes * 60_000;
}

export interface DueSpace {
  spaceId: string;
  alias: string;
  intervalMinutes: number;
}

/** Spaces with a history repository whose sync interval (space setting, else policy) has elapsed. */
export async function dueSpaces(now: Date): Promise<DueSpace[]> {
  const spaces = (await listSpaces()).filter((s) => s.historyRepoId);
  if (!spaces.length) return [];
  const ids = spaces.map((s) => s.id);
  const states = new Map((await db().select().from(syncState).where(inArray(syncState.spaceId, ids))).map((r) => [r.spaceId, r]));
  const repoIds = [...new Set(spaces.map((s) => s.historyRepoId!))];
  const repos = new Map((await db().select().from(historyRepos).where(inArray(historyRepos.id, repoIds))).map((r) => [r.id, r]));
  const out: DueSpace[] = [];
  for (const s of spaces) {
    const repo = repos.get(s.historyRepoId!);
    const dir = repo ? HistoryRepo.workingDirFor(toHistoryRepoConfig(repo)) : null;
    const policy = getPolicyForRepo(dir && existsSync(dir) ? dir : null).policy;
    const intervalMinutes = s.parsedSettings.syncIntervalMinutes ?? policy.sync.intervalMinutes;
    const st = states.get(s.id);
    if (isDue(now, { intervalMinutes, lastEnqueuedAt: st?.lastEnqueuedAt ?? null, lastSyncStartedAt: st?.lastSyncStartedAt ?? null })) {
      out.push({ spaceId: s.id, alias: s.alias, intervalMinutes });
    }
  }
  return out;
}

/** Enqueue a scheduled sync for every due space; returns the job run IDs. */
export async function enqueueDueSyncs(
  now: Date,
  actor: Actor,
  send: (spaceId: string, actor: Actor) => Promise<string>,
  patch: (spaceId: string, at: Date) => Promise<void>,
): Promise<{ spaceId: string; runId: string }[]> {
  const out: { spaceId: string; runId: string }[] = [];
  for (const s of await dueSpaces(now)) {
    const runId = await send(s.spaceId, actor);
    await patch(s.spaceId, now);
    out.push({ spaceId: s.spaceId, runId });
  }
  return out;
}
