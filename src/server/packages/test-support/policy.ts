import path from "node:path";
import { env, resetEnvForTests } from "@/server/env";
import { loadPolicyFromDirs, resetPolicyCacheForTests } from "@/server/policy/loader";
import type { Policy } from "@/server/policy";

/**
 * The app's policy with the package test layouts (test-support/policy) merged
 * over it: `strict-instructions`, `strict-shared` and `strict-folders`, which
 * carry every kind of package check with invented names. The default policy
 * has none of those rules.
 */
export const TEST_POLICY_DIR = path.join(__dirname, "policy");

export function testPolicy(): Policy {
  return loadPolicyFromDirs([env().policyDir, TEST_POLICY_DIR]).policy;
}

/**
 * Add directories to the policy that services read (getAppPolicy and
 * getPolicyForRepo), through DAM_POLICY_OVERLAY_DIRS. Call it at the top of an
 * integration test, before the policy is first read, and call the function it
 * returns in afterAll.
 */
export function addOverlays(dirs: string[]): () => void {
  const before = process.env.DAM_POLICY_OVERLAY_DIRS;
  process.env.DAM_POLICY_OVERLAY_DIRS = dirs.join(path.delimiter);
  resetEnvForTests();
  resetPolicyCacheForTests();
  return () => {
    if (before === undefined) delete process.env.DAM_POLICY_OVERLAY_DIRS;
    else process.env.DAM_POLICY_OVERLAY_DIRS = before;
    resetEnvForTests();
    resetPolicyCacheForTests();
  };
}

/** The test layouts (strict-instructions, strict-shared, strict-folders) in the policy that services read. */
export const addTestLayouts = (): (() => void) => addOverlays([TEST_POLICY_DIR]);

/** The markers the build writes around the shared section of `instruction-folders-shared` and `strict-shared`. */
export const SHARED_BEGIN = "<!-- shared: common (edit instructions/shared/common.md, then rebuild the package) -->";
export const SHARED_END = "<!-- /shared: common -->";

/** The two safety responses `strict-shared` and `strict-folders` require, each on its own line. */
export const STRICT_SAFETY =
  "[ADVICE ONLY]: This agent gives advice. A person makes every change.\n" +
  "[NO SECRETS]: The request contains credentials and was not processed.\n";
