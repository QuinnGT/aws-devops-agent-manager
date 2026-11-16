import type { AssetFileSnapshot, AssetSnapshot } from "@/lib/assets/types";
import type { VersionContent, VersionFile } from "@/server/assets/diff";
import { assetContentHash } from "@/server/history/content-hash";
import type { DesiredFile } from "@/server/packages/types";
import { canonicalize, sha256Hex } from "@/server/sync/content";

/** Pure helpers that turn desired and live assets into comparable shapes. */

export function desiredFileBytes(f: Pick<DesiredFile, "encoding" | "content">): Buffer {
  return f.encoding === "utf8" ? Buffer.from(f.content, "utf8") : Buffer.from(f.content, "base64");
}

export interface HashedFile {
  path: string;
  sha256: string;
  size: number;
}

export function hashDesiredFiles(files: readonly DesiredFile[]): HashedFile[] {
  return files.map((f) => {
    const b = desiredFileBytes(f);
    return { path: f.path, sha256: sha256Hex(b), size: b.byteLength };
  });
}

export function desiredContentHash(files: readonly DesiredFile[]): string {
  return assetContentHash(hashDesiredFiles(files));
}

export function snapshotContentHash(s: Pick<AssetSnapshot, "files">): string {
  return assetContentHash(s.files.map((f) => ({ path: f.path, sha256: f.sha256 })));
}

/** A live snapshot as DesiredFile[] (files above the commit threshold have no content and are left out). */
export function snapshotFiles(s: Pick<AssetSnapshot, "files">): DesiredFile[] {
  return s.files.filter((f) => f.content !== undefined).map((f) => ({ path: f.path, encoding: f.encoding, content: f.content! }));
}

function versionFileOf(path: string, sha256: string, size: number, encoding: "utf8" | "base64", content: string | undefined): VersionFile {
  return { path, sha256, size, committed: content !== undefined, content: encoding === "utf8" && content !== undefined ? content : null };
}

/** VersionContent for the diff module, with only metadata and files (no service fields, so they never show as changes). */
export function liveVersionContent(metadata: Record<string, unknown>, files: readonly AssetFileSnapshot[]): VersionContent {
  return {
    assetJson: diffJson(metadata),
    files: files.map((f) => versionFileOf(f.path, f.sha256, f.size, f.encoding, f.content)),
  };
}

export function desiredVersionContent(metadata: Record<string, unknown>, files: readonly DesiredFile[]): VersionContent {
  return {
    assetJson: diffJson(metadata),
    files: files.map((f) => {
      const b = desiredFileBytes(f);
      return versionFileOf(f.path, sha256Hex(b), b.byteLength, f.encoding, f.encoding === "utf8" ? f.content : undefined);
    }),
  };
}

function diffJson(metadata: Record<string, unknown>) {
  return { assetId: "", assetType: "", metadata, serviceVersion: 0, serviceCreatedAt: "", serviceUpdatedAt: "", files: [] };
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

/**
 * The metadata PATCH that turns `live` into `desired`: every desired key whose
 * value differs, plus a removal value for each key to remove that live still has.
 * Keys only live has are left alone (PATCH keeps them).
 *
 * Removal value (tested on a test space on 2026-11-13): the API
 * rejects null for a typed key ("metadata.enable_tools must be an array of
 * strings"), and an empty array removes an array key. So an array key is removed
 * with [] and any other key with null.
 */
export function metadataPatch(live: Record<string, unknown>, desired: Record<string, unknown>, remove: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(desired)) {
    if (v === undefined || remove.includes(k)) continue;
    if (!(k in live) || !sameValue(live[k], v)) out[k] = v;
  }
  for (const k of remove) if (k in live && live[k] !== undefined) out[k] = removalValue(live[k]);
  return out;
}

/** What the API takes to remove a metadata key: [] for an array value, null otherwise. */
export function removalValue(liveValue: unknown): [] | null {
  return Array.isArray(liveValue) ? [] : null;
}

/**
 * The metadata after a PATCH: live with the patch applied. null removes a key,
 * and so does an empty array: the service drops a key sent as [].
 */
export function applyMetadataPatch(live: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...live };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || (Array.isArray(v) && v.length === 0)) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** Per path: added, changed, removed and unchanged files of `desired` against `live`. */
export function fileChanges(live: readonly HashedFile[], desired: readonly HashedFile[]) {
  const liveBy = new Map(live.map((f) => [f.path, f]));
  const desiredBy = new Map(desired.map((f) => [f.path, f]));
  const added = desired.filter((f) => !liveBy.has(f.path)).map((f) => f.path);
  const changed = desired.filter((f) => liveBy.has(f.path) && liveBy.get(f.path)!.sha256 !== f.sha256).map((f) => f.path);
  const removed = live.filter((f) => !desiredBy.has(f.path)).map((f) => f.path);
  return { added, changed, removed };
}
