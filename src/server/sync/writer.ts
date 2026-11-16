import path from "node:path";
import type { AssetFileSnapshot, AssetJson, AssetSnapshot } from "@/lib/assets/types";
import type { FileChange } from "@/server/git/history-repo";
import { buildAssetJson, fileBytes, safeAssetFilePath, serializeJson } from "./content";

/**
 * Pure planning of the file changes for one commit: the new asset directory,
 * the files to write and the files to remove (renames, dropped files,
 * deletions). The previous file set comes from the previous asset.json, never
 * from a directory listing, because a memory directory can contain other
 * memories' directories (names such as "databases" and "databases/rds").
 */

export interface PlannedFiles {
  changes: FileChange[];
  assetJson: AssetJson | null;
}

/** Repository paths a committed asset.json accounts for: the asset.json itself and every committed file. */
export function committedPaths(dir: string, assetJsonName: string, json: AssetJson | null): string[] {
  if (!json) return [path.posix.join(dir, assetJsonName)];
  const out = [path.posix.join(dir, assetJsonName)];
  for (const f of json.files) {
    if (!f.committed) continue;
    const p = safeAssetFilePath(f.path);
    if (p) out.push(path.posix.join(dir, p));
  }
  return out;
}

/** Whether a snapshot file is written to git: content kept, safe path, and not clashing with asset.json. */
export function isCommittable(f: AssetFileSnapshot, assetJsonName: string): boolean {
  const p = safeAssetFilePath(f.path);
  return f.content !== undefined && p !== null && p === f.path && p !== assetJsonName;
}

/**
 * Files for writing `snapshot` at `newDir`, replacing whatever the previous
 * asset.json (at `oldDir`) accounted for. Removals come first so a move works
 * on case-insensitive file systems.
 */
export function planWrite(input: {
  snapshot: AssetSnapshot;
  newDir: string;
  oldDir: string | null;
  previous: AssetJson | null;
  assetJsonName: string;
}): PlannedFiles {
  const { snapshot, newDir, oldDir, previous, assetJsonName } = input;
  const json = buildAssetJson(snapshot, (f) => isCommittable(f, assetJsonName), previous);
  const writes: FileChange[] = [{ path: path.posix.join(newDir, assetJsonName), content: serializeJson(json) }];
  const keep = new Set<string>();
  // Files already committed with the same hash in the same directory are left as they are (fewer git calls).
  const unchanged = new Set(
    oldDir === newDir ? (previous?.files ?? []).filter((f) => f.committed).map((f) => `${f.path}\0${f.sha256}`) : [],
  );
  for (const f of snapshot.files) {
    if (!isCommittable(f, assetJsonName)) continue;
    const p = path.posix.join(newDir, f.path);
    keep.add(p);
    if (unchanged.has(`${f.path}\0${f.sha256}`)) continue;
    writes.push({ path: p, content: fileBytes(f)! });
  }
  for (const w of writes) keep.add(w.path);
  const removals: FileChange[] = oldDir
    ? committedPaths(oldDir, assetJsonName, previous)
        .filter((p) => !keep.has(p))
        .map((p) => ({ path: p, content: null }))
    : [];
  return { changes: [...removals, ...writes], assetJson: json };
}

/** Files to remove when an asset is deleted. */
export function planDelete(input: { oldDir: string; previous: AssetJson | null; assetJsonName: string }): PlannedFiles {
  return {
    changes: committedPaths(input.oldDir, input.assetJsonName, input.previous).map((p) => ({ path: p, content: null })),
    assetJson: null,
  };
}

/**
 * Files to move an already committed asset from `oldDir` to `newDir` without
 * changing its content (a memory whose store was renamed). `read` returns the
 * committed bytes of a repository path.
 */
export async function planMove(input: {
  oldDir: string;
  newDir: string;
  previous: AssetJson;
  assetJsonName: string;
  read: (repoPath: string) => Promise<Buffer | null>;
}): Promise<FileChange[]> {
  const { oldDir, newDir, previous, assetJsonName, read } = input;
  const removals: FileChange[] = [];
  const writes: FileChange[] = [];
  for (const oldPath of committedPaths(oldDir, assetJsonName, previous)) {
    const rel = path.posix.relative(oldDir, oldPath);
    const bytes = await read(oldPath);
    removals.push({ path: oldPath, content: null });
    if (bytes) writes.push({ path: path.posix.join(newDir, rel), content: bytes });
  }
  return [...removals, ...writes];
}
