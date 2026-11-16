import { liveErrorMessage, liveErrorNeedsSettings } from "@/server/assets/live";
import { latestChangeByAsset, listIndexedAssets } from "@/server/assets/queries";
import { openSpaceHistoryRepo } from "@/server/assets/repo";
import type { JobContext } from "@/server/jobs/registry";
import { policyForSpace } from "@/server/analyzers/service";
import { driftAgainstIndex } from "@/server/releases/loaders";
import { parseManifest } from "@/server/releases/manifest";
import type { SyncSpaceFn } from "@/server/releases/sync-first";
import { syncSpace, type SyncResult } from "@/server/sync/engine";
import { compareLive } from "./live";
import { finishBlocked, finishCancelled, finishFailed, finishSucceeded, isFinished, startRun, subContext, type VerifyJobInput, type VerifyJobResult } from "./run";
import type { LiveCheckResult } from "./types";

/**
 * The verify.live job (check 1): sync the space, then compare every asset of
 * the release with the live index. The sync is the reconcile a release runs
 * first (releases/sync-first.ts): a full listing under the space's sync
 * lock, so assets deleted since the release show as missing.
 */

export interface VerifyLiveDeps {
  /** Defaults to the sync engine; tests pass a stub or run the engine against a mocked client */
  sync?: SyncSpaceFn;
}

/** An error from the AWS SDK (it carries $metadata), or one an Admin fixes in Space settings: the space can't be reached. */
function unreachable(err: unknown): boolean {
  return (err !== null && typeof err === "object" && "$metadata" in err) || liveErrorNeedsSettings(err);
}

export async function runVerifyLive(input: VerifyJobInput, ctx: JobContext, deps: VerifyLiveDeps = {}): Promise<VerifyJobResult> {
  const started = await startRun(input, ctx, "live");
  if (isFinished(started)) return started;
  const { run, release, space } = started;
  try {
    const policy = await policyForSpace(space.id);
    const manifest = parseManifest(release.manifest);
    if (!manifest) return finishBlocked(run, "manifest-invalid", null);

    let sync: SyncResult | null = null;
    let syncedAt: string | null = null;
    if (policy.verify.live.syncFirst) {
      await ctx.progress(0.05, "Syncing the space");
      const sub = subContext(ctx, 0.05, 0.6, "Syncing");
      try {
        sync = await (deps.sync ?? syncSpace)(space.id, { actor: ctx.actor, log: ctx.log, progress: sub.progress, cancelled: ctx.cancelled }, { mode: "reconcile" });
      } catch (err) {
        return finishBlocked(run, unreachable(err) ? "space-unreachable" : "sync-failed", liveErrorMessage(err));
      }
      if (sync.status === "skipped") return finishBlocked(run, "sync-busy", null);
      if (sync.status === "cancelled") return finishCancelled(run);
      syncedAt = new Date().toISOString();
    }
    if (await ctx.cancelled()) return finishCancelled(run);

    await ctx.progress(0.65, "Comparing the release with the live space");
    const opened = await openSpaceHistoryRepo(space, policy.historyLayout);
    const repo = opened.ok ? opened.repo : null;
    const drift = await driftAgainstIndex(space, manifest.assets, repo, policy);
    const [index, latest] = await Promise.all([listIndexedAssets(space.id, { includeDeleted: true }), latestChangeByAsset(space.id)]);
    const compared = compareLive({ assets: manifest.assets, drift, index, latest, policy });
    const result: LiveCheckResult = {
      release: { id: release.id, name: release.name, sourceCommit: release.sourceCommit },
      sync: sync ? { mode: sync.mode, status: sync.status, changes: sync.changes, commits: sync.commits, deleted: sync.deleted, deferred: sync.deferred, at: syncedAt ?? undefined } : null,
      headCommit: drift.headCommit,
      ...compared,
    };
    await finishSucceeded(run, result);
    await ctx.progress(1, compared.matches ? "The live space matches the release" : `${compared.counts.changed} changed, ${compared.counts.missing} missing, ${compared.counts.added} added`);
    return { verificationId: run.id, state: "succeeded", summary: { ...compared.counts, allMatch: compared.matches } };
  } catch (err) {
    await finishFailed(run, err);
    throw err;
  }
}
