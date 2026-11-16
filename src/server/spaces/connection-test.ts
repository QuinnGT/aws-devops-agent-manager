import {
  type DevOpsAgentClient,
  GetAgentSpaceCommand,
  ListAssetsCommand,
  ListAssetTypesCommand,
} from "@aws-sdk/client-devops-agent";
import type { STSClient } from "@aws-sdk/client-sts";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { recordAuditEvent } from "@/server/audit-log";
import { type Actor, devOpsAgentClient, type SpaceAwsConfig } from "@/server/aws/clients";
import { pages } from "@/server/aws/paginate";
import { db } from "@/server/db/client";
import { agentSpaces, syncState } from "@/server/db/schema";
import type { JobContext } from "@/server/jobs/registry";
import { requestSync } from "@/server/sync/contract";
import { checkExternalIdEnforced, type ExternalIdCheck } from "./external-id";
import { getSpaceById, type SpaceRow, toAwsConfig } from "./queries";

/**
 * Connection test: GetAgentSpace,
 * ListAssetTypes, and ListAssets limited to one item, through the space's read
 * access. When the space has role ARNs and an external ID, the roles must also
 * refuse AssumeRole without that external ID, or registration is rejected.
 */

export const CONNECTION_TEST_QUEUE = "spaces.connection-test";

export const connectionTestInput = z.object({
  spaceId: z.uuid(),
  reason: z.enum(["registration", "manual"]).default("manual"),
});

export type ConnectionTestInput = z.output<typeof connectionTestInput>;

export type ConnectionStatus = "ok" | "failed" | "rejected";

export type ConnectionStep = "GetAgentSpace" | "ListAssetTypes" | "ListAssets" | "ExternalIdCheck";

/** Stored in agent_spaces.connection_detail. Asset type IDs, counts and error name/message only. */
export interface ConnectionDetail {
  assetTypeIds?: string[];
  counts?: { assetTypes: number; sampledAssets: number; moreAssets: boolean };
  externalIdCheck?: ExternalIdCheck["status"];
  failedStep?: ConnectionStep;
  error?: { name: string; message: string };
}

export interface ConnectionResult {
  status: ConnectionStatus;
  detail: ConnectionDetail;
}

/** Bounded so a misbehaving paginator can't loop forever. */
const MAX_ASSET_TYPE_PAGES = 10;

function errorSummary(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message.slice(0, 500) };
  return { name: "Error", message: String(err).slice(0, 500) };
}

export interface ConnectionTestClients {
  client?: DevOpsAgentClient;
  sts?: STSClient;
}

/** Run the three read calls and the external ID check. Never throws for an AWS error. */
export async function testSpaceConnection(
  space: SpaceAwsConfig,
  actor: Actor,
  clients: ConnectionTestClients = {},
  progress: (fraction: number, message: string) => Promise<void> = async () => {},
): Promise<ConnectionResult> {
  let step: ConnectionStep = "GetAgentSpace";
  const detail: ConnectionDetail = {};
  try {
    const client = clients.client ?? devOpsAgentClient(space, "read", actor);

    await progress(0.1, "Calling GetAgentSpace");
    const got = await client.send(new GetAgentSpaceCommand({ agentSpaceId: space.agentSpaceId }));
    if (got.agentSpace?.agentSpaceId && got.agentSpace.agentSpaceId !== space.agentSpaceId) {
      throw Object.assign(new Error("GetAgentSpace returned a different Agent Space ID."), { name: "AgentSpaceMismatch" });
    }

    step = "ListAssetTypes";
    await progress(0.35, "Calling ListAssetTypes");
    const assetTypeIds: string[] = [];
    for await (const page of pages((r) => client.send(new ListAssetTypesCommand(r)), {}, { maxPages: MAX_ASSET_TYPE_PAGES })) {
      for (const t of page.items ?? []) if (t.assetType) assetTypeIds.push(t.assetType);
    }
    detail.assetTypeIds = assetTypeIds;

    step = "ListAssets";
    await progress(0.6, "Calling ListAssets");
    const assets = await client.send(new ListAssetsCommand({ agentSpaceId: space.agentSpaceId, maxResults: 1 }));
    detail.counts = {
      assetTypes: assetTypeIds.length,
      sampledAssets: assets.items?.length ?? 0,
      moreAssets: Boolean(assets.nextToken),
    };

    step = "ExternalIdCheck";
    await progress(0.8, "Checking that the roles require the external ID");
    const check = await checkExternalIdEnforced(space, actor, clients.sts);
    detail.externalIdCheck = check.status;
    if (check.status === "error") {
      return { status: "failed", detail: { ...detail, failedStep: step, error: check.error } };
    }
    if (check.status === "not-enforced") {
      return {
        status: "rejected",
        detail: {
          ...detail,
          failedStep: step,
          error: {
            name: "ExternalIdNotEnforced",
            message: `These roles can be assumed without the external ID: ${check.roles.join(", ")}. Add an sts:ExternalId condition to their trust policies.`,
          },
        },
      };
    }
    return { status: "ok", detail };
  } catch (err) {
    return { status: "failed", detail: { ...detail, failedStep: step, error: errorSummary(err) } };
  }
}

