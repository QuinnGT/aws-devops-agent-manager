import { ShieldX } from "lucide-react";
import { Callout } from "@/components/common/callout";
import { ConnectionNextStep } from "@/components/common/connection-next-step";
import { StatusBadge } from "@/components/common/status-badge";
import { connectionStatusSpec, type StatusSpec } from "@/components/common/status-words";
import { Time } from "@/components/common/time";
import type { FormState } from "@/components/spaces/form-state";
import { StartJobButton } from "@/components/spaces/start-job-button";
import { parseConnectionDetail } from "@/server/spaces/connection-detail";
import type { ConnectionView } from "@/server/spaces/connection-state";
import type { Space } from "@/server/spaces/queries";

const REJECTED: StatusSpec = { tone: "destructive", icon: ShieldX, label: "Rejected: external ID not required" };

const plural = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;

/** How the app reaches AWS for this space, in words. */
export function accessWords(space: Pick<Space, "awsProfile" | "readRoleArn" | "writeRoleArn">): string {
  if (space.awsProfile) return `the ${space.awsProfile} profile`;
  if (space.readRoleArn && space.writeRoleArn) return "the read and write roles";
  if (space.readRoleArn) return "the read role";
  return "this app's own AWS credentials";
}

/**
 * The connection status (`connectionView`: the last test, or a later sync that
 * failed for a settings cause), with "Test connection" and its job progress.
 */
export function ConnectionStatus({ space, conn, testAction }: { space: Space; conn: ConnectionView; testAction: (prev: FormState) => Promise<FormState> }) {
  const detail = parseConnectionDetail(space.connectionDetail);
  const status = conn.status === "rejected" ? REJECTED : connectionStatusSpec(conn.status);
  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusBadge {...status} />
        <span className="text-xs text-muted-foreground">
          {conn.failedBy === "sync" && conn.at ? (
            <>
              The last sync failed <Time value={conn.at} format="datetime" />
            </>
          ) : space.connectionCheckedAt ? (
            <>
              Checked <Time value={space.connectionCheckedAt} format="datetime" />
            </>
          ) : (
            "Not checked since the last change"
          )}
          {` · through ${accessWords(space)}`}
        </span>
      </div>
      {conn.status === "ok" && detail.counts ? (
        <p className="text-xs text-muted-foreground">
          GetAgentSpace, ListAssetTypes and ListAssets passed: {plural(detail.counts.assetTypes, "asset type", "asset types")}, {detail.counts.sampledAssets} sampled{" "}
          {detail.counts.sampledAssets === 1 ? "asset" : "assets"}.
          {detail.externalIdCheck === "enforced" ? " The roles refuse AssumeRole without the external ID." : null}
        </p>
      ) : null}
      {conn.status === "failed" ? (
        <Callout tone="destructive" title={conn.failedBy === "sync" ? "The last sync couldn't reach the space" : detail.failedStep ? `${detail.failedStep} failed` : "The connection test failed"}>
          <span className="break-words">{conn.cause}</span>
          {conn.needsSettings ? (
            <>
              {" "}
              <ConnectionNextStep alias={space.alias} canManage onSettingsPage />
            </>
          ) : null}
        </Callout>
      ) : null}
      {conn.status === "rejected" ? (
        <Callout tone="destructive" title="A role can be assumed without the external ID">
          Add an sts:ExternalId condition with the value below to each role&apos;s trust policy, then test again.
        </Callout>
      ) : null}
      <StartJobButton action={testAction} label="Test connection" pendingLabel="Starting…" doneText="Connection test finished." variant="outline" size="sm" />
    </div>
  );
}
