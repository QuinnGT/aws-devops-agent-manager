import { getAppPolicy, type Policy } from "@/server/policy";
import { validateAssetSet } from "@/server/validation/set";
import { hasErrors, type ValidationResult } from "@/server/validation/types";
import { buildRelease, type BuildResult } from "./build";
import { packageToDesiredAssets, type MappedPackage } from "./desired";
import { getLayout, type PackageLayout } from "./layout";
import { targetPackageAssets, type TargetedPackage } from "./target";
import type { LiveAssetRef, PackageContents } from "./types";

export interface CheckPackageOptions {
  policy?: Policy;
  layout?: PackageLayout | string;
  /** The space the package will be applied to (references, counts, unique names, source asset IDs) */
  live?: readonly LiveAssetRef[];
  /**
   * Asset types to check and plan; null or undefined: every type. Results
   * about the other types' assets and files are left out, so they don't
   * block the rest.
   */
  includeTypes?: readonly string[] | null;
}

export interface PackageCheck {
  /** No errors from the build, the package checks, the mapping or the asset rules */
  ok: boolean;
  build: BuildResult;
  /** Desired assets from the built package */
  mapped: MappedPackage;
  /** The mapped assets aimed at the space: source IDs, type selection, duplicates, remapped references (targetPackageAssets) */
  target: TargetedPackage;
  /** Every result: build and package checks, mapping, targeting, then asset and set rules */
  results: ValidationResult[];
}

/**
 * Everything a revision save or a package import runs: the build (shared
 * sections, indexes, skill zips), the package checks, the layout mapping,
 * targeting the space, and the asset rules against it. Pure; nothing is
 * written.
 */
export function checkPackage(contents: PackageContents, opts: CheckPackageOptions = {}): PackageCheck {
  const policy = opts.policy ?? getAppPolicy().policy;
  const layout = typeof opts.layout === "object" ? opts.layout : getLayout(policy, opts.layout);
  const build = buildRelease(contents, layout, { zipLimits: policy.limits.packageRead, packageZip: false });
  const mapped = packageToDesiredAssets(build.contents, layout, { policy });
  const target = targetPackageAssets(mapped.assets, { policy, layout, live: opts.live, includeTypes: opts.includeTypes });
  const kept = opts.includeTypes ? new Set(opts.includeTypes) : null;
  const relevant = kept ? (r: ValidationResult) => isAbout(r, mapped, layout, kept) : () => true;
  const results = [...build.results.filter(relevant), ...mapped.results.filter(relevant), ...target.results, ...validateAssetSet(target.assets, { policy, live: opts.live })];
  return { ok: !hasErrors(results), build, mapped, target, results };
}

/**
 * Whether a build, package or mapping result concerns a selected type: the
 * type of the asset it names, of the asset its file belongs to, or of the
 * type folders its path is in. Results about no type (the whole package) are
 * always kept.
 */
export function isAbout(r: ValidationResult, mapped: Pick<MappedPackage, "roles">, layout: PackageLayout, selected: ReadonlySet<string>): boolean {
  const types = resultTypes(r, mapped, layout);
  return types.length === 0 || types.some((t) => selected.has(t));
}

function resultTypes(r: ValidationResult, mapped: Pick<MappedPackage, "roles">, layout: PackageLayout): string[] {
  const typeOf = (assetKey: string) => assetKey.slice(0, assetKey.indexOf(":"));
  if (r.assetKey) return [typeOf(r.assetKey)];
  if (!r.path) return [];
  const owner = mapped.roles.get(r.path)?.assetKey;
  if (owner) return [typeOf(owner)];
  const dirs: [string, string][] = [];
  if (layout.instructions) dirs.push([layout.instructions.dir, "agents_md"]);
  if (layout.skills) dirs.push([layout.skills.dir, "skill"]);
  if (layout.memory) dirs.push([layout.memory.dir, "memory_store"], [layout.memory.dir, "memory"]);
  if (layout.customAgents) dirs.push([layout.customAgents.dir, "custom_agent"]);
  for (const [t, rule] of Object.entries(layout.assetFolders?.types ?? {})) dirs.push([rule.dir, t]);
  return dirs.filter(([dir]) => r.path === dir || r.path!.startsWith(`${dir}/`)).map(([, t]) => t);
}
