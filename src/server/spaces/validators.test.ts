import { describe, expect, it } from "vitest";
import {
  accountIdSchema,
  agentSpaceIdSchema,
  aliasSchema,
  awsProfileSchema,
  bindingInputSchema,
  branchSchema,
  deployKeyFileSchema,
  fieldErrors,
  historyRepoFieldsSchema,
  isAllowedRemoteUrl,
  isValidBranchName,
  regionSchema,
  registerSpaceSchema,
  roleArnAccount,
  roleArnSchema,
} from "./validators";

const base = {
  alias: "test-space",
  displayName: "Test space",
  region: "us-west-2",
  accountId: "111122223333",
  agentSpaceId: "00000000-0000-4000-8000-0000000000bb",
  readRoleArn: "",
  writeRoleArn: "",
  awsProfile: "",
  historyRepo: { mode: "existing", id: "7d3c6a1e-5b0f-4a4e-9a51-2f8c1d0e9b11" },
};

describe("format validators", () => {
  it.each(["abc", "test-space", "anycompany-prod-1", "a1b"])("accepts alias %s", (a) => {
    expect(aliasSchema.safeParse(a).success).toBe(true);
  });

  it.each(["ab", "-abc", "abc-", "Test", "has space", "a_b", "x".repeat(41), "new"])("rejects alias %s", (a) => {
    expect(aliasSchema.safeParse(a).success).toBe(false);
  });

  it.each(["us-west-2", "ap-northeast-2", "us-gov-west-1", "eu-central-1", "il-central-1"])("accepts Region %s", (r) => {
    expect(regionSchema.safeParse(r).success).toBe(true);
  });

  it.each(["us-west", "US-WEST-2", "uswest2", "us-west-2a", ""])("rejects Region %s", (r) => {
    expect(regionSchema.safeParse(r).success).toBe(false);
  });

  it("accepts only 12-digit account IDs", () => {
    expect(accountIdSchema.safeParse("111122223333").success).toBe(true);
    expect(accountIdSchema.safeParse(" 111122223333 ").success).toBe(true);
    expect(accountIdSchema.safeParse("11112222333").success).toBe(false);
    expect(accountIdSchema.safeParse("1111-2222-3333").success).toBe(false);
  });

  it("accepts Agent Space IDs and rejects other characters", () => {
    expect(agentSpaceIdSchema.safeParse("00000000-0000-4000-8000-0000000000bb").success).toBe(true);
    expect(agentSpaceIdSchema.safeParse("../etc").success).toBe(false);
    expect(agentSpaceIdSchema.safeParse("").success).toBe(false);
  });

  it("validates IAM role ARNs and reads their account", () => {
    const arn = "arn:aws:iam::111122223333:role/service-role/DevOpsAgentManagerRead";
    expect(roleArnSchema.safeParse(arn).success).toBe(true);
    expect(roleArnSchema.safeParse("arn:aws-us-gov:iam::111122223333:role/Read").success).toBe(true);
    expect(roleArnAccount(arn)).toBe("111122223333");
    expect(roleArnSchema.safeParse("arn:aws:iam::111122223333:user/alice").success).toBe(false);
    expect(roleArnSchema.safeParse("arn:aws:iam::1111:role/Read").success).toBe(false);
    expect(roleArnSchema.safeParse("arn:aws:sts::111122223333:assumed-role/Read/x").success).toBe(false);
    expect(roleArnAccount("not an arn")).toBeNull();
  });

  it("accepts profile names and rejects access keys", () => {
    expect(awsProfileSchema.parse("anycompany-poc")).toBe("anycompany-poc");
    expect(awsProfileSchema.parse("")).toBeNull();
    expect(awsProfileSchema.safeParse("AKIAIOSFODNN7EXAMPLE").success).toBe(false);
    expect(awsProfileSchema.safeParse("name with space").success).toBe(false);
  });
});

