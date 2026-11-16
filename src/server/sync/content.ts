import { createHash } from "node:crypto";
import path from "node:path";
import type { AssetFileSnapshot, AssetJson, AssetSnapshot } from "@/lib/assets/types";

/**
 * Pure helpers for asset content: hashing, text detection, canonical JSON
 * and asset.json. No I/O.
 */

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** True when the bytes are valid UTF-8 without NUL bytes (stored as text in git). */
export function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    utf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a file snapshot from raw bytes. The hash and size always describe the
 * full content; the content itself is dropped above `maxCommittedFileBytes`.
 */
export function fileSnapshot(
  filePath: string,
  bytes: Uint8Array,
  opts: { maxCommittedFileBytes: number; mimeType?: string | undefined },
): AssetFileSnapshot {
  const text = isUtf8Text(bytes);
  const snap: AssetFileSnapshot = {
    path: filePath,
    sha256: sha256Hex(bytes),
    size: bytes.byteLength,
    encoding: text ? "utf8" : "base64",
  };
  if (opts.mimeType) snap.mimeType = opts.mimeType;
  if (bytes.byteLength <= opts.maxCommittedFileBytes) {
    snap.content = text ? utf8.decode(bytes) : Buffer.from(bytes).toString("base64");
  }
  return snap;
}

/** Bytes to write to git for a file snapshot, or null when the content was not kept. */
export function fileBytes(f: AssetFileSnapshot): Buffer | null {
  if (f.content === undefined) return null;
  return f.encoding === "utf8" ? Buffer.from(f.content, "utf8") : Buffer.from(f.content, "base64");
}

/**
 * Normalize a file path from the service into a safe relative path inside the
 * asset directory, or null when it is unsafe (absolute, `..`, `.git`, empty).
 */
export function safeAssetFilePath(p: string): string | null {
  if (!p || p.includes("\0")) return null;
  const slashed = p.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) return null;
  const segments = slashed.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) return null;
  if (segments.some((s) => s === ".." || s.toLowerCase() === ".git")) return null;
  return path.posix.join(...segments);
}

/** Deep copy with object keys sorted, so metadata key order from the API never shows up as a diff. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * asset.json for a snapshot. `committed(file)` says whether the file's content
 * is written to git. A mimeType missing from this fetch is carried over from
 * the previous asset.json for the same path (zip reads carry no mimeType).
 */
export function buildAssetJson(
  s: AssetSnapshot,
  committed: (f: AssetFileSnapshot) => boolean,
  previous?: AssetJson | null,
): AssetJson {
  const prevMime = new Map((previous?.files ?? []).map((f) => [f.path, f.mimeType]));
  const files = [...s.files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => {
      const mimeType = f.mimeType ?? prevMime.get(f.path);
      return {
        path: f.path,
        sha256: f.sha256,
        size: f.size,
        committed: committed(f),
        ...(mimeType ? { mimeType } : {}),
      };
    });
  return {
    assetId: s.assetId,
    assetType: s.assetType,
    metadata: canonicalize(s.metadata) as Record<string, unknown>,
    serviceVersion: s.version,
    serviceCreatedAt: s.createdAt,
    serviceUpdatedAt: s.updatedAt,
    files,
  };
}

export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function parseAssetJson(raw: string | null): AssetJson | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as AssetJson;
    return v && typeof v.assetId === "string" && Array.isArray(v.files) ? v : null;
  } catch {
    return null;
  }
}

/** Top-level metadata keys whose values differ between two metadata objects. */
export function changedMetadataKeys(before: Record<string, unknown> | null | undefined, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  return [...keys]
    .filter((k) => JSON.stringify(canonicalize(before?.[k])) !== JSON.stringify(canonicalize(after[k])))
    .sort();
}
