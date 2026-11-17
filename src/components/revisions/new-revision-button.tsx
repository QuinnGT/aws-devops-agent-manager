import "server-only";
import { createRevisionAction, createRevisionFromImportAction } from "@/app/(app)/spaces/[alias]/revisions/actions";
import { syncIntervalFor } from "@/components/app-shell/space-top-bar";
import { syncState, syncStatusText } from "@/components/common/sync-status-state";
import { formatTime } from "@/components/common/time-format";
import { getViewerZone } from "@/components/common/viewer-zone";
import { countAssetsByType, getSyncState } from "@/server/assets/queries";
import { policyForSpace } from "@/server/journals/policy";
import { loadReleaseList } from "@/server/releases";
import { usualLayout } from "@/server/revisions/layouts";
import { revisionNames } from "@/server/revisions/queries";
import type { Space } from "@/server/spaces/queries";
import { getHistoryRepoForSpace } from "@/server/spaces/queries";
import { NewRevisionDialog } from "./new-revision-dialog";
import { freeRevisionName, usualLayoutText } from "./words";

/**
 * "New revision" (server part): gathers the releases, the live space's last
 * sync and asset count, the layouts and the name rule, then renders the
 * client dialog. The caller has checked `revisions.build`; `canSync` is
 * `sync.run` and `canManage` is `spaces.manage`. With `fromImport` it is
 * "Fix in a revision" on an import: the live space in the import's layout,
 * with the import's files as the first save.
 */
export async function NewRevisionButton({
  space,
  canSync,
  canManage,
  triggerLabel,
  takenNames,
  fromImport,
  triggerVariant,
}: {
  space: Space;
  canSync: boolean;
  canManage: boolean;
  triggerLabel?: string;
  takenNames?: string[];
  fromImport?: { importId: string; fileName: string; layout: string; defaultName: string };
  triggerVariant?: "default" | "outline";
}) {
  const [{ policy }, releaseView, sync, byType, repoRow, zone] = await Promise.all([policyForSpace(space), loadReleaseList(space), getSyncState(space.id), countAssetsByType(space.id), getHistoryRepoForSpace(space), getViewerZone()]);
  const usual = await usualLayout(space.id, policy);
  // From an import the name is prefilled, so start from one no revision has yet.
  const taken = fromImport ? (takenNames ?? (await revisionNames(space.id))) : takenNames;
  const importName = fromImport ? freeRevisionName(fromImport.defaultName, taken ?? [], policy.revisions.name.maxLength) : null;
  const lastSyncAt = sync?.lastSyncCompletedAt?.toISOString() ?? null;
  const state = syncState({ lastCompletedAt: lastSyncAt, status: sync?.status ?? null, intervalMinutes: syncIntervalFor(space) });
  const layouts = Object.entries(policy.packageLayouts.layouts).map(([name, l]) => ({ name, label: l.label ?? name, description: l.description ?? null }));
  const usualText = usualLayoutText(usual, usual.at ? formatTime(usual.at, "date", zone) : null);
  const blocked = !repoRow ? "The history repository isn't set up for this space." : !releaseView.repo.ok ? releaseView.repo.message : null;
  return (
    <NewRevisionDialog
      alias={space.alias}
      createAction={fromImport ? createRevisionFromImportAction.bind(null, space.alias, fromImport.importId) : createRevisionAction.bind(null, space.alias)}
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
      defaultLayout={fromImport?.layout ?? usual.name}
      usualLayoutText={usualText}
      layoutIsDefault={usual.source === "default"}
      branchTemplate={policy.historyLayout.revisionBranch}
      folderTemplate={policy.historyLayout.packageDir}
      nameRule={{ pattern: policy.revisions.name.pattern, hint: policy.revisions.name.hint, maxLength: policy.revisions.name.maxLength }}
      repoName={repoRow?.name ?? null}
      blocked={blocked}
      canManage={canManage}
      triggerLabel={triggerLabel}
      takenNames={policy.revisions.name.uniqueIgnoringCase ? taken : undefined}
      fromImport={
        fromImport && importName
          ? { fileName: fromImport.fileName, defaultName: importName, ...(importName !== fromImport.defaultName ? { nameNote: `A revision named ${fromImport.defaultName} already exists, so this name has a number at the end.` } : {}) }
          : undefined
      }
      triggerVariant={triggerVariant}
    />
  );
}
