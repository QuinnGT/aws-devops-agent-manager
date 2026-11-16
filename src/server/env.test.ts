import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeStartup, env, resetEnvForTests } from "./env";

function withEnv(vars: Record<string, string>) {
  resetEnvForTests({ ...vars } as NodeJS.ProcessEnv);
  return env();
}

describe("startup safety", () => {
  it("allows the dev bypass on loopback", () => {
    expect(() => assertSafeStartup(withEnv({ AUTH_DEV_BYPASS: "true", DAM_HOST: "127.0.0.1" }))).not.toThrow();
  });

  it("refuses the dev bypass on a non-loopback bind", () => {
    expect(() => assertSafeStartup(withEnv({ AUTH_DEV_BYPASS: "true", DAM_HOST: "0.0.0.0" }))).toThrow(/AUTH_DEV_BYPASS/);
  });

  it("allows the bypass in a container published to loopback only", () => {
    expect(() =>
      assertSafeStartup(withEnv({ AUTH_DEV_BYPASS: "true", DAM_HOST: "0.0.0.0", DAM_LOOPBACK_PUBLISH_ONLY: "true" })),
    ).not.toThrow();
  });

  it("defaults to loopback and no sign-in (fails closed)", () => {
    const e = withEnv({});
    expect(e.host).toBe("127.0.0.1");
    expect(e.devBypass).toBe(false);
    expect(e.oidc).toBeNull();
  });
});

describe("policy directories", () => {
  it("has no overlay directories unless DAM_POLICY_OVERLAY_DIRS is set", () => {
    expect(withEnv({}).policyOverlayDirs).toEqual([]);
    expect(withEnv({ DAM_POLICY_OVERLAY_DIRS: "" }).policyOverlayDirs).toEqual([]);
  });

  it("splits DAM_POLICY_OVERLAY_DIRS on the path delimiter and resolves each directory", () => {
    const list = ["/srv/policy-a", "", "relative/policy-b", " /srv/with space/policy-c "].join(path.delimiter);
    expect(withEnv({ DAM_POLICY_OVERLAY_DIRS: list }).policyOverlayDirs).toEqual(["/srv/policy-a", path.resolve("relative/policy-b"), "/srv/with space/policy-c"]);
  });
});
