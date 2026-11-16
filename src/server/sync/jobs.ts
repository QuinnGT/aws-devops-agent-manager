import { z } from "zod";
import { enqueue } from "@/server/jobs/enqueue";
import { defineJob, type JobDefinition } from "@/server/jobs/registry";
import { getAppPolicy } from "@/server/policy";
import { listSpaces } from "@/server/spaces/queries";
import { SYNC_SPACE_QUEUE, syncSpaceInput } from "./contract";
import { syncSpace, type SyncResult } from "./engine";
import { enqueueDueSyncs } from "./schedule";
import { patchSyncState } from "./state";

/** Jobs for the sync module. The worker registers every job listed in `jobs`. */

/** Sync one space: incremental, or the full baseline import on the first run. */
export const syncSpaceJob = defineJob({
  name: SYNC_SPACE_QUEUE,
  input: syncSpaceInput,
  options: { queuePolicy: "stately", singletonKey: (i) => i.spaceId },
  handler: async (input, ctx) => {
    ctx.log(`sync of space ${input.spaceId} (${input.reason})`);
    return syncSpace(input.spaceId, { actor: ctx.actor, log: ctx.log, progress: ctx.progress, cancelled: ctx.cancelled });
  },
});

export const reconcileInput = z.object({
  /** One space, or every space with a history repository when omitted */
  spaceId: z.string().uuid().optional(),
});

/** Daily full reconcile: a full listing that also commits deletions. */
export const reconcileJob = defineJob({
  name: "sync.reconcile",
  input: reconcileInput,
  options: { queuePolicy: "stately", singletonKey: (i) => i.spaceId ?? "all" },
  get schedule() {
    return { cron: getAppPolicy().policy.sync.reconcileCron, input: {} };
  },
  handler: async (input, ctx) => {
    const ids = input.spaceId ? [input.spaceId] : (await listSpaces()).filter((s) => s.historyRepoId).map((s) => s.id);
    const results: SyncResult[] = [];
    const failures: { spaceId: string; error: string }[] = [];
    for (const [n, spaceId] of ids.entries()) {
      if (await ctx.cancelled()) break;
      try {
        results.push(await syncSpace(spaceId, { actor: ctx.actor, log: ctx.log, cancelled: ctx.cancelled }, { mode: "reconcile" }));
      } catch (err) {
        failures.push({ spaceId, error: err instanceof Error ? err.message : String(err) });
      }
      await ctx.progress((n + 1) / ids.length, `Reconciled ${n + 1} of ${ids.length} spaces`);
    }
    if (failures.length) {
      throw new Error(`Reconcile failed for ${failures.length} of ${ids.length} spaces: ${failures.map((f) => `${f.spaceId}: ${f.error}`).join("; ")}`);
    }
    return { results };
  },
});

/** Scheduler tick: enqueue sync.space for each space whose interval has elapsed. */
export const tickJob = defineJob({
  name: "sync.tick",
  input: z.object({}),
  options: { quietLog: true },
  get schedule() {
    return { cron: getAppPolicy().policy.sync.tickCron, input: {} };
  },
  handler: async (_input, ctx) => {
    const enqueued = await enqueueDueSyncs(
      new Date(),
      ctx.actor,
      (spaceId, actor) => enqueue(syncSpaceJob, { spaceId, reason: "schedule" }, { actor, spaceId }),
      (spaceId, at) => patchSyncState(spaceId, { lastEnqueuedAt: at }),
    );
    return { enqueued };
  },
});

export const jobs: JobDefinition[] = [syncSpaceJob, reconcileJob, tickJob] as JobDefinition[];
