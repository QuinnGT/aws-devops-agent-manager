import { describe, expect, it } from "vitest";
import { apiFixture } from "../../../test/helpers/fixtures";
import { compileGlob, globMatches } from "./glob";
import { principalFromUserIdentity } from "./identity";

describe("principalFromUserIdentity", () => {
  it("reads role and session from the captured console event", () => {
    const fx = apiFixture<{ Events: { CloudTrailEvent: string }[] }>("CloudTrail.LookupEvents.memory");
    const first = fx.response.Events[0];
    if (!first) throw new Error("fixture has no events");
    const detail = JSON.parse(first.CloudTrailEvent);
    expect(principalFromUserIdentity(detail.userIdentity)).toEqual({
      principal: "arn:aws:sts::111122223333:assumed-role/DevOpsAgentRole-WebappAdmin-examplesfx/AROAEXAMPLEMASKED0001-alex-Admin",
      roleName: "DevOpsAgentRole-WebappAdmin-examplesfx",
      sessionName: "AROAEXAMPLEMASKED0001-alex-Admin",
    });
  });

  it("falls back to the session issuer and principalId when the ARN is not an assumed-role ARN", () => {
    expect(
      principalFromUserIdentity({
        type: "AssumedRole",
        principalId: "AROAEXAMPLE:my-session",
        sessionContext: { sessionIssuer: { type: "Role", arn: "arn:aws:iam::111122223333:role/team/path/OpsRole", userName: "OpsRole" } },
      }),
    ).toEqual({ principal: "arn:aws:iam::111122223333:role/team/path/OpsRole", roleName: "OpsRole", sessionName: "my-session" });
  });

  it("handles IAM users, federated users, AWS services and garbage", () => {
    expect(principalFromUserIdentity({ type: "IAMUser", arn: "arn:aws:iam::111122223333:user/deploy-bot", userName: "deploy-bot" })).toEqual({
      principal: "arn:aws:iam::111122223333:user/deploy-bot",
      roleName: null,
      sessionName: null,
    });
    expect(principalFromUserIdentity({ type: "FederatedUser", arn: "arn:aws:sts::111122223333:federated-user/bob" })).toEqual({
      principal: "arn:aws:sts::111122223333:federated-user/bob",
      roleName: null,
      sessionName: "bob",
    });
    expect(principalFromUserIdentity({ type: "AWSService", invokedBy: "aidevops.amazonaws.com" })).toEqual({
      principal: "aidevops.amazonaws.com",
      roleName: null,
      sessionName: null,
    });
    expect(principalFromUserIdentity(null)).toEqual({ principal: null, roleName: null, sessionName: null });
    expect(principalFromUserIdentity("x")).toEqual({ principal: null, roleName: null, sessionName: null });
  });

  it("works in partitions other than aws", () => {
    expect(principalFromUserIdentity({ type: "AssumedRole", arn: "arn:aws-cn:sts::111122223333:assumed-role/R/s" })).toMatchObject({ roleName: "R", sessionName: "s" });
  });
});

describe("compileGlob", () => {
  it("anchors the pattern and treats * as the only wildcard", () => {
    const re = compileGlob("DevOpsAgentRole-WebappAdmin-*");
    expect(re.test("DevOpsAgentRole-WebappAdmin-examplesfx")).toBe(true);
    expect(re.test("DevOpsAgentRole-WebappAdmin-")).toBe(true);
    expect(re.test("xDevOpsAgentRole-WebappAdmin-w8")).toBe(false);
    expect(re.test("DevOpsAgentRole-WebappAdmin")).toBe(false);
  });

  it("escapes regex syntax in policy text", () => {
    expect(globMatches("a.b", "a.b")).toBe(true);
    expect(globMatches("a.b", "axb")).toBe(false);
    expect(globMatches("(a|b)+", "(a|b)+")).toBe(true);
    expect(globMatches("(a|b)+", "a")).toBe(false);
    expect(globMatches("[x]?{1}$^\\", "[x]?{1}$^\\")).toBe(true);
    expect(globMatches("arn:aws:sts::*:assumed-role/Ops/*", "arn:aws:sts::111122223333:assumed-role/Ops/me")).toBe(true);
    expect(globMatches("*", "")).toBe(true);
  });
});
