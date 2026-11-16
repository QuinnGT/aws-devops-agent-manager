import { Tag } from "lucide-react";
import { checkReleaseNameAction, createReleaseAction, releaseErrorNeedsSettingsAction } from "@/app/(app)/spaces/[alias]/releases/actions";
import { ConnectionNextStep } from "@/components/common/connection-next-step";
import { DisabledReason } from "@/components/common/disabled-reason";
import { Button } from "@/components/ui/button";
import { getSyncState } from "@/server/assets/queries";
import { loadPlanList } from "@/server/plans/loaders";
import { connectionBlocksRelease, type ReleaseListView } from "@/server/releases";
import { connectionView } from "@/server/spaces/connection-state";
import type { Space } from "@/server/spaces/queries";
import { CreateReleaseDialog } from "./create-release-dialog";

/**
 * "Create release" for the releases list (server component): works out what
 * the dialog shows and why it can't open, then renders the client dialog.
 * While the app can't reach the space, a release that syncs first is
 * disabled up front with the cause and the next step. The caller has
 * checked `releases.create`; `canManage` is `spaces.manage` (the next step
 * links to Space settings).
 */
export async function CreateReleaseButton({
  space,
  view,
  repoName,
  liveAssets,
  canManage,
  initialOpen = false,
  commit = null,
  planId = null,
}: {
  space: Space;
  view: Pick<ReleaseListView, "repo" | "nameRule" | "noteMaxChars" | "syncBeforeCreate" | "tagTemplate" | "manifestTemplate">;
  repoName: string | null;
  liveAssets: number;
  canManage: boolean;
  initialOpen?: boolean;
  commit?: string | null;
  planId?: string | null;
}) {
  if (!view.repo.ok || !repoName) {
    return (
      <DisabledReason reason={view.repo.ok ? "This space has no history repository." : view.repo.message}>
        <Button>
          <Tag aria-hidden />
          Create release
        </Button>
      </DisabledReason>
    );
  }
  if (!view.repo.head && !commit) {
    return (
      <DisabledReason reason="Nothing is saved in the history repository yet. Run a sync first.">
        <Button>
          <Tag aria-hidden />
          Create release
        </Button>
      </DisabledReason>
    );
  }
  const conn = connectionView(space, await getSyncState(space.id));
  const blocked = connectionBlocksRelease(conn, { syncFirst: view.syncBeforeCreate ?? true, commit });
  if (blocked) {
    return (
      <DisabledReason
        reason={
          // One span, so the reason wraps as one line of text inside DisabledReason's flex row.
          <span className="max-w-[52ch]">
            {blocked}
            {conn.needsSettings ? (
              <>
                {" "}
                <ConnectionNextStep alias={space.alias} canManage={canManage} />
              </>
            ) : null}
          </span>
        }
      >
        <Button>
          <Tag aria-hidden />
          Create release
        </Button>
      </DisabledReason>
    );
  }
  const [applying] = await loadPlanList(space.id, { states: ["applying"], limit: 1 });
  return (
    <CreateReleaseDialog
      alias={space.alias}
      createAction={createReleaseAction.bind(null, space.alias)}
      checkName={checkReleaseNameAction.bind(null, space.alias)}
      needsSettings={releaseErrorNeedsSettingsAction.bind(null, space.alias)}
      settingsStep={<ConnectionNextStep alias={space.alias} canManage={canManage} />}
      spaceName={space.displayName ?? space.alias}
      liveAssets={liveAssets}
      repoName={repoName}
      tagTemplate={view.tagTemplate ?? "{release}"}
      manifestTemplate={view.manifestTemplate ?? "{release}"}
      nameHint={view.nameRule.hint}
      nameMaxLength={view.nameRule.maxLength}
      noteMaxChars={view.noteMaxChars}
      syncFirst={view.syncBeforeCreate ?? true}
      applyingPlan={applying?.title ?? null}
      initialOpen={initialOpen}
      commit={commit}
      planId={planId}
    />
  );
}
