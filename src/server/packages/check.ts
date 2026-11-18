import { getAppPolicy, type Policy } from "@/server/policy";
import { validateAssetSet } from "@/server/validation/set";
import { hasErrors, type ValidationResult } from "@/server/validation/types";
import { buildRelease, type BuildResult } from "./build";
import { packageToDesiredAssets, type MappedPackage } from "./desired";
import { getLayout, type PackageLayout } from "./layout";
import { targetPackageAssets, type TargetedPackage } from "./target";
import { assetKeyOf, type DesiredAsset, type LiveAssetRef, type PackageContents } from "./types";

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

/** An asset a download leaves out because it, or an asset it needs, has errors. */
export interface FailingAsset {
  assetKey: string;
  /** Package path of the asset's main source file or folder */
  source: string | null;
  /** Its error messages, or which asset it needs that is left out */
  reasons: string[];
  /** Package files removed with it */
  paths: string[];
}

/**
 * The checked package without the assets the service would refuse, so a
 * download never fails. Each round leaves out every asset that a mapping,
 * targeting or asset-rule error names (by assetKey, by the file it is about,
 * or by the asset's source folder) and every asset with a required reference
 * to one of them (a memory and its store), then checks again. Errors from the
 * build and the package checks (layout conventions and the layout's text
 * rules, such as shared-section markers) leave nothing out: those files
 * upload as they are. Kept files keep their bytes; the build redoes the
 * indexes. Every error still in the package stays in `check.results`.
 */
export function withoutFailingAssets(first: PackageCheck, opts: CheckPackageOptions = {}): { check: PackageCheck; leftOut: FailingAsset[] } {
  const policy = opts.policy ?? getAppPolicy().policy;
  const { name } = first.build.contents;
  const files = new Map(first.build.contents.files);
  const leftOut: FailingAsset[] = [];
  const done = new Set<string>();
  let check = first;
  while (!check.ok) {
    const { assets, roles } = check.mapped;
    const bySource = new Map(assets.filter((a) => a.source).map((a) => [a.source!, assetKeyOf(a)]));
    const sourceOf = new Map(assets.map((a) => [assetKeyOf(a), a.source ?? null]));
    const packageChecks = new Set(check.build.results);
    const reasons = new Map<string, string[]>();
    for (const r of check.results) {
      if (r.level !== "error" || packageChecks.has(r)) continue;
      const key = r.assetKey ?? (r.path ? (roles.get(r.path)?.assetKey ?? bySource.get(r.path)) : undefined);
      if (key && !done.has(key)) reasons.set(key, [...(reasons.get(key) ?? []), r.message]);
    }
    // Only errors no asset owns are left (or owners already removed): nothing more to leave out.
    if (!reasons.size) break;
    for (let grew = true; grew; ) {
      grew = false;
      for (const a of assets) {
        const key = assetKeyOf(a);
        if (reasons.has(key) || done.has(key)) continue;
        const needs = requiredRefs(a, policy).find((k) => reasons.has(k));
        if (needs) {
          reasons.set(key, [`It needs ${sourceOf.get(needs) ?? needs}, which is left out.`]);
          grew = true;
        }
      }
    }
    for (const [key, why] of reasons) {
      const paths = [...roles].filter(([, role]) => role.assetKey === key).map(([p]) => p);
      for (const p of paths) files.delete(p);
      leftOut.push({ assetKey: key, source: sourceOf.get(key) ?? null, reasons: why, paths });
      done.add(key);
    }
    check = checkPackage({ name, files: new Map(files) }, { ...opts, policy });
  }
  return { check, leftOut };
}

/**
 * The note a download with errors carries: each asset left out and why, then
 * the errors still in the package. Messages hold package text, so each item
 * is one line.
 */
export function renderLeftOutNote(intro: string, leftOut: readonly FailingAsset[], remaining: readonly ValidationResult[], text: { title: string; none: string; remaining: string }): string {
  const line = (t: string) => t.replace(/\s+/g, " ").trim();
  const out = [text.title, "", intro, ""];
  if (leftOut.length) for (const a of leftOut) out.push(`- ${a.source ?? a.assetKey}: ${line(a.reasons.join(" "))}`);
  else out.push(text.none);
  if (remaining.length) out.push("", text.remaining, "", ...remaining.map((r) => `- ${r.path ? `${r.path}: ` : ""}${line(r.message)}`));
  return `${out.join("\n")}\n`;
}

/** Asset keys of the asset's required references (asset-types.yaml `references[].required`). */
function requiredRefs(a: DesiredAsset, policy: Policy): string[] {
  return (policy.assetTypes.assetTypes[a.assetType]?.references ?? [])
    .filter((r) => r.required)
    .flatMap((r) => {
      const v = a.refs?.[r.ref];
      return (v === undefined ? [] : Array.isArray(v) ? v : [v]).map((key) => assetKeyOf({ assetType: r.assetType, key }));
    });
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
