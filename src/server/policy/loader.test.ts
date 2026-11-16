import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvForTests } from "@/server/env";
import { deepMerge, getAppPolicy, getPolicyForRepo, loadPolicyFromDirs, PolicyError, readPolicyFile, resetPolicyCacheForTests } from "./loader";

const APP_POLICY = path.resolve(__dirname, "../../../policy");

describe("policy loader", () => {
  it("loads and validates the app's default policy", () => {
    const { policy, digest } = getAppPolicy();
    expect(Object.keys(policy.roles.roles)).toEqual(["viewer", "editor", "publisher", "admin"]);
    expect(policy.historyLayout.assetDirs.memory).toBe("memory/{storeName}/{name}");
    expect(policy.agentTypes.agentTypes[0]?.id).toBe("GENERIC");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("overlays a customer policy dir, deep-merging objects and replacing arrays", () => {
    const over = mkdtempSync(path.join(tmpdir(), "dam-policy-"));
    writeFileSync(path.join(over, "sync.yaml"), "intervalMinutes: 5\nstoreCommitPolicies: { monitors: daily }\n");
    const { policy } = loadPolicyFromDirs([APP_POLICY, over]);
    expect(policy.sync.intervalMinutes).toBe(5);
    expect(policy.sync.storeCommitPolicies).toEqual({ monitors: "daily" });
    expect(policy.sync.defaultStoreCommitPolicy).toBe("every-version");
  });

  it("rejects the whole load when a section is invalid", () => {
    const over = mkdtempSync(path.join(tmpdir(), "dam-policy-"));
    writeFileSync(path.join(over, "api.yaml"), "maxAttempts: 0\n");
    expect(() => loadPolicyFromDirs([APP_POLICY, over])).toThrow(PolicyError);
  });

  it("deepMerge replaces arrays and scalars", () => {
    expect(deepMerge({ a: [1, 2], b: { c: 1, d: 2 } }, { a: [3], b: { d: 9 } })).toEqual({ a: [3], b: { c: 1, d: 9 } });
  });
});

describe("policy overlay directories (DAM_POLICY_OVERLAY_DIRS)", () => {
  const dir = (files: Record<string, string>) => {
    const d = mkdtempSync(path.join(tmpdir(), "dam-overlay-"));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(d, name)), { recursive: true });
      writeFileSync(path.join(d, name), text);
    }
    return d;
  };
  const useOverlays = (dirs: string[]) => {
    resetEnvForTests({ ...process.env, DAM_POLICY_DIR: APP_POLICY, DAM_POLICY_OVERLAY_DIRS: dirs.join(path.delimiter) });
    resetPolicyCacheForTests();
  };

  afterEach(() => {
    vi.restoreAllMocks();
    resetEnvForTests();
    resetPolicyCacheForTests();
  });

  it("leaves the app policy as it is when the setting is empty", () => {
    useOverlays([]);
    const loaded = getAppPolicy();
    expect(loaded.dirs).toEqual([APP_POLICY]);
    expect(loaded.digest).toBe(loadPolicyFromDirs([APP_POLICY]).digest);
  });

  it("merges the overlays over the defaults in the order listed, and folds them into the digest", () => {
    const first = dir({ "sync.yaml": "intervalMinutes: 5\nlockWaitSeconds: 7\n" });
    const second = dir({ "sync.yaml": "intervalMinutes: 9\n" });
    useOverlays([first, second]);
    const loaded = getAppPolicy();
    expect(loaded.dirs).toEqual([APP_POLICY, first, second]);
    expect(loaded.policy.sync.intervalMinutes).toBe(9);
    expect(loaded.policy.sync.lockWaitSeconds).toBe(7);
    expect(loaded.digest).toBe(loadPolicyFromDirs([APP_POLICY, first, second]).digest);
    expect(loaded.digest).not.toBe(loadPolicyFromDirs([APP_POLICY]).digest);

    useOverlays([second, first]);
    const swapped = getAppPolicy();
    expect(swapped.policy.sync.intervalMinutes).toBe(5);
    expect(swapped.digest).not.toBe(loaded.digest);
  });

  it("puts a history repository's policy/ directory after the overlays", () => {
    const overlay = dir({ "sync.yaml": "intervalMinutes: 5\nlockWaitSeconds: 7\n" });
    const repo = dir({ "policy/sync.yaml": "intervalMinutes: 11\n" });
    useOverlays([overlay]);
    const loaded = getPolicyForRepo(repo);
    expect(loaded.dirs).toEqual([APP_POLICY, overlay, path.join(repo, "policy")]);
    expect(loaded.policy.sync.intervalMinutes).toBe(11);
    expect(loaded.policy.sync.lockWaitSeconds).toBe(7);
    expect(getPolicyForRepo(null)).toBe(getAppPolicy());
  });

  it("lets readPolicyFile find an overlay's prompt and schema files, later directories first", () => {
    const first = dir({ "prompts/reviewer-system.md": "first", "extra/only-first.md": "only first" });
    const second = dir({ "prompts/reviewer-system.md": "second" });
    useOverlays([first, second]);
    const { dirs } = getAppPolicy();
    expect(readPolicyFile(dirs, "prompts/reviewer-system.md")).toBe("second");
    expect(readPolicyFile(dirs, "extra/only-first.md")).toBe("only first");
    expect(readPolicyFile(dirs, "prompts/reviewer-final-step.md")).not.toBeNull();
    expect(readPolicyFile(dirs, "extra/nothing.md")).toBeNull();
  });

  it("ignores a missing overlay and warns once per process for each one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const real = dir({ "sync.yaml": "intervalMinutes: 5\n" });
    const missing = path.join(tmpdir(), "dam-overlay-does-not-exist");
    useOverlays([missing, real]);
    const loaded = getAppPolicy();
    expect(loaded.dirs).toEqual([APP_POLICY, real]);
    expect(loaded.policy.sync.intervalMinutes).toBe(5);
    getPolicyForRepo(dir({}));
    getPolicyForRepo(dir({}));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(missing);
  });
});
