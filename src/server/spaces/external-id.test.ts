import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";
import type { SpaceAwsConfig } from "@/server/aws/clients";
import { checkExternalIdEnforced, generateExternalId, isGeneratedExternalId, spaceRoleArns } from "./external-id";

const READ = "arn:aws:iam::111122223333:role/DamRead";
const WRITE = "arn:aws:iam::111122223333:role/DamWrite";

function space(over: Partial<SpaceAwsConfig> = {}): SpaceAwsConfig {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    alias: "test-space",
    region: "us-west-2",
    accountId: "111122223333",
    agentSpaceId: "00000000-0000-4000-8000-0000000000bb",
    readRoleArn: READ,
    writeRoleArn: WRITE,
    externalId: generateExternalId(),
    awsProfile: null,
    ...over,
  };
}

function accessDenied(): Error {
  return Object.assign(new Error("User is not authorized to perform: sts:AssumeRole"), { name: "AccessDenied" });
}

const sts = mockClient(STSClient);
afterEach(() => sts.reset());

describe("generateExternalId", () => {
  it("returns a prefixed 48-hex-digit value that STS accepts", () => {
    const id = generateExternalId();
    expect(id).toMatch(/^dam-[0-9a-f]{48}$/);
    expect(isGeneratedExternalId(id)).toBe(true);
    expect(id.length).toBeLessThanOrEqual(1224);
    expect(id).toMatch(/^[\w+=,.@:/-]{2,1224}$/);
  });

  it("is random", () => {
    const ids = new Set(Array.from({ length: 200 }, generateExternalId));
    expect(ids.size).toBe(200);
  });
});

describe("spaceRoleArns", () => {
  it("lists distinct configured roles", () => {
    expect(spaceRoleArns({ readRoleArn: READ, writeRoleArn: READ })).toEqual([READ]);
    expect(spaceRoleArns({ readRoleArn: null, writeRoleArn: null })).toEqual([]);
  });
});

describe("checkExternalIdEnforced", () => {
  it("skips spaces without roles (local mode)", async () => {
    const r = await checkExternalIdEnforced(space({ readRoleArn: null, writeRoleArn: null }), { email: "a@example.com" }, new STSClient({}));
    expect(r).toEqual({ status: "skipped", reason: "no-roles" });
    expect(sts.calls()).toHaveLength(0);
  });

  it("skips spaces with roles but no external ID", async () => {
    const r = await checkExternalIdEnforced(space({ externalId: null }), { email: "a@example.com" }, new STSClient({}));
    expect(r).toEqual({ status: "skipped", reason: "no-external-id" });
  });

  it("passes when every role refuses AssumeRole without the external ID", async () => {
    sts.on(AssumeRoleCommand).rejects(accessDenied());
    const r = await checkExternalIdEnforced(space(), { email: "a@example.com" }, new STSClient({ region: "us-west-2" }));
    expect(r).toEqual({ status: "enforced", roles: [READ, WRITE] });
    const calls = sts.commandCalls(AssumeRoleCommand);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.args[0].input.ExternalId).toBeUndefined();
      expect(c.args[0].input.SourceIdentity).toBe("a@example.com");
    }
  });

  it("fails when a role can be assumed without the external ID", async () => {
    sts
      .on(AssumeRoleCommand, { RoleArn: READ })
      .resolves({ Credentials: { AccessKeyId: "ASIAEXAMPLE", SecretAccessKey: "x", SessionToken: "y", Expiration: new Date() } });
    sts.on(AssumeRoleCommand, { RoleArn: WRITE }).rejects(accessDenied());
    const r = await checkExternalIdEnforced(space(), { email: "a@example.com" }, new STSClient({ region: "us-west-2" }));
    expect(r).toEqual({ status: "not-enforced", roles: [READ] });
    expect(JSON.stringify(r)).not.toContain("ASIAEXAMPLE");
  });

  it("reports other errors instead of guessing", async () => {
    sts.on(AssumeRoleCommand).rejects(Object.assign(new Error("The security token included in the request is invalid"), { name: "InvalidClientTokenId" }));
    const r = await checkExternalIdEnforced(space(), { email: "a@example.com" }, new STSClient({ region: "us-west-2" }));
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.error.name).toBe("InvalidClientTokenId");
  });
});
