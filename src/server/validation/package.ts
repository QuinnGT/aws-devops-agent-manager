import { findAssetMainFile } from "@/server/packages/asset-folders";
import { pythonFrontmatter } from "@/server/packages/frontmatter";
import { sharedSections, type PackageLayout } from "@/server/packages/layout";
import { basename, dirname, fill, matchesGlob, resolveRelative, sortPaths } from "@/server/packages/paths";
import { pythonReadText } from "@/server/packages/text";
import type { PackageContents } from "@/server/packages/types";
import { readZip, type ZipReadLimits } from "@/server/packages/zip";
import { error, warning, type ValidationResult } from "./types";

/**
 * Package checks. The rules and thresholds come from the layout's `checks` and
 * `sharedSections`; the check order and the summary shape follow a Python
 * validation script, so the build can write the same reference/VALIDATION.json.
 *
 * Differences from such a script, all stricter: a skill zip must match every
 * file of its folder (not only SKILL.md); zip entries are read with the same
 * safety rules as package uploads; problems a script would stop on (missing
 * frontmatter or files) are reported as errors instead.
 */

export interface PackageValidationSummary {
  status: "passed" | "failed";
  instruction_files: number;
  skills: number;
  stores: number;
  memories: number;
  largest_memory_bytes: number;
  largest_index_bytes: number;
  /** One line per error, in the wording of the Python validation script, with package-relative paths */
  errors: string[];
  scope: string;
}

export interface PackageValidation {
  status: "passed" | "failed";
  results: ValidationResult[];
  summary: PackageValidationSummary;
}

export interface ValidatePackageOptions {
  /** Missing skill zips are errors (default: layout.checks.requireArchives) */
  requireArchives?: boolean;
  /** Caps for reading skill zips */
  zipLimits: ZipReadLimits;
}

const LINK = /\]\(([^)]+)\)/g;

