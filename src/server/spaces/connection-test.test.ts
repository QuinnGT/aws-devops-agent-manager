import {
  DevOpsAgentClient,
  GetAgentSpaceCommand,
  type GetAgentSpaceCommandOutput,
  ListAssetsCommand,
  type ListAssetsCommandOutput,
  ListAssetTypesCommand,
  type ListAssetTypesCommandOutput,
} from "@aws-sdk/client-devops-agent";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAwsCachesForTests } from "@/server/aws/clients";
import { testJobContext } from "@/server/jobs/registry";
import { apiFixture } from "../../../test/helpers/fixtures";
import { type ConnectionResult, type ConnectionTestDeps, runConnectionTest } from "./connection-test";
import { generateExternalId } from "./external-id";
import { connectionTestJob, jobs } from "./jobs";
import type { SpaceRow } from "./queries";

const SPACE_ID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const AGENT_SPACE_ID = "00000000-0000-4000-8000-0000000000bb";

const getAgentSpace = apiFixture<GetAgentSpaceCommandOutput>("GetAgentSpace").response;
const listAssetTypes = apiFixture<ListAssetTypesCommandOutput>("ListAssetTypes").response;
const listAssetsPage = apiFixture<ListAssetsCommandOutput>("ListAssets.page1").response;

function spaceRow(over: Partial<SpaceRow> = {}): SpaceRow {
  return {
    id: SPACE_ID,
    alias: "test-space",
    displayName: "Customer-Demo-Space",
    region: "us-west-2",
    accountId: "111122223333",
    agentSpaceId: AGENT_SPACE_ID,
    readRoleArn: null,
    writeRoleArn: null,
    externalId: null,
    awsProfile: null,
    historyRepoId: null,
    settings: {},
    connectionStatus: "unknown",
    connectionCheckedAt: null,
    connectionDetail: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

const agent = mockClient(DevOpsAgentClient);
const sts = mockClient(STSClient);

function mockHealthySpace() {
  agent.on(GetAgentSpaceCommand).resolves(getAgentSpace);
  agent.on(ListAssetTypesCommand).resolves(listAssetTypes);
  // The service honors maxResults: 1, so return the first fixture item and a next-page token.
  agent.on(ListAssetsCommand).resolves({ items: listAssetsPage.items?.slice(0, 1), nextToken: "redacted" });
}

function deps(row: SpaceRow | null, over: Partial<ConnectionTestDeps> = {}) {
  const saved: ConnectionResult[] = [];
  const d = {
    loadSpace: vi.fn(async () => row),
    saveResult: vi.fn(async (_id: string, r: ConnectionResult) => {
      saved.push(r);
    }),
    hasSynced: vi.fn(async () => false),
    requestSync: vi.fn(async () => "sync-run-1"),
    recordAuditEvent: vi.fn(async () => {}),
    now: () => new Date("2026-11-11T18:00:00.000Z"),
    ...over,
  } satisfies ConnectionTestDeps;
  return { d, saved };
}

beforeEach(() => resetAwsCachesForTests());
afterEach(() => {
  agent.reset();
  sts.reset();
});

describe("spaces.connection-test job", () => {
  it("is registered under its queue name without retries", () => {
    expect(connectionTestJob.name).toBe("spaces.connection-test");
    expect(connectionTestJob.options?.retryLimit).toBe(0);
    expect(jobs.map((j) => j.name)).toContain("spaces.connection-test");
  });

  it("runs the three read calls, stores the result and starts the registration sync", async () => {
    mockHealthySpace();
    const { d, saved } = deps(spaceRow());
    const ctx = testJobContext({ actor: { email: "admin@example.com" }, spaceId: SPACE_ID });

    const out = await runConnectionTest({ spaceId: SPACE_ID, reason: "registration" }, ctx, d);

    expect(out.status).toBe("ok");
    expect(agent.commandCalls(GetAgentSpaceCommand)[0]?.args[0].input).toEqual({ agentSpaceId: AGENT_SPACE_ID });
    expect(agent.commandCalls(ListAssetsCommand)[0]?.args[0].input).toEqual({ agentSpaceId: AGENT_SPACE_ID, maxResults: 1 });
    expect(saved[0]).toEqual({
      status: "ok",
      detail: {
        assetTypeIds: listAssetTypes.items!.map((t) => t.assetType),
        counts: { assetTypes: 9, sampledAssets: 1, moreAssets: true },
        externalIdCheck: "skipped",
      },
    });
    expect(d.saveResult).toHaveBeenCalledWith(SPACE_ID, saved[0], new Date("2026-11-11T18:00:00.000Z"));
    expect(d.requestSync).toHaveBeenCalledWith(SPACE_ID, { email: "admin@example.com" }, "registration");
    expect(out.syncRunId).toBe("sync-run-1");
    expect(sts.calls()).toHaveLength(0);
    expect(d.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "space.connection-test", spaceId: SPACE_ID, result: "ok" }),
    );
    expect(ctx.progressCalls.at(-1)?.[0]).toBe(1);
  });

  it("stores no asset content, only type IDs and counts", async () => {
    mockHealthySpace();
    const { d, saved } = deps(spaceRow());
    await runConnectionTest({ spaceId: SPACE_ID, reason: "manual" }, testJobContext(), d);
    const stored = JSON.stringify(saved[0]);
    expect(stored).not.toContain(listAssetsPage.items![0]!.assetId!);
    expect(stored).not.toContain("Customer-Demo-Space");
  });

  it("does not start another registration sync once the space has synced", async () => {
    mockHealthySpace();
    const { d } = deps(spaceRow({ connectionStatus: "ok" }), { hasSynced: vi.fn(async () => true) });
    const out = await runConnectionTest({ spaceId: SPACE_ID, reason: "manual" }, testJobContext(), d);
    expect(out.syncRunId).toBeNull();
    expect(d.requestSync).not.toHaveBeenCalled();
  });

  it("starts the registration sync on the first manual success after a failed registration test", async () => {
    mockHealthySpace();
    const { d } = deps(spaceRow({ connectionStatus: "failed" }));
    await runConnectionTest({ spaceId: SPACE_ID, reason: "manual" }, testJobContext(), d);
    expect(d.requestSync).toHaveBeenCalledWith(SPACE_ID, expect.anything(), "registration");
  });

  it("passes the external ID check when the roles refuse AssumeRole without it", async () => {
    mockHealthySpace();
    sts.on(AssumeRoleCommand).rejects(Object.assign(new Error("not authorized"), { name: "AccessDenied" }));
    const row = spaceRow({ readRoleArn: "arn:aws:iam::111122223333:role/DamRead", externalId: generateExternalId() });
    const { d, saved } = deps(row);
    const out = await runConnectionTest({ spaceId: SPACE_ID, reason: "registration" }, testJobContext(), d);
    expect(out.status).toBe("ok");
    expect(saved[0]?.detail.externalIdCheck).toBe("enforced");
    const assume = sts.commandCalls(AssumeRoleCommand);
    expect(assume).toHaveLength(1);
    expect(assume[0]?.args[0].input.ExternalId).toBeUndefined();
  });

  it("rejects registration when a role can be assumed without the external ID", async () => {
    mockHealthySpace();
    sts.on(AssumeRoleCommand).resolves({ Credentials: { AccessKeyId: "ASIAEXAMPLE", SecretAccessKey: "s", SessionToken: "t", Expiration: new Date() } });
    const row = spaceRow({ readRoleArn: "arn:aws:iam::111122223333:role/DamRead", externalId: generateExternalId() });
    const { d, saved } = deps(row);

    await expect(runConnectionTest({ spaceId: SPACE_ID, reason: "registration" }, testJobContext(), d)).rejects.toThrow(
      /Registration rejected at ExternalIdCheck/,
    );
    expect(saved[0]?.status).toBe("rejected");
    expect(saved[0]?.detail.error?.name).toBe("ExternalIdNotEnforced");
    expect(JSON.stringify(saved[0])).not.toContain("ASIAEXAMPLE");
    expect(d.requestSync).not.toHaveBeenCalled();
    expect(d.recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ result: "error" }));
  });

  it("records the failing step and only the error name and message", async () => {
    const err = Object.assign(new Error("User is not authorized to perform aidevops:GetAgentSpace"), {
      name: "AccessDeniedException",
      $metadata: { httpStatusCode: 403, requestId: "req-123" },
    });
    agent.on(GetAgentSpaceCommand).rejects(err);
    const { d, saved } = deps(spaceRow());

    await expect(runConnectionTest({ spaceId: SPACE_ID, reason: "registration" }, testJobContext(), d)).rejects.toThrow(
      /Connection test failed at GetAgentSpace: AccessDeniedException/,
    );
    expect(saved[0]).toEqual({
      status: "failed",
      detail: {
        failedStep: "GetAgentSpace",
        error: { name: "AccessDeniedException", message: "User is not authorized to perform aidevops:GetAgentSpace" },
      },
    });
    expect(agent.commandCalls(ListAssetsCommand)).toHaveLength(0);
    expect(d.requestSync).not.toHaveBeenCalled();
  });

  it("reports a ListAssets failure after the earlier steps succeeded", async () => {
    agent.on(GetAgentSpaceCommand).resolves(getAgentSpace);
    agent.on(ListAssetTypesCommand).resolves(listAssetTypes);
    agent.on(ListAssetsCommand).rejects(Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }));
    const { d, saved } = deps(spaceRow());
    await expect(runConnectionTest({ spaceId: SPACE_ID, reason: "manual" }, testJobContext(), d)).rejects.toThrow();
    expect(saved[0]?.detail.failedStep).toBe("ListAssets");
    expect(saved[0]?.detail.assetTypeIds).toHaveLength(9);
  });

  it("fails when GetAgentSpace answers for a different space", async () => {
    mockHealthySpace();
    agent.on(GetAgentSpaceCommand).resolves({ agentSpace: { ...getAgentSpace.agentSpace!, agentSpaceId: "other" } });
    const { d, saved } = deps(spaceRow());
    await expect(runConnectionTest({ spaceId: SPACE_ID, reason: "manual" }, testJobContext(), d)).rejects.toThrow(/AgentSpaceMismatch/);
    expect(saved[0]?.status).toBe("failed");
  });

  it("fails when the space was removed", async () => {
    const { d } = deps(null);
    await expect(runConnectionTest({ spaceId: SPACE_ID, reason: "manual" }, testJobContext(), d)).rejects.toThrow(/no longer exists/);
    expect(d.saveResult).not.toHaveBeenCalled();
  });
});
