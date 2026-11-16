import { canonicalize, sha256Hex } from "@/server/sync/content";

/**
 * Content and metadata hashes shared by plan verification and
 * release manifests. Pure, no I/O.
 *
 * The content hash covers every file of a version (path and SHA-256), so it
 * can be computed from asset.json without the file bodies, and a file that
 * was too large to commit still counts.
 */
export function assetContentHash(files: readonly { path: string; sha256: string }[]): string {
  const lines = [...files]
    .map((f) => `${f.path}\0${f.sha256}\n`)
    .sort();
  return sha256Hex(lines.join(""));
}

/** Hash of metadata with keys sorted at every level, so key order never changes it. */
export function metadataHash(metadata: Record<string, unknown>): string {
  return sha256Hex(JSON.stringify(canonicalize(metadata)));
}
