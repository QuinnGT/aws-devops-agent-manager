import { DevOpsAgentClient, GetAssetCommand, ListAssetTypesCommand, ListAssetVersionsCommand } from "@aws-sdk/client-devops-agent";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { apiFixture } from "../../../test/helpers/fixtures";
import { connectionNextStep, liveAssetTypes, liveAssetVersions, liveErrorMessage, liveErrorNeedsSettings, liveGetAsset, resetLiveCachesForTests, type LiveDeps } from "./live";

const aws = mockClient(DevOpsAgentClient);
const deps: LiveDeps = {
  client: new DevOpsAgentClient({ region: "us-west-2", credentials: { accessKeyId: "test", secretAccessKey: "test" } }),
  agentSpaceId: "00000000-0000-4000-8000-0000000000bb",
  spaceId: "space-1",
};

function named(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

beforeEach(() => {
  aws.reset();
  resetLiveCachesForTests();
});
afterAll(() => aws.restore());

describe("liveAssetTypes", () => {
  it("returns ListAssetTypes and reuses it per space within the cache window", async () => {
    aws.on(ListAssetTypesCommand).resolves(apiFixture("ListAssetTypes").response as never);
    const now = Date.now();
    const r = await liveAssetTypes(deps, now);
    expect(r.ok && r.value.map((t) => t.assetType)).toContain("artifact");
    await liveAssetTypes(deps, now + 10_000);
    expect(aws.commandCalls(ListAssetTypesCommand)).toHaveLength(1);
    await liveAssetTypes(deps, now + 301_000);
    expect(aws.commandCalls(ListAssetTypesCommand)).toHaveLength(2);
  });

  it("returns an error result and does not cache failures", async () => {
    aws.on(ListAssetTypesCommand).rejects(named("AccessDeniedException", "not authorized"));
    expect(await liveAssetTypes(deps)).toEqual({ ok: false, error: liveErrorMessage(named("AccessDeniedException", "not authorized")), notFound: false });
    await liveAssetTypes(deps);
    expect(aws.commandCalls(ListAssetTypesCommand)).toHaveLength(2);
  });
});

describe("liveGetAsset", () => {
  it("reads the current version through the read client", async () => {
    aws.on(GetAssetCommand).resolves(apiFixture("GetAsset.memory").response as never);
    const r = await liveGetAsset(deps, "ki-9184fa09-8e79-4a11-90fa-a6b81ab5fe6b");
    expect(r).toMatchObject({ ok: true, asset: { version: 24, updatedAt: "2026-11-10T23:38:13.000Z", metadata: { name: "overview" } } });
    expect(aws.commandCalls(GetAssetCommand)[0]!.args[0].input).toEqual({ agentSpaceId: deps.agentSpaceId, assetId: "ki-9184fa09-8e79-4a11-90fa-a6b81ab5fe6b" });
  });

  it("reports a missing asset as not found", async () => {
    aws.on(GetAssetCommand).rejects(named("ResourceNotFoundException", "Asset not found"));
    expect(await liveGetAsset(deps, "ki-x")).toMatchObject({ ok: false, notFound: true });
  });
});

describe("liveAssetVersions", () => {
  it("follows nextToken and sorts newest first", async () => {
    const items = apiFixture<{ items: { version: number }[] }>("ListAssetVersions.memory").response.items;
    aws
      .on(ListAssetVersionsCommand)
      .resolvesOnce({ items: items.slice(10), nextToken: "t1" } as never)
      .resolvesOnce({ items: items.slice(0, 10) } as never);
    const r = await liveAssetVersions(deps, "ki-9184fa09-8e79-4a11-90fa-a6b81ab5fe6b");
    expect(r.ok && r.value.map((v) => v.version)).toEqual(items.map((v) => v.version).sort((a, b) => b - a));
    const calls = aws.commandCalls(ListAssetVersionsCommand);
    expect(calls.map((c) => c.args[0].input.nextToken)).toEqual([undefined, "t1"]);
  });
});

describe("liveErrorMessage", () => {
  it("never shows an SDK error's own text, and collapses whitespace for other errors", () => {
    expect(liveErrorMessage(named("ValidationException", "bad\n  input"))).toBe("AWS refused the request as invalid.");
    expect(liveErrorMessage(new Error("plain"))).toBe("plain");
    expect(liveErrorMessage("text")).toBe("text");
  });

  it("turns known AWS failures into a sentence with a next step, by name or by message", () => {
    const creds = liveErrorMessage(named("CredentialsProviderError", "Could not load credentials from any providers"));
    expect(creds).toBe("This app has no AWS credentials for this space, so it can't reach AWS.");
    expect(liveErrorMessage("Could not load credentials from any providers")).toBe(creds);
    expect(liveErrorMessage(named("AccessDeniedException", "User is not authorized"))).toMatch(/refused the request/);
    expect(liveErrorMessage(named("ThrottlingException", "slow\n  down"))).toMatch(/limiting requests/);
    expect(liveErrorMessage(new Error("getaddrinfo ENOTFOUND dp.aidevops.us-west-2.api.aws"))).toMatch(/network request failed/);
  });

  it("leaves the role-specific next step to the page, and maps older stored sentences", () => {
    const creds = liveErrorMessage(named("CredentialsProviderError", "Could not load credentials from any providers"));
    expect(creds).not.toMatch(/Admin/);
    expect(liveErrorMessage("Can't reach the Agent Space: this app has no AWS credentials for it. An Admin can check the connection in Space settings")).toBe(creds);
    expect(liveErrorNeedsSettings(named("CredentialsProviderError", "x"))).toBe(true);
    expect(liveErrorNeedsSettings(creds)).toBe(true);
    expect(liveErrorNeedsSettings(named("AccessDeniedException", "User is not authorized"))).toBe(true);
    expect(liveErrorNeedsSettings(named("ThrottlingException", "slow down"))).toBe(false);
    expect(connectionNextStep({ canManage: true })).toBe("An Admin sets the connection in Space settings.");
    expect(connectionNextStep({ canManage: true, onSettingsPage: true })).toMatch(/^Enter an AWS profile or a read role ARN under Connection and roles/);
    expect(connectionNextStep({ canManage: false })).toBe("Ask an Admin to check the connection in Space settings.");
  });
});
