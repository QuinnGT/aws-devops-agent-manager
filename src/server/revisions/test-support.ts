import { packageFromFiles } from "@/server/packages/read";
import type { PackageContents } from "@/server/packages/types";

/**
 * Test support: a small synthetic package in the instruction-folders layout that
 * passes the build and the package checks of the test layout `strict-instructions`
 * (src/server/packages/test-support/policy). Only used by tests.
 */

export const SAFETY = [
  "[ADVICE ONLY]: This agent gives advice. A person makes every change.",
  "[NO SECRETS]: The request contains credentials and was not processed.",
] as const;

export const GLOBAL_MD = `# Global rules\n\n${SAFETY[0]}\n${SAFETY[1]}\n\nRecord precedents only as hypotheses.\n`;

export const PACKAGE_FILES: Record<string, string> = {
  "README.md": "# Test package\n",
  "instructions/global.md": GLOBAL_MD,
  "instructions/incident-triage.md": "# Triage\n\nTriage rules.\n",
  "skills/triage/SKILL.md": "---\nname: triage\ndescription: Triage steps\n---\nTriage body\n",
  "memory/runbooks/STORE.md": "---\nstore: runbooks\ndescription: Runbooks\nagent_types: Incident Triage, Incident RCA\n---\n\n# Runbooks\n",
  "memory/runbooks/failover.md": "---\nname: failover\ndescription: Database failover\n---\nFailover steps\n",
};

export function syntheticPackage(name = "test-package", overrides: Record<string, string | null> = {}): PackageContents {
  const files: Record<string, string> = { ...PACKAGE_FILES };
  for (const [p, v] of Object.entries(overrides)) {
    if (v === null) delete files[p];
    else files[p] = v;
  }
  return packageFromFiles(name, files);
}
