import { z } from "zod";
import type { Actor } from "@/server/aws/clients";
import { enqueue } from "@/server/jobs/enqueue";
import type { JobDefinition } from "@/server/jobs/registry";

/**
 * CONTRACT. Other modules request a sync through requestSync(); the sync
 * job definition must use SYNC_SPACE_QUEUE and syncSpaceInput exactly.
 */
export const SYNC_SPACE_QUEUE = "sync.space";

export const syncSpaceInput = z.object({
  spaceId: z.string().uuid(),
  reason: z.enum(["manual", "schedule", "registration"]).default("manual"),
});

export type SyncSpaceInput = z.output<typeof syncSpaceInput>;

/** Minimal definition used only to enqueue; the worker registers the full definition. */
const syncSpaceSendOnly: JobDefinition<typeof syncSpaceInput> = {
  name: SYNC_SPACE_QUEUE,
  input: syncSpaceInput,
  options: { queuePolicy: "stately", singletonKey: (i) => i.spaceId },
  handler: async () => {
    throw new Error("sync.space runs only in the worker");
  },
};

/** Enqueue a sync of one space. Callers must have checked `sync.run` (or `spaces.manage`). */
export function requestSync(spaceId: string, actor: Actor, reason: SyncSpaceInput["reason"] = "manual"): Promise<string> {
  return enqueue(syncSpaceSendOnly, { spaceId, reason }, { actor, spaceId });
}