export function validatePackage(contents: PackageContents, layout: PackageLayout, opts: ValidatePackageOptions): PackageValidation {
  const files = contents.files;
  const checks = layout.checks;
  const requireArchives = opts.requireArchives ?? checks.requireArchives;
  const results: ValidationResult[] = [];
  const lines: string[] = [];
  const fail = (code: string, message: string, pyLine: string, path?: string) => {
    results.push(error(code, message, path ? { path } : {}));
    lines.push(pyLine);
  };
  const text = (p: string) => pythonReadText(files.get(p)!);
  const size = (p: string) => files.get(p)!.length;
  const all = [...files.keys()];

  // Skills
  const skillsDir = layout.skills?.dir;
  const skillMains = layout.skills ? sortPaths(all.filter((p) => isChild(p, skillsDir!, 2) && basename(p) === layout.skills!.mainFile)) : [];
  for (const main of skillMains) {
    const folder = dirname(main);
    const name = basename(folder);
    const fm = pythonFrontmatter(text(main));
    if (!fm) {
      fail("package.frontmatter-missing", `${main} has no frontmatter block.`, `Missing frontmatter: ${main}`, main);
      continue;
    }
    if (fm.name !== name || !fm.description) {
      fail(
        "package.skill-identity",
        `The frontmatter in ${main} needs name: ${name} (the folder name) and a description.`,
        `Skill identity/description: ${main}`,
        main,
      );
    }
    if (!fullMatch(checks.skillNamePattern, fm.name ?? "")) {
      fail("package.skill-name", `Skill name ${JSON.stringify(fm.name ?? "")} in ${main} doesn't match ${checks.skillNamePattern}.`, `Invalid skill name: ${main}`, main);
    }
    const archive = layout.skills!.archive ? `${skillsDir}/${fill(layout.skills!.archive, { name })}` : null;
    if (!archive) continue;
    if (!files.has(archive)) {
      if (requireArchives) fail("package.archive-missing", `${archive} is missing. Run the package build to create it.`, `Missing skill ZIP: ${archive}`, archive);
      continue;
    }
    const { entries, problems } = readZip(files.get(archive)!, opts.zipLimits, archive);
    if (problems.length) {
      fail("package.unsafe-archive", problems[0]!.message, `Unsafe archive member: ${archive}`, archive);
      continue;
    }
    const zipped = new Map(entries.filter((e) => !e.isDirectory).map((e) => [e.name, e.data]));
    const expected = all.filter((p) => p.startsWith(`${folder}/`)).map((p) => [`${name}/${p.slice(folder.length + 1)}`, files.get(p)!] as const);
    const stale =
      zipped.size !== expected.length || expected.some(([entry, data]) => !zipped.get(entry)?.equals(data));
    if (stale) fail("package.stale-archive", `${archive} doesn't match the files in ${folder}. Run the package build.`, `Stale skill ZIP: ${archive}`, archive);
  }

  // Memory stores and memories
  const memory = layout.memory;
  const storeFiles = memory ? sortPaths(all.filter((p) => isChild(p, memory.dir, 2) && basename(p) === memory.storeFile)) : [];
  const memories: string[] = [];
  const indexSizes: number[] = [];
  for (const storeFile of storeFiles) {
    const store = dirname(storeFile);
    if (!pythonFrontmatter(text(storeFile))) fail("package.frontmatter-missing", `${storeFile} has no frontmatter block.`, `Missing frontmatter: ${storeFile}`, storeFile);
    const names = new Set<string | undefined>();
    const special = new Set([memory!.storeFile, memory!.indexFile].filter(Boolean));
    for (const p of sortPaths(all.filter((x) => x.startsWith(`${store}/`) && x.endsWith(".md") && !special.has(basename(x))))) {
      const fm = pythonFrontmatter(text(p));
      if (!fm) {
        fail("package.frontmatter-missing", `${p} has no frontmatter block.`, `Missing frontmatter: ${p}`, p);
        continue;
      }
      const expectedName = withoutSuffix(p.slice(store.length + 1));
      if (fm.name !== expectedName || !fm.description) {
        fail("package.memory-identity", `The frontmatter in ${p} needs name: ${expectedName} (its path without .md) and a description.`, `Memory identity/description: ${p}`, p);
      }
      if (names.has(fm.name)) fail("package.memory-duplicate", `Memory name ${fm.name} is used more than once in ${store}.`, `Duplicate memory name: ${p}`, p);
      names.add(fm.name);
      // Design targets are advice, not service limits (asset-types.yaml has those), so they warn and never block a build or export.
      if (checks.memoryMaxBytes !== null && size(p) > checks.memoryMaxBytes) {
        results.push(warning("package.memory-size", `${p} is ${size(p)} bytes; the package design target is ${checks.memoryMaxBytes}.`, { path: p }));
      }
      memories.push(p);
    }
    if (!memory!.indexFile) continue;
    const index = `${store}/${memory!.indexFile}`;
    if (!files.has(index)) {
      fail("package.index-missing", `${store} has no ${memory!.indexFile}. Run the package build to create it.`, `Missing index: ${store}`, store);
      continue;
    }
    indexSizes.push(size(index));
    if (checks.indexMaxBytes !== null && size(index) > checks.indexMaxBytes) {
      results.push(warning("package.index-size", `${index} is ${size(index)} bytes; the package design target is ${checks.indexMaxBytes}.`, { path: index }));
    }
    for (const m of text(index).matchAll(LINK)) {
      const target = m[1]!;
      if (target.startsWith("http:") || target.startsWith("https:")) continue;
      const resolved = resolveRelative(store, target);
      if (resolved === null || !resolved.startsWith(`${store}/`) || !files.has(resolved)) {
        fail("package.index-link", `${index} links to ${target}, which is not a file in ${store}.`, `Broken/out-of-store relative link: ${index} -> ${target}`, index);
      }
    }
  }

  // Text patterns (for example unsupported dotted tool invocations)
  for (const rule of checks.textPatterns) {
    const re = new RegExp(rule.pattern, `${rule.flags.replace(/[gu]/g, "")}u`);
    for (const dir of rule.dirs) {
      for (const p of all) {
        if (!p.startsWith(`${dir}/`) || !matchesGlob(p.slice(dir.length + 1), rule.glob)) continue;
        if (re.test(text(p))) fail(rule.code, `${p}: ${rule.message}.`, `${rule.message}: ${p}`, p);
      }
    }
  }

  // Required text
  for (const rule of checks.requiredText) {
    const file = textRuleFile(rule, files, layout);
    if (!file || !files.has(file)) {
      if (rule.missing === "skip") continue;
      const what = file ?? describeSelector(rule.asset!);
      fail("package.required-file-missing", `${what} is missing.`, `Missing file: ${what}`, file ?? undefined);
      continue;
    }
    const body = text(file);
    for (const t of rule.texts) if (!body.includes(t)) fail(rule.code, `${rule.message}: ${file} must contain "${t}".`, rule.message, file);
  }

  // Shared sections must match their source in every file that embeds them
  for (const s of sharedSections(layout)) {
    if (!files.has(s.source)) {
      fail("package.shared-source-missing", `${s.source} is missing, so the ${s.name} section can't be copied.`, `Missing shared section source: ${s.source}`, s.source);
      continue;
    }
    const source = text(s.source).replace(/\n+$/, "");
    for (const target of s.targets) {
      const label = basename(target);
      if (!files.has(target)) {
        fail("package.shared-markers", `${target} is missing.`, `Missing shared ${s.name} markers: ${label}`, target);
        continue;
      }
      const t = text(target);
      if (!t.includes(s.begin) || !t.includes(s.end)) {
        fail("package.shared-markers", `${target} is missing the ${s.name} markers.`, `Missing shared ${s.name} markers: ${label}`, target);
        continue;
      }
      const after = t.slice(t.indexOf(s.begin) + s.begin.length);
      const endAt = after.indexOf(s.end);
      const embedded = (endAt < 0 ? after : after.slice(0, endAt)).replace(/^\n+|\n+$/g, "");
      if (embedded !== source) {
        fail("package.shared-stale", `The ${s.name} section in ${target} differs from ${s.source}. Run the package build.`, `Shared ${s.name} section out of date: ${label} (run tools/build_release.py)`, target);
      }
    }
  }

  // Forbidden text
  for (const rule of checks.forbiddenText) {
    const file = textRuleFile(rule, files, layout);
    if (!file || !files.has(file)) continue;
    const body = text(file);
    for (const t of rule.texts) if (body.includes(t)) fail(rule.code, `${rule.message}: ${file} contains "${t}".`, rule.message, file);
  }

  // Required files; a rule with level "warning" lists files the package may leave out (they don't fail it)
  for (const rule of checks.requiredFiles) {
    for (const f of rule.files) {
      if (!files.has(f)) {
        const message = fill(rule.message, { file: basename(f), path: f });
        if (rule.level === "warning") results.push(warning(rule.code, `${message}.`, { path: f }));
        else fail(rule.code, `${message}.`, message, f);
      }
    }
  }

  if (checks.requireMemory && !memories.length) fail("package.no-memories", "The package has no memories.", "No memories found");

  const instructionsDir = layout.instructions?.dir;
  const summary: PackageValidationSummary = {
    status: lines.length ? "failed" : "passed",
    instruction_files: instructionsDir ? all.filter((p) => isChild(p, instructionsDir, 1) && p.endsWith(".md")).length : 0,
    skills: skillMains.length,
    stores: storeFiles.length,
    memories: memories.length,
    largest_memory_bytes: memories.length ? Math.max(...memories.map(size)) : 0,
    largest_index_bytes: indexSizes.length ? Math.max(...indexSizes) : 0,
    errors: lines,
    scope: checks.scope,
  };
  return { status: summary.status, results, summary };
}