export class ConnectionTestFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionTestFailed";
  }
}

export interface ConnectionTestDeps {
  loadSpace(spaceId: string): Promise<SpaceRow | null>;
  saveResult(spaceId: string, result: ConnectionResult, at: Date): Promise<void>;
  /** True once a sync of the space has completed, so later tests don't start a registration sync */
  hasSynced(spaceId: string): Promise<boolean>;
  requestSync: typeof requestSync;
  recordAuditEvent: typeof recordAuditEvent;
  clients?: ConnectionTestClients;
  now?: () => Date;
}

export const defaultConnectionTestDeps: ConnectionTestDeps = {
  loadSpace: getSpaceById,
  saveResult: async (spaceId, result, at) => {
    await db()
      .update(agentSpaces)
      .set({ connectionStatus: result.status, connectionCheckedAt: at, connectionDetail: result.detail })
      .where(eq(agentSpaces.id, spaceId));
  },
  hasSynced: async (spaceId) => {
    const [row] = await db()
      .select({ completed: syncState.lastSyncCompletedAt, baseline: syncState.baselineCompletedAt })
      .from(syncState)
      .where(eq(syncState.spaceId, spaceId));
    return Boolean(row?.completed ?? row?.baseline);
  },
  requestSync,
  recordAuditEvent,
};

/**
 * Job handler for spaces.connection-test. Stores the result on the space,
 * records an audit event, and after the first successful test of a space
 * (registration) requests the baseline sync. A failed or rejected test
 * throws so the job shows as failed.
 */
export async function runConnectionTest(
  input: ConnectionTestInput,
  ctx: JobContext,
  deps: ConnectionTestDeps = defaultConnectionTestDeps,
): Promise<{ status: ConnectionStatus; detail: ConnectionDetail; syncRunId: string | null }> {
  const space = await deps.loadSpace(input.spaceId);
  if (!space) throw new ConnectionTestFailed("The space no longer exists.");

  const result = await testSpaceConnection(toAwsConfig(space), ctx.actor, deps.clients, (f, m) => ctx.progress(f, m));
  const at = deps.now?.() ?? new Date();
  await deps.saveResult(space.id, result, at);

  let syncRunId: string | null = null;
  if (result.status === "ok" && (input.reason === "registration" || !(await deps.hasSynced(space.id)))) {
    await ctx.progress(0.95, "Starting the first sync");
    syncRunId = await deps.requestSync(space.id, ctx.actor, "registration");
  }

  await deps.recordAuditEvent({
    actor: ctx.actor,
    action: "space.connection-test",
    spaceId: space.id,
    targetType: "agent_space",
    targetId: space.id,
    result: result.status === "ok" ? "ok" : "error",
    details: {
      reason: input.reason,
      status: result.status,
      failedStep: result.detail.failedStep ?? null,
      errorName: result.detail.error?.name ?? null,
      externalIdCheck: result.detail.externalIdCheck ?? null,
      syncRunId,
    },
  });

  if (result.status !== "ok") {
    const e = result.detail.error;
    const prefix = result.status === "rejected" ? "Registration rejected" : "Connection test failed";
    throw new ConnectionTestFailed(`${prefix} at ${result.detail.failedStep}: ${e ? `${e.name}: ${e.message}` : "unknown error"}`);
  }
  await ctx.progress(1, "Connected");
  return { status: result.status, detail: result.detail, syncRunId };
}
