import { checkPackage, type PackageCheck } from "@/server/packages/check";
import type { PackageLayout } from "@/server/packages/layout";
import type { LiveAssetRef, PackageContents } from "@/server/packages/types";
import type { Policy } from "@/server/policy";
import { errorsOf, warningsOf, type ValidationResult } from "@/server/validation/types";
import type { RevisionBuild } from "./types";

/**
 * The build and validation a revision runs on every save: checkPackage, which
 * builds the package (shared sections, memory indexes, skill zips,
 * VALIDATION.json) and adds the package checks, the layout mapping and the
 * asset rules against the live space.
 * Pure: the caller commits check.build.contents.
 */
export function runRevisionBuild(contents: PackageContents, opts: { policy: Policy; layout: PackageLayout; live: readonly LiveAssetRef[] }): PackageCheck {
  return checkPackage(contents, { policy: opts.policy, layout: opts.layout, live: opts.live });
}

/** The stored build result of a commit. `extra` results (export placement) come first. */
export function toRevisionBuild(check: PackageCheck, commit: string, opts: { maxResults: number; now?: Date; extra?: readonly ValidationResult[] }): RevisionBuild {
  const all = [...(opts.extra ?? []), ...check.results];
  return {
    status: check.ok ? "passed" : "failed",
    commit,
    ranAt: (opts.now ?? new Date()).toISOString(),
    errors: errorsOf(all).length,
    warnings: warningsOf(all).length,
    // Errors first, so the cap never hides an error behind warnings.
    results: [...errorsOf(all), ...warningsOf(all)].slice(0, opts.maxResults),
    omitted: Math.max(0, all.length - opts.maxResults),
    validation: check.build.validation.summary ?? null,
    buildPaths: check.build.changes.map((c) => c.path),
    assets: check.mapped.assets.length,
  };
}

/** True when the stored build is for the branch head and passed. */
export function buildPassedAtHead(build: RevisionBuild | null | undefined, headCommit: string | null): boolean {
  return Boolean(build && headCommit && build.commit === headCommit && build.status === "passed");
}