/** p is `${dir}/` plus exactly `depth` more segments. */
function isChild(p: string, dir: string, depth: number): boolean {
  return p.startsWith(`${dir}/`) && p.slice(dir.length + 1).split("/").length === depth;
}

type TextRule = PackageLayout["checks"]["requiredText"][number];

/** The file a text rule checks: its `file`, or the main file of the asset folder its `asset` selector names. */
function textRuleFile(rule: TextRule, files: ReadonlyMap<string, Buffer>, layout: PackageLayout): string | null {
  if (rule.file !== undefined) return rule.file;
  return rule.asset ? findAssetMainFile(files, layout, rule.asset) : null;
}

/** "The agents_md asset with agent_type GENERIC" */
function describeSelector(selector: NonNullable<TextRule["asset"]>): string {
  const values = Object.entries(selector.metadata).map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`);
  return `The ${selector.assetType} asset${values.length ? ` with ${values.join(" and ")}` : ""}`;
}

function withoutSuffix(p: string): string {
  const name = basename(p);
  const i = name.lastIndexOf(".");
  return i > 0 ? p.slice(0, p.length - (name.length - i)) : p;
}

function fullMatch(pattern: string, s: string): boolean {
  return new RegExp(`^(?:${pattern})$`, "u").test(s);
}
