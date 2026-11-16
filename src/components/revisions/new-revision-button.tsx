import "server-only";
import { createRevisionAction } from "@/app/(app)/spaces/[alias]/revisions/actions";
import { syncIntervalFor } from "@/components/app-shell/space-top-bar";
import { syncState, syncStatusText } from "@/components/common/sync-status-state";
import { formatTime } from "@/components/common/time-format";
import { getViewerZone } from "@/components/common/viewer-zone";
import { countAssetsByType, getSyncState } from "@/server/assets/queries";
import { policyForSpace } from "@/server/journals/policy";
import { loadReleaseList } from "@/server/releases";
import { usualLayout } from "@/server/revisions/layouts";
import type { Space } from "@/server/spaces/queries";
import { getHistoryRepoForSpace } from "@/server/spaces/queries";
import { NewRevisionDialog } from "./new-revision-dialog";
import { usualLayoutText } from "./words";

/**
 * "New revision" (server part): gathers the releases, the live space's last
 * sync and asset count, the layouts and the name rule, then renders the
 * client dialog. The caller has checked `revisions.build`; `canSync` is
 * `sync.run` and `canManage` is `spaces.manage`.
 */
export async function NewRevisionButton({ space, canSync, canManage, triggerLabel, takenNames }: { space: Space; canSync: boolean; canManage: boolean; triggerLabel?: string; takenNames?: string[] }) {
  const [{ policy }, releaseView, sync, byType, repoRow, zone] = await Promise.all([policyForSpace(space), loadReleaseList(space), getSyncState(space.id), countAssetsByType(space.id), getHistoryRepoForSpace(space), getViewerZone()]);
  const usual = await usualLayout(space.id, policy);
  const lastSyncAt = sync?.lastSyncCompletedAt?.toISOString() ?? null;
  const state = syncState({ lastCompletedAt: lastSyncAt, status: sync?.status ?? null, intervalMinutes: syncIntervalFor(space) });
  const layouts = Object.entries(policy.packageLayouts.layouts).map(([name, l]) => ({ name, label: l.label ?? name, description: l.description ?? null }));
  const usualText = usualLayoutText(usual, usual.at ? formatTime(usual.at, "date", zone) : null);
  const blocked = !repoRow ? "The history repository isn't set up for this space." : !releaseView.repo.ok ? releaseView.repo.message : null;
  return (
    <NewRevisionDialog
      alias={space.alias}
      createAction={createRevisionAction.bind(null, space.alias)}
      releases={releaseView.releases.map((r, i) => ({
        id: r.id,
        name: r.name,
        detail: `${formatTime(r.createdAt, "datetime", zone)} · ${r.assetCount} ${r.assetCount === 1 ? "asset" : "assets"}`,
        note: r.note?.trim() || null,
        // The list is newest first.
        latest: i === 0,
      }))}
      live={{
        assets: Object.values(byType).reduce((n, c) => n + c, 0),
        lastSyncAt,
        stale: state === "stale" || state === "failed" || state === "never",
        lastSyncText: lastSyncAt ? formatTime(lastSyncAt, "datetime", zone) : syncStatusText(state, lastSyncAt),
      }}
      canSync={canSync}
      layouts={layouts}
      defaultLayout={usual.name}
      usualLayoutText={usualText}
      layoutIsDefault={usual.source === "default"}
      branchTemplate={policy.historyLayout.revisionBranch}
      folderTemplate={policy.historyLayout.packageDir}
      nameRule={{ pattern: policy.revisions.name.pattern, hint: policy.revisions.name.hint, maxLength: policy.revisions.name.maxLength }}
      repoName={repoRow?.name ?? null}
      blocked={blocked}
      canManage={canManage}
      triggerLabel={triggerLabel}
      takenNames={policy.revisions.name.uniqueIgnoringCase ? takenNames : undefined}
    />
  );
}
