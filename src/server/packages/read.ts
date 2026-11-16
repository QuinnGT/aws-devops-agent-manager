import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getAppPolicy, type Policy } from "@/server/policy";
import { error, ValidationFailure, type ValidationResult } from "@/server/validation/types";
import { getLayout, isIgnored, type PackageLayout } from "./layout";
import { describePathProblem, pathProblem, sortPaths } from "./paths";
import type { PackageContents } from "./types";
import { readZip, type ZipReadLimits } from "./zip";

/**
 * Read a package from a folder, a zip, or a list of uploaded files into
 * memory. Every path is checked (absolute paths, "..", symlinks and special
 * files are rejected) and the caps in limits.yaml `packageRead` are applied.
 * Files matching the layout's `ignore` globs are dropped. A rejected package
 * throws ValidationFailure with the reasons.
 */

export type PackageInput =
  | { kind: "folder"; path: string }
  | { kind: "zip"; data: Buffer; fileName?: string }
  | { kind: "files"; files: { path: string; data: Buffer }[]; name?: string };

export interface ReadPackageOptions {
  /** Defaults to getAppPolicy().policy */
  policy?: Policy;
  /** Layout name or object; defaults to the policy's defaultLayout */
  layout?: string | PackageLayout;
}

function resolveOptions(opts: ReadPackageOptions): { policy: Policy; layout: PackageLayout; limits: ZipReadLimits } {
  const policy = opts.policy ?? getAppPolicy().policy;
  const layout = typeof opts.layout === "object" ? opts.layout : getLayout(policy, opts.layout);
  return { policy, layout, limits: policy.limits.packageRead };
}

/** Read a package: a folder path, a zip buffer, or a PackageInput. */
export async function readPackage(input: string | Buffer | PackageInput, opts: ReadPackageOptions = {}): Promise<PackageContents> {
  if (typeof input === "string") return readPackageFolder(input, opts);
  if (Buffer.isBuffer(input)) return readPackageZip(input, undefined, opts);
  if (input.kind === "folder") return readPackageFolder(input.path, opts);
  if (input.kind === "zip") return readPackageZip(input.data, input.fileName, opts);
  return readPackageFiles(input.files, input.name, opts);
}

/** Read a zip archive (for example an uploaded package). */
export function readPackageZip(data: Buffer, fileName: string | undefined, opts: ReadPackageOptions = {}): PackageContents {
  const { layout, limits } = resolveOptions(opts);
  const label = fileName ?? "package zip";
  const { entries, problems } = readZip(data, limits, label);
  if (problems.some((p) => p.level === "error")) throw new ValidationFailure(`${label} was rejected`, problems);
  const files = entries.filter((e) => !e.isDirectory).map((e) => ({ path: e.name, data: e.data }));
  const fallbackName = fileName ? path.basename(fileName).replace(/\.zip$/i, "") : "package";
  return finish(files, fallbackName, layout, true);
}

/** Read uploaded files (for example a browser folder upload, paths relative to the chosen folder's parent). */
export function readPackageFiles(files: { path: string; data: Buffer }[], name: string | undefined, opts: ReadPackageOptions = {}): PackageContents {
  const { layout, limits } = resolveOptions(opts);
  const problems: ValidationResult[] = [];
  let total = 0;
  if (files.length > limits.maxEntries) problems.push(error("package.too-many-files", `The package has ${files.length} files; the limit is ${limits.maxEntries}.`));
  const seen = new Set<string>();
  for (const f of files) {
    const problem = pathProblem(f.path, limits.maxPathLength);
    if (problem) problems.push(error("package.unsafe-path", `${JSON.stringify(f.path)} ${describePathProblem(problem)}.`, { path: f.path }));
    else if (seen.has(f.path)) problems.push(error("package.duplicate-path", `${f.path} appears more than once.`, { path: f.path }));
    seen.add(f.path);
    if (f.data.length > limits.maxEntryBytes) problems.push(error("package.file-too-large", `${f.path} is ${f.data.length} bytes; the limit is ${limits.maxEntryBytes}.`, { path: f.path }));
    total += f.data.length;
  }
  if (total > limits.maxTotalBytes) problems.push(error("package.too-large", `The files total ${total} bytes; the limit is ${limits.maxTotalBytes}.`));
  if (problems.length) throw new ValidationFailure("The package was rejected", problems);
  return finish(files, name ?? "package", layout, true);
}

