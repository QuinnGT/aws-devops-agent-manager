import { liveErrorNeedsSettings } from "@/server/assets/live";
import { plainErrorText } from "@/server/jobs/error-text";
import { parseConnectionDetail } from "./connection-detail";
import type { SpaceRow } from "./queries";

/**
 * One connection status for every surface (All spaces, Home, the top bar,
 * Space settings). The last connection test decides, unless a later sync
 * failed for a reason an Admin fixes in Space settings (no credentials, a role
 * that refuses): then the space shows as not connected, with that cause. Pure.
 */

export interface ConnectionView {
  /** "ok" | "failed" | "rejected" | "unknown" (agent_spaces.connection_status words) */
  status: "ok" | "failed" | "rejected" | "unknown";
  /** What failed: the connection test or a later sync; null when connected or not tested */
  failedBy: "test" | "sync" | null;
  /** When it failed */
  at: Date | null;
  /** The cause as a plain sentence, when not connected */
  cause: string | null;
  /** True when an Admin fixes the cause in Space settings (show connectionNextStep) */
  needsSettings: boolean;
}

type SpaceFields = Pick<SpaceRow, "connectionStatus" | "connectionCheckedAt" | "connectionDetail">;
type SyncFields = { status: string; error: string | null; lastSyncCompletedAt: Date | null } | null | undefined;

export function connectionView(space: SpaceFields, sync: SyncFields): ConnectionView {
  const checkedAt = space.connectionCheckedAt;
  if (space.connectionStatus === "failed" || space.connectionStatus === "rejected") {
    const e = parseConnectionDetail(space.connectionDetail).error;
    const raw = e ? `${e.name}: ${e.message}` : null;
    return {
      status: space.connectionStatus,
      failedBy: "test",
      at: checkedAt,
      // A rejection's message is this app's own sentence (connection-test.ts).
      cause: (space.connectionStatus === "rejected" ? e?.message : plainErrorText(raw)) ?? "The connection test stopped without an error message.",
      needsSettings: space.connectionStatus === "rejected" || (raw !== null && liveErrorNeedsSettings(raw)),
    };
  }
  const syncAt = sync?.lastSyncCompletedAt ?? null;
  const syncIsLater = !checkedAt || (syncAt !== null && syncAt > checkedAt);
  if (sync?.status === "error" && sync.error && syncIsLater && liveErrorNeedsSettings(sync.error)) {
    return { status: "failed", failedBy: "sync", at: syncAt, cause: plainErrorText(sync.error), needsSettings: true };
  }
  return { status: space.connectionStatus === "ok" ? "ok" : "unknown", failedBy: null, at: null, cause: null, needsSettings: false };
}
