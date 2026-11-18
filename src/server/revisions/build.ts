import { checkPackage, renderLeftOutNote as renderNote, withoutFailingAssets, type FailingAsset, type PackageCheck } from "@/server/packages/check";
import { fillTemplate } from "@/server/history/layout";
import type { PackageLayout } from "@/server/packages/layout";
import type { LiveAssetRef, PackageContents } from "@/server/packages/types";
import type { Policy } from "@/server/policy";
import type { RevisionsPolicy } from "@/server/policy/sections/revisions";
import { errorsOf, warningsOf, type ValidationResult } from "@/server/validation/types";
import type { RevisionBuild } from "./types";

/**
 * The build and validation a revision runs on every save: checkPackage, which
 * builds the package (shared sections, memory indexes, skill zips,
 * VALIDATION.json) and adds the package checks, the layout mapping and the
 * asset rules against the live space.
 * When it fails, `leftOut` lists what "Export package zip" leaves out (the
 * download works it out again from the committed package).
 * Pure: the caller commits check.build.contents.
 */
export function runRevisionBuild(contents: PackageContents, opts: { policy: Policy; layout: PackageLayout; live: readonly LiveAssetRef[] }): RevisionCheck {
  const o = { policy: opts.policy, layout: opts.layout, live: opts.live };
  const check = checkPackage(contents, o);
  return { ...check, leftOut: check.ok ? [] : withoutFailingAssets(check, o).leftOut };
}

export type RevisionCheck = PackageCheck & { leftOut?: FailingAsset[] };

/** The stored build result of a commit. `extra` results (export placement) come first. */
export function toRevisionBuild(check: RevisionCheck, commit: string, opts: { maxResults: number; now?: Date; extra?: readonly ValidationResult[] }): RevisionBuild {
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
    ...(check.leftOut ? { leftOut: check.leftOut.slice(0, opts.maxResults).map(({ assetKey, source, reasons }) => ({ assetKey, source, reasons })) } : {}),
  };
}

/** True when the stored build is for the branch head and passed. */
export function buildPassedAtHead(build: RevisionBuild | null | undefined, headCommit: string | null): boolean {
  return Boolean(build && headCommit && build.commit === headCommit && build.status === "passed");
}

/** The note a revision download with build errors carries (revisions.yaml export.leftOut). */
export function renderLeftOutNote(name: string, leftOut: readonly FailingAsset[], remaining: readonly ValidationResult[], note: RevisionsPolicy["export"]["leftOut"]): string {
  return renderNote(fillTemplate(note.intro, { name }), leftOut, remaining, note);
}
