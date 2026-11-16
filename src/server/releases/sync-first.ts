import { liveErrorMessage } from "@/server/assets/live";
import type { JobContext } from "@/server/jobs/registry";
import type { ReleasesPolicy } from "@/server/policy/sections/releases";
import { syncSpace, type SyncDeps, type SyncResult } from "@/server/sync/engine";
import { ReleaseError } from "./errors";

/**
 * The sync a release runs before it reads HEAD (policy releases.syncBeforeCreate),
 * so the manifest matches the live space at that moment. It runs as a reconcile
 * (a full listing that also records deletions): an incremental sync can't see
 * deleted assets, and the release would pin them as live. It goes through the
 * sync module with the deps the sync.space job builds; syncSpace takes the
 * space's sync lock itself. A release of a given commit (tag after apply)
 * pins that commit and never syncs.
 */

export type SyncSpaceFn = (spaceId: string, deps: SyncDeps, opts?: { mode?: "auto" | "reconcile" }) => Promise<SyncResult>;

export type SyncFirstOutcome = { synced: false; reason: "commit-given" | "policy-off" } | { synced: true; result: SyncResult };

/** Progress range the sync takes in the release job (the rest is reading, committing and tagging). */
export const SYNC_PROGRESS = { from: 0.05, to: 0.45 } as const;

function message(err: unknown): string {
  return liveErrorMessage(err);
}

export async function syncBeforeRelease(
  input: { spaceId: string; commit: string | null },
  ctx: JobContext,
  policy: Pick<ReleasesPolicy, "syncBeforeCreate">,
  sync: SyncSpaceFn = syncSpace,
): Promise<SyncFirstOutcome> {
  if (input.commit) return { synced: false, reason: "commit-given" };
  if (!policy.syncBeforeCreate) return { synced: false, reason: "policy-off" };
  const span = SYNC_PROGRESS.to - SYNC_PROGRESS.from;
  await ctx.progress(SYNC_PROGRESS.from, "Syncing the space");
  let result: SyncResult;
  try {
    result = await sync(
      input.spaceId,
      {
        actor: ctx.actor,
        log: ctx.log,
        progress: (fraction, msg) => ctx.progress(SYNC_PROGRESS.from + Math.max(0, Math.min(1, fraction)) * span, msg ? `Syncing: ${msg}` : "Syncing the space"),
        cancelled: ctx.cancelled,
      },
      { mode: "reconcile" },
    );
  } catch (err) {
    throw new ReleaseError(`The release wasn't created because the sync of the space failed: ${message(err)}`);
  }
  if (result.status === "skipped") {
    throw new ReleaseError("The release wasn't created because another sync of this space is still running. Try again when it finishes.");
  }
  if (result.status === "cancelled") throw new ReleaseError("The release wasn't created because the sync was cancelled.");
  return { synced: true, result };
}
