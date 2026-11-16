import path from "node:path";
import type { FileChange, HistoryRepo } from "@/server/git/history-repo";
import { describePathProblem, pathProblem, sortPaths } from "@/server/packages/paths";
import { normalizePackage } from "@/server/packages/read";
import { isText } from "@/server/packages/text";
import type { PackageContents } from "@/server/packages/types";
import type { Policy } from "@/server/policy";
import { RevisionError, type RevisionFileEdit } from "./types";

/**
 * The package files of a revision: read from its branch, edited in memory,
 * and turned back into file changes under the package folder. Reads go
 * through git (ls-tree and one cat-file batch), never the working copy, so
 * they are safe in the web process.
 */

/** The package at a commit of the revision branch. Paths are package-relative. */
export async function readRevisionPackage(repo: HistoryRepo, commit: string, packageDir: string, packageName: string): Promise<PackageContents> {
  const prefix = `${packageDir}/`;
  const entries = (await repo.listTree(commit, packageDir)).filter((e) => e.path.startsWith(prefix));
  const blobs = await repo.readBlobs(
    commit,
    entries.map((e) => e.path),
  );
  const files = new Map<string, Buffer>();
  for (const e of entries) {
    const rel = e.path.slice(prefix.length);
    const data = blobs.get(e.path);
    if (!data || pathProblem(rel) !== null) continue;
    files.set(rel, data);
  }
  return normalizePackage({ name: packageName, files });
}

/** The package as file changes under `packageDir`: everything in `after` that differs from `before`, plus deletions. */
export function packageFileChanges(before: PackageContents | null, after: PackageContents, packageDir: string): FileChange[] {
  const out: FileChange[] = [];
  for (const p of sortPaths(after.files.keys())) {
    const data = after.files.get(p)!;
    const old = before?.files.get(p);
    if (!old || !old.equals(data)) out.push({ path: path.posix.join(packageDir, p), content: data });
  }
  for (const p of sortPaths(before?.files.keys() ?? [])) {
    if (!after.files.has(p)) out.push({ path: path.posix.join(packageDir, p), content: null });
  }
  return out;
}

/** Package paths that differ between two packages. */
export function changedPackagePaths(before: PackageContents, after: PackageContents): string[] {
  const out = new Set<string>();
  for (const [p, data] of after.files) if (!before.files.get(p)?.equals(data)) out.add(p);
  for (const p of before.files.keys()) if (!after.files.has(p)) out.add(p);
  return sortPaths(out);
}

/** Bytes of an edit's content (null for a delete). Throws for malformed base64. */
export function editBytes(edit: RevisionFileEdit): Buffer | null {
  if (edit.content === null) return null;
  if ((edit.encoding ?? "utf8") === "utf8") return Buffer.from(edit.content, "utf8");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(edit.content.replace(/\s+/g, ""))) {
    throw new RevisionError("bad-request", `${edit.path}: the content is not valid base64.`, { files: "A file's content is not valid base64." });
  }
  return Buffer.from(edit.content, "base64");
}

/**
 * Check a save's edits before they reach the job: safe package paths, no
 * path twice, within the save caps (revisions.yaml save) and the package
 * read caps (limits.yaml packageRead).
 */
export function checkEdits(edits: readonly RevisionFileEdit[], policy: Pick<Policy, "revisions" | "limits">): void {
  const caps = policy.revisions.save;
  const read = policy.limits.packageRead;
  if (edits.length > caps.maxFiles) throw new RevisionError("too-large", `A save can change at most ${caps.maxFiles} files.`, { files: `At most ${caps.maxFiles} files per save.` });
  const seen = new Set<string>();
  let total = 0;
  for (const e of edits) {
    const problem = pathProblem(e.path, read.maxPathLength);
    if (problem) throw new RevisionError("bad-request", `${JSON.stringify(e.path.slice(0, 200))} is not a package path: ${describePathProblem(problem)}.`, { files: "A file path is not allowed." });
    if (seen.has(e.path)) throw new RevisionError("bad-request", `${e.path} appears twice in the save.`, { files: "A file appears twice." });
    seen.add(e.path);
    const bytes = editBytes(e);
    if (bytes && bytes.length > read.maxEntryBytes) throw new RevisionError("too-large", `${e.path} is larger than ${read.maxEntryBytes} bytes.`, { files: "A file is too large." });
    total += bytes?.length ?? 0;
  }
  if (total > caps.maxBytes) throw new RevisionError("too-large", `A save can carry at most ${caps.maxBytes} bytes of file content.`, { files: "The save is too large." });
}

/** Apply edits to a package. Returns the edited package and the paths that actually changed. */
export function applyEdits(contents: PackageContents, edits: readonly RevisionFileEdit[]): { contents: PackageContents; changedPaths: string[] } {
  const files = new Map(contents.files);
  for (const e of edits) {
    const bytes = editBytes(e);
    if (bytes === null) files.delete(e.path);
    else files.set(e.path, bytes);
  }
  const next = normalizePackage({ name: contents.name, files });
  return { contents: next, changedPaths: changedPackagePaths(contents, next) };
}

/** A file of the package for display: text, or a note that it is binary or too large. */
export function fileView(data: Buffer | undefined, maxBytes: number): { kind: "text"; text: string; size: number } | { kind: "binary" | "too-large"; size: number } | null {
  if (!data) return null;
  if (data.length > maxBytes) return { kind: "too-large", size: data.length };
  if (!isText(data)) return { kind: "binary", size: data.length };
  return { kind: "text", text: data.toString("utf8"), size: data.length };
}