/** Read a package folder from disk. Symlinks and special files are rejected. */
export async function readPackageFolder(dir: string, opts: ReadPackageOptions = {}): Promise<PackageContents> {
  const { layout, limits } = resolveOptions(opts);
  const root = path.resolve(dir);
  const problems: ValidationResult[] = [];
  const files: { path: string; data: Buffer }[] = [];
  let count = 0;
  let total = 0;

  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new ValidationFailure(`${dir} is not a folder`, [error("package.not-a-folder", `${dir} is not a folder.`)]);

  async function walk(rel: string): Promise<void> {
    const abs = rel ? path.join(root, ...rel.split("/")) : root;
    const names = (await readdir(abs)).sort();
    for (const name of names) {
      const relPath = rel ? `${rel}/${name}` : name;
      const problem = pathProblem(relPath, limits.maxPathLength);
      if (problem) {
        problems.push(error("package.unsafe-path", `${JSON.stringify(relPath)} ${describePathProblem(problem)}.`, { path: relPath }));
        continue;
      }
      const st = await lstat(path.join(abs, name));
      if (st.isSymbolicLink()) {
        problems.push(error("package.symlink", `${relPath} is a symbolic link; packages can't contain links.`, { path: relPath }));
        continue;
      }
      if (st.isDirectory()) {
        if (isIgnored(layout, `${relPath}/`)) continue;
        await walk(relPath);
        continue;
      }
      if (!st.isFile()) {
        problems.push(error("package.special-file", `${relPath} is not a regular file.`, { path: relPath }));
        continue;
      }
      if (++count > limits.maxEntries) {
        problems.push(error("package.too-many-files", `The package has more than ${limits.maxEntries} files.`));
        return;
      }
      if (isIgnored(layout, relPath)) continue;
      if (st.size > limits.maxEntryBytes) {
        problems.push(error("package.file-too-large", `${relPath} is ${st.size} bytes; the limit is ${limits.maxEntryBytes}.`, { path: relPath }));
        continue;
      }
      total += st.size;
      if (total > limits.maxTotalBytes) {
        problems.push(error("package.too-large", `The files total more than ${limits.maxTotalBytes} bytes.`));
        return;
      }
      files.push({ path: relPath, data: await readFile(path.join(abs, name)) });
    }
  }
  await walk("");
  if (problems.length) throw new ValidationFailure(`${dir} was rejected`, problems);
  return finish(files, path.basename(root), layout, false);
}

function finish(files: { path: string; data: Buffer }[], fallbackName: string, layout: PackageLayout, mayStrip: boolean): PackageContents {
  let kept = files.filter((f) => !isIgnored(layout, f.path));
  let name = fallbackName;
  if (mayStrip && layout.stripSingleTopDir && kept.length) {
    const tops = new Set(kept.map((f) => (f.path.includes("/") ? f.path.slice(0, f.path.indexOf("/")) : "")));
    const [only] = [...tops];
    if (tops.size === 1 && only) {
      name = only;
      kept = kept.map((f) => ({ ...f, path: f.path.slice(only.length + 1) })).filter((f) => !isIgnored(layout, f.path));
    }
  }
  const byPath = new Map(kept.map((f) => [f.path, f.data]));
  const map = new Map<string, Buffer>();
  for (const p of sortPaths(byPath.keys())) map.set(p, byPath.get(p)!);
  return { name, files: map };
}

/** A package built in memory (tests, editor drafts). Paths are checked like any other input. */
export function packageFromFiles(name: string, files: Record<string, string | Buffer>): PackageContents {
  const map = new Map<string, Buffer>();
  for (const p of sortPaths(Object.keys(files))) {
    const problem = pathProblem(p);
    if (problem) throw new ValidationFailure(`unsafe path ${p}`, [error("package.unsafe-path", `${JSON.stringify(p)} ${describePathProblem(problem)}.`, { path: p })]);
    const v = files[p]!;
    map.set(p, typeof v === "string" ? Buffer.from(v, "utf8") : v);
  }
  return { name, files: map };
}

/** A copy whose files can be changed without touching the original. */
export function clonePackage(p: PackageContents, name = p.name): PackageContents {
  return { name, files: new Map(p.files) };
}

/** Re-sort a package's files into canonical order (after adding files). */
export function normalizePackage(p: PackageContents): PackageContents {
  const map = new Map<string, Buffer>();
  for (const k of sortPaths(p.files.keys())) map.set(k, p.files.get(k)!);
  return { name: p.name, files: map };
}
