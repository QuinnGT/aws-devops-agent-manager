import { mkdirSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/server/env";

/** Uploaded packages live in DAM_DATA_DIR/package-imports/<import id>.zip. Stored paths are relative to that folder. */

const AREA = "package-imports";

export function packageImportsDir(): string {
  return path.join(/*turbopackIgnore: true*/ env().dataDir, AREA);
}

export function storedPathFor(importId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(importId)) throw new Error(`invalid import id: ${importId}`);
  return `${importId}.zip`;
}

/** Resolve a stored relative path, refusing anything that would leave the folder. */
export function resolveStoredPath(rel: string): string {
  const base = packageImportsDir();
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) throw new Error(`invalid stored path: ${rel}`);
  const abs = path.resolve(base, rel);
  if (!abs.startsWith(base + path.sep)) throw new Error(`invalid stored path: ${rel}`);
  return abs;
}

/** Write a new upload (never overwrites), readable only by the app's user. */
export async function writeStoredUpload(rel: string, bytes: Buffer): Promise<void> {
  mkdirSync(packageImportsDir(), { recursive: true, mode: 0o700 });
  await writeFile(resolveStoredPath(rel), bytes, { mode: 0o600, flag: "wx" });
}

export async function readStoredUploadFile(rel: string): Promise<Buffer | null> {
  try {
    return await readFile(resolveStoredPath(rel));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Delete a stored upload. Returns false when it was already gone. */
export async function deleteStoredUpload(rel: string): Promise<boolean> {
  try {
    await unlink(resolveStoredPath(rel));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
