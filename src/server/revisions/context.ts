import { liveErrorMessage } from "@/server/assets/live";
import { openSpaceHistoryRepo } from "@/server/assets/repo";
import { HistoryRepo } from "@/server/git/history-repo";
import type { JobContext } from "@/server/jobs/registry";
import { policyForSpace } from "@/server/journals/policy";
import { getLayout, type PackageLayout } from "@/server/packages/layout";
import { loadLiveIndex } from "@/server/package-io/history";
import type { LiveAssetRef } from "@/server/packages/types";
import { getPolicyForRepo, type Policy } from "@/server/policy";
import type { SyncSpaceFn } from "@/server/releases/sync-first";
import { getHistoryRepoForSpace, getSpaceById, toHistoryRepoConfig, type Space } from "@/server/spaces/queries";
import { syncSpace } from "@/server/sync/engine";
import { RevisionError } from "./types";

/**
 * Where revision code gets the space, its history repository and its policy
 * (app defaults overlaid with the repository's policy/ directory).
 */

/** Worker: the space and its history repository working copy, opened (or created) for writing. */
export async function workerContext(spaceId: string): Promise<{ space: Space; repo: HistoryRepo; policy: Policy }> {
  const space = await getSpaceById(spaceId);
  if (!space) throw new RevisionError("not-found", "Space not found.");
  const row = await getHistoryRepoForSpace(space);
  if (!row) throw new RevisionError("no-history", "This space has no history repository. An Admin can set one in the space settings.");
  const repo = await HistoryRepo.open(toHistoryRepoConfig(row));
  return { space, repo, policy: getPolicyForRepo(repo.dir).policy };
}

/** Web process: the existing working copy (never created here) and the space's policy. */
export async function readContext(space: Space): Promise<{ repo: HistoryRepo; policy: Policy }> {
  const { policy } = await policyForSpace(space);
  const opened = await openSpaceHistoryRepo(space, policy.historyLayout);
  if (!opened.ok) throw new RevisionError("no-history", opened.message);
  return { repo: opened.repo, policy };
}

export function layoutOf(policy: Pick<Policy, "packageLayouts">, name?: string | null): PackageLayout {
  try {
    return getLayout(policy, name ?? undefined);
  } catch {
    throw new RevisionError("unknown-layout", `There is no package layout named ${JSON.stringify(name)}.`, { layout: "Choose a layout from the list." });
  }
}

/** The space's live assets (asset_index) as the validation context, plus the full index entries. */
export async function liveRefs(space: Space, policy: Policy): Promise<{ refs: LiveAssetRef[]; index: Awaited<ReturnType<typeof loadLiveIndex>> }> {
  const index = await loadLiveIndex(space, policy);
  return { refs: index.entries.map((e) => ({ assetId: e.assetId, assetType: e.assetType, metadata: e.metadata })), index };
}

/**
 * The reconcile sync a revision from the live space runs first (policy
 * revisions.create.syncBeforeCreate), the same sync a release of HEAD runs
 * (releases/sync-first.ts), so the package matches the space at that moment.
 */
export async function syncBeforeRevision(spaceId: string, ctx: JobContext, policy: Pick<Policy, "revisions">, sync: SyncSpaceFn = syncSpace): Promise<boolean> {
  if (!policy.revisions.create.syncBeforeCreate) return false;
  await ctx.progress(0.05, "Syncing the space");
  let result: Awaited<ReturnType<SyncSpaceFn>>;
  try {
    result = await sync(
      spaceId,
      {
        actor: ctx.actor,
        log: ctx.log,
        progress: (fraction, msg) => ctx.progress(0.05 + Math.max(0, Math.min(1, fraction)) * 0.4, msg ? `Syncing: ${msg}` : "Syncing the space"),
        cancelled: ctx.cancelled,
      },
      { mode: "reconcile" },
    );
  } catch (err) {
    throw new RevisionError("no-history", `The revision wasn't created because the sync of the space failed: ${liveErrorMessage(err)}`);
  }
  if (result.status === "skipped") throw new RevisionError("no-history", "The revision wasn't created because another sync of this space is still running. Try again when it finishes.");
  if (result.status === "cancelled") throw new RevisionError("no-history", "The revision wasn't created because the sync was cancelled.");
  return true;
}
