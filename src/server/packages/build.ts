import { getAppPolicy } from "@/server/policy";
import { validatePackage, type PackageValidation } from "@/server/validation/package";
import { error, type ValidationResult } from "@/server/validation/types";
import { sharedSections, type PackageLayout } from "./layout";
import { comparePaths, fill, sortPaths } from "./paths";
import { normalizePackage } from "./read";
import { pythonJsonDumps, pythonReadText, utf8 } from "./text";
import type { PackageContents } from "./types";
import { writeZip, type ZipReadLimits } from "./zip";

/**
 * The package build, the steps of a release script for an instruction package:
 *   1. copy each shared section source between its markers in the target files;
 *   2. regenerate each memory folder's index;
 *   3. rebuild each skill's zip (deterministic);
 *   4. run the package checks and write the validation summary;
 *   5. when the checks pass, zip the whole package under one top folder.
 * Text output follows Python's conventions (universal newlines, json.dumps
 * layout), so a package built here matches one built by a Python script that
 * does the same steps. The build never touches disk: it returns a new
 * PackageContents. Where such a script stops at the first problem (missing
 * markers, a memory without a description), this build records an error,
 * leaves the affected file unchanged, and carries on, so one run reports every
 * problem. `ok` is false whenever any error was found.
 */

export interface BuildOptions {
  /** Caps for reading skill zips during validation (default: app policy limits.packageRead) */
  zipLimits?: ZipReadLimits;
  /** Produce the whole-package zip when the checks pass (default true) */
  packageZip?: boolean;
}

export interface BuildResult {
  /** True when the build ran and the checks passed */
  ok: boolean;
  contents: PackageContents;
  /** Files the build created or changed */
  changes: { path: string; change: "created" | "updated" }[];
  validation: PackageValidation;
  /** Build problems plus validation results */
  results: ValidationResult[];
  packageZip: { fileName: string; data: Buffer } | null;
}

export function buildRelease(input: PackageContents, layout: PackageLayout, opts: BuildOptions = {}): BuildResult {
  const files = new Map(input.files);
  const results: ValidationResult[] = [];
  const write = (path: string, data: Buffer) => files.set(path, data);
  // 1. Shared sections. A missing source or missing markers leave the files as they are;
  // the package checks in step 4 report them, so they are not reported twice.
  for (const s of sharedSections(layout)) {
    const source = files.get(s.source);
    if (!source) continue;
    const body = pythonReadText(source).replace(/\n+$/, "");
    for (const target of s.targets) {
      const raw = files.get(target);
      const text = raw ? pythonReadText(raw) : "";
      const at = text.indexOf(s.begin);
      const endAt = at < 0 ? -1 : text.indexOf(s.end, at + s.begin.length);
      if (!raw || at < 0 || endAt < 0) continue;
      const head = text.slice(0, at);
      const tail = text.slice(endAt + s.end.length);
      write(target, utf8(`${head}${s.begin}\n${body}\n${s.end}${tail}`));
    }
  }

  // 2. Memory indexes
  const memory = layout.memory;
  if (layout.build.memoryIndexes && memory?.index && memory.indexFile) {
    const prefix = `${memory.dir}/`;
    const folders = new Set<string>();
    for (const p of files.keys()) {
      const rest = p.startsWith(prefix) ? p.slice(prefix.length) : null;
      if (rest?.includes("/")) folders.add(rest.slice(0, rest.indexOf("/")));
    }
    stores: for (const folder of sortPaths(folders)) {
      const dir = `${prefix}${folder}`;
      const lines = memory.index.header.map((h) => fill(h, { store: folder }));
      for (const p of sortPaths([...files.keys()].filter((x) => x.startsWith(`${dir}/`) && x.endsWith(".md")))) {
        const name = p.slice(p.lastIndexOf("/") + 1);
        if (name === memory.storeFile || name === memory.indexFile) continue;
        const description = firstValue(pythonReadText(files.get(p)!), memory.index.descriptionKey);
        if (description === null) {
          results.push(error("build.memory-description", `${p} has no ${memory.index.descriptionKey}: line, so the index can't list it.`, { path: p }));
          continue stores;
        }
        const rel = p.slice(dir.length + 1);
        lines.push(fill(memory.index.line, { stem: pythonStem(name), path: rel, description }));
      }
      write(`${dir}/${memory.indexFile}`, utf8(`${lines.join("\n")}\n`));
    }
  }

  // 3. Skill zips
  const skills = layout.skills;
  if (layout.build.skillArchives && skills?.archive) {
    const prefix = `${skills.dir}/`;
    const mains = sortPaths([...files.keys()].filter((p) => p.startsWith(prefix) && p.slice(prefix.length).split("/").length === 2 && p.endsWith(`/${skills.mainFile}`)));
    for (const main of mains) {
      const dir = main.slice(0, main.lastIndexOf("/"));
      const name = dir.slice(prefix.length);
      const entries = sortPaths([...files.keys()].filter((p) => p.startsWith(`${dir}/`))).map((p) => ({ name: `${name}/${p.slice(dir.length + 1)}`, data: files.get(p)! }));
      write(`${prefix}${fill(skills.archive, { name })}`, writeZip(entries));
    }
  }

  // 4. Validation
  const zipLimits = opts.zipLimits ?? getAppPolicy().policy.limits.packageRead;
  const staged: PackageContents = normalizePackage({ name: input.name, files });
  const validation = validatePackage(staged, layout, { requireArchives: true, zipLimits });
  results.push(...validation.results);
  if (layout.build.validationResult) write(layout.build.validationResult, utf8(`${pythonJsonDumps(validation.summary)}\n`));
  const contents = normalizePackage({ name: input.name, files });

  const changes: BuildResult["changes"] = [];
  for (const [p, data] of contents.files) {
    const before = input.files.get(p);
    if (!before) changes.push({ path: p, change: "created" });
    else if (!before.equals(data)) changes.push({ path: p, change: "updated" });
  }

  // 5. Package zip
  const ok = validation.status === "passed" && !results.some((r) => r.level === "error");
  let packageZip: BuildResult["packageZip"] = null;
  if (ok && opts.packageZip !== false && layout.build.packageZip) {
    packageZip = { fileName: fill(layout.build.packageZip, { package: contents.name }), data: zipPackage(contents) };
  }
  return { ok, contents, changes, validation, results, packageZip };
}

/** Zip every file of a package under one top folder (default: the package name), deterministically. */
export function zipPackage(contents: PackageContents, topDir: string | null = contents.name): Buffer {
  const names = [...contents.files.keys()].map((p) => ({ path: p, name: topDir ? `${topDir}/${p}` : p }));
  names.sort((a, b) => comparePaths(a.name, b.name));
  return writeZip(names.map((n) => ({ name: n.name, data: contents.files.get(n.path)! })));
}

/**
 * Python's re.search(rf"^{key}:\s*(.+)$", text, re.M)[1]: the rest of the
 * first line that starts with "key:", where the value may start on a later
 * line when the key's line has nothing after it.
 */
function firstValue(text: string, key: string): string | null {
  const re = new RegExp(`(?:^|\\n)${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*([^\\n]+)`, "u");
  return re.exec(text)?.[1] ?? null;
}

function pythonStem(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}
