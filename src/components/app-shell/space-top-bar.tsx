import { SyncStatus } from "@/components/common/sync-status";
import { can, roleFor, type AppUser } from "@/server/auth/dal";
import { missingRoleReason } from "@/server/auth/role-words";
import { connectionNextStep } from "@/server/assets/live";
import { getSyncState } from "@/server/assets/queries";
import { plainErrorText } from "@/server/jobs/error-text";
import { latestOpenRunId } from "@/server/jobs/status";
import { getAppPolicy } from "@/server/policy";
import { connectionView } from "@/server/spaces/connection-state";
import type { Space } from "@/server/spaces/queries";
import { SYNC_SPACE_QUEUE } from "@/server/sync/contract";
import { spaceBase } from "./nav";
import { SyncNowButton } from "./sync-now-button";
import { TopBar, type Crumb } from "./top-bar";

/** Sync interval in minutes: the space setting, else policy sync.intervalMinutes. */
export function syncIntervalFor(space: Pick<Space, "parsedSettings">): number {
  return space.parsedSettings.syncIntervalMinutes ?? getAppPolicy().policy.sync.intervalMinutes;
}

/**
 * TopBar for a page inside a space: the space name crumb (linking to Home),
 * then `crumbs`, with SyncStatus and "Sync now" (sync.run) on the right.
 * Callers have already checked that the user may read the space.
 */
export async function SpaceTopBar({ space, user, crumbs, keepLastTwoBelow }: { space: Space; user: AppUser; crumbs: Crumb[]; keepLastTwoBelow?: "sm" | "lg" }) {
  const [sync, canSync, canManage, syncRunId, role] = await Promise.all([
    getSyncState(space.id),
    can(user, "sync.run", space.id),
    can(user, "spaces.manage", space.id),
    latestOpenRunId(space.id, SYNC_SPACE_QUEUE),
    roleFor(user, space.id),
  ]);
  const conn = connectionView(space, sync);
  // A role that can't sync sees "Sync now" disabled with the reason instead of no button.
  const syncReason = canSync ? null : missingRoleReason(getAppPolicy().policy, role, "sync.run", "sync the space");
  return (
    <TopBar
      keepLastTwoBelow={keepLastTwoBelow}
      crumbs={[{ label: space.displayName ?? space.alias, href: spaceBase(space.alias) }, ...crumbs]}
      right={
        <>
          <SyncStatus
            lastCompletedAt={sync?.lastSyncCompletedAt?.toISOString() ?? null}
            status={sync?.status ?? null}
            error={plainErrorText(sync?.error)}
            intervalMinutes={syncIntervalFor(space)}
            runId={syncRunId}
            connection={conn.failedBy ? { cause: conn.cause, nextStep: conn.needsSettings ? connectionNextStep({ canManage }) : null } : null}
          />
          <SyncNowButton alias={space.alias} disabledReason={syncReason} />
        </>
      }
    />
  );
}