describe("history repository fields", () => {
  it.each([
    "git@github.com:example-org/anycompany-agent-history.git",
    "https://github.com/example-org/anycompany-agent-history.git",
    "ssh://git@github.com/example-org/repo.git",
  ])("accepts remote %s", (u) => {
    expect(isAllowedRemoteUrl(u)).toBe(true);
  });

  it.each([
    "https://ghp_token@github.com/owner/repo.git",
    "https://user:pass@github.com/owner/repo.git",
    "http://github.com/owner/repo.git",
    "file:///tmp/repo",
    "/tmp/repo",
    "https://github.com/owner/repo.git?token=x",
  ])("rejects remote %s", (u) => {
    expect(isAllowedRemoteUrl(u)).toBe(false);
  });

  it("accepts a deploy key path and rejects key content or relative paths", () => {
    expect(deployKeyFileSchema.parse("/run/secrets/history_deploy_key")).toBe("/run/secrets/history_deploy_key");
    expect(deployKeyFileSchema.parse(" ")).toBeNull();
    expect(deployKeyFileSchema.safeParse("keys/id_ed25519").success).toBe(false);
    expect(deployKeyFileSchema.safeParse("/run/../etc/shadow").success).toBe(false);
    expect(deployKeyFileSchema.safeParse("-----BEGIN OPENSSH PRIVATE KEY-----").success).toBe(false);
  });

  it("defaults push to off and requires a remote and key to push", () => {
    expect(historyRepoFieldsSchema.parse({ name: "test-history" })).toEqual({
      name: "test-history",
      remoteUrl: null,
      deployKeyFile: null,
      defaultBranch: "main",
      pushEnabled: false,
    });
    const r = historyRepoFieldsSchema.safeParse({ name: "x", pushEnabled: "on" });
    expect(r.success).toBe(false);
    if (!r.success) expect(Object.keys(fieldErrors(r.error)).sort()).toEqual(["deployKeyFile", "remoteUrl"]);
  });
});

describe("branch names", () => {
  it("accepts ordinary branch names and defaults a blank one to main", () => {
    for (const b of ["main", "history/test", "release-1.2", "feature_x"]) expect(isValidBranchName(b)).toBe(true);
    expect(branchSchema.parse("")).toBe("main");
    expect(branchSchema.parse(undefined)).toBe("main");
    expect(branchSchema.parse(" history/test ")).toBe("history/test");
  });

  it("rejects names git refuses or that could be read as options", () => {
    for (const b of ["-main", "/main", "main/", "main.", "a..b", "a//b", ".hidden", "a/.b", "x.lock", "a/x.lock/b", "has space", "a:b", "a~1", "a^", "a?", "a*", "a[b", "a\\b", "@{u}", "x".repeat(101)]) {
      expect(isValidBranchName(b), b).toBe(false);
    }
    const r = historyRepoFieldsSchema.safeParse({ name: "x", defaultBranch: "bad branch" });
    expect(r.success).toBe(false);
    if (!r.success) expect(Object.keys(fieldErrors(r.error))).toEqual(["defaultBranch"]);
  });
});

describe("registerSpaceSchema", () => {
  it("normalizes blanks to null in local mode", () => {
    const r = registerSpaceSchema.parse(base);
    expect(r.readRoleArn).toBeNull();
    expect(r.awsProfile).toBeNull();
    expect(r.historyRepo).toEqual(base.historyRepo);
  });

  it("requires role ARNs in the space's account", () => {
    const r = registerSpaceSchema.safeParse({ ...base, readRoleArn: "arn:aws:iam::444455556666:role/Read" });
    expect(r.success).toBe(false);
    if (!r.success) expect(fieldErrors(r.error).readRoleArn).toMatch(/111122223333/);
  });

  it("requires a read role when a write role is set", () => {
    const r = registerSpaceSchema.safeParse({ ...base, writeRoleArn: "arn:aws:iam::111122223333:role/Write" });
    expect(r.success).toBe(false);
    if (!r.success) expect(fieldErrors(r.error).readRoleArn).toBeDefined();
  });

  it("accepts a new history repository", () => {
    const r = registerSpaceSchema.parse({ ...base, historyRepo: { mode: "new", repo: { name: "test-space-history", pushEnabled: false } } });
    expect(r.historyRepo).toEqual({
      mode: "new",
      repo: { name: "test-space-history", remoteUrl: null, deployKeyFile: null, defaultBranch: "main", pushEnabled: false },
    });
  });
});

describe("bindingInputSchema", () => {
  it("lowercases user emails", () => {
    expect(bindingInputSchema.parse({ spaceId: "", subjectType: "user", subject: " Alice@Example.com ", role: "viewer" })).toEqual({
      spaceId: null,
      subjectType: "user",
      subject: "alice@example.com",
      role: "viewer",
    });
  });

  it("rejects a user subject that is not an email", () => {
    const r = bindingInputSchema.safeParse({ spaceId: "", subjectType: "user", subject: "alice", role: "viewer" });
    expect(r.success).toBe(false);
  });

  it("keeps group names as given", () => {
    const r = bindingInputSchema.parse({ spaceId: "", subjectType: "group", subject: "DevOps-Admins", role: "admin" });
    expect(r.subject).toBe("DevOps-Admins");
  });
});
