import { safeSegment } from "@/server/history/layout";
import { zipPackage } from "@/server/packages/build";
import type { PackageLayout } from "@/server/packages/layout";
import { readPackageFiles, readPackageZip } from "@/server/packages/read";
import type { PackageContents } from "@/server/packages/types";
import type { Policy } from "@/server/policy";
import { sha256Hex } from "@/server/sync/content";
import { error, ValidationFailure, type ValidationResult } from "@/server/validation/types";

/**
 * Reading an upload before anything is stored. Pure: the bytes come in, the
 * package and the bytes to store come out, or the reasons it was rejected.
 * Every cap is limits.yaml `packageRead`; path safety is the package reader's
 * (absolute paths, "..", symlinks and special files are rejected).
 */

export type PackageUpload =
  /** A zip file from a file input */
  | { kind: "zip"; fileName: string; bytes: Buffer }
  /** A browser folder upload: paths relative to the chosen folder's parent (webkitRelativePath) */
  | { kind: "folder"; name?: string; files: { path: string; data: Buffer }[] };

interface UploadBase {
  /** Display name: the zip file name or the folder name */
  fileName: string;
  source: "zip" | "folder";
  /** SHA-256 of the stored zip; for a rejected folder, of its file listing (path and SHA-256 per file) */
  sha256: string;
  sizeBytes: number;
}

export type ReadUploadResult =
  | (UploadBase & { ok: true; contents: PackageContents; stored: Buffer })
  | (UploadBase & { ok: false; results: ValidationResult[] });

export interface ReadUploadOptions {
  policy: Policy;
  layout: PackageLayout;
}

/** A display name: the base name, no control characters, at most 200 characters. */
export function displayName(name: string | undefined, fallback: string): string {
  const base = (name ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return cleaned || fallback;
}

export function readUpload(upload: PackageUpload, opts: ReadUploadOptions): ReadUploadResult {
  return upload.kind === "zip" ? readZipUpload(upload, opts) : readFolderUpload(upload, opts);
}

function readZipUpload(upload: Extract<PackageUpload, { kind: "zip" }>, { policy, layout }: ReadUploadOptions): ReadUploadResult {
  const limits = policy.limits.packageRead;
  const bytes = upload.bytes;
  const base: UploadBase = { fileName: displayName(upload.fileName, "package.zip"), source: "zip", sha256: sha256Hex(bytes), sizeBytes: bytes.length };
  const reject = (results: ValidationResult[]): ReadUploadResult => ({ ...base, ok: false, results });
  if (bytes.length === 0) return reject([error("package.empty", "The file is empty.")]);
  if (bytes.length > limits.maxZipBytes) {
    return reject([error("package.too-large", `The zip is ${bytes.length} bytes; the limit is ${limits.maxZipBytes}.`)]);
  }
  if (bytes.subarray(0, 2).toString("latin1") !== "PK") return reject([error("package.not-zip", "The file is not a zip archive.")]);
  try {
    const contents = readPackageZip(bytes, base.fileName, { policy, layout });
    if (contents.files.size === 0) return reject([error("package.empty", "The zip has no package files.")]);
    return { ...base, ok: true, contents, stored: bytes };
  } catch (err) {
    if (err instanceof ValidationFailure) return reject(err.results);
    throw err;
  }
}

function readFolderUpload(upload: Extract<PackageUpload, { kind: "folder" }>, { policy, layout }: ReadUploadOptions): ReadUploadResult {
  const topDirs = new Set(upload.files.map((f) => f.path.split("/")[0] ?? ""));
  const [onlyTop] = [...topDirs];
  const fallbackName = topDirs.size === 1 && onlyTop && upload.files.every((f) => f.path.includes("/")) ? onlyTop : undefined;
  const fileName = displayName(upload.name ?? fallbackName, "folder upload");
  const listing = upload.files
    .map((f) => `${f.path}\0${sha256Hex(f.data)}\n`)
    .sort()
    .join("");
  const listingBase: UploadBase = { fileName, source: "folder", sha256: sha256Hex(listing), sizeBytes: upload.files.reduce((n, f) => n + f.data.length, 0) };
  const reject = (results: ValidationResult[]): ReadUploadResult => ({ ...listingBase, ok: false, results });
  if (upload.files.length === 0) return reject([error("package.empty", "The folder is empty.")]);
  let contents: PackageContents;
  try {
    contents = readPackageFiles(upload.files, upload.name ? safeSegment(upload.name) : undefined, { policy, layout });
  } catch (err) {
    if (err instanceof ValidationFailure) return reject(err.results);
    throw err;
  }
  if (contents.files.size === 0) return reject([error("package.empty", "The folder has no package files.")]);
  // Stored as a deterministic zip, so the same folder always gets the same SHA-256.
  const stored = zipPackage(contents, layout.stripSingleTopDir ? contents.name : null);
  if (stored.length > policy.limits.packageRead.maxZipBytes) {
    return reject([error("package.too-large", `The folder zips to ${stored.length} bytes; the limit is ${policy.limits.packageRead.maxZipBytes}.`)]);
  }
  return { fileName, source: "folder", sha256: sha256Hex(stored), sizeBytes: stored.length, ok: true, contents, stored };
}

/** Read a stored upload again (plan creation). `packageName` is the name recorded at upload. */
export function readStoredUpload(bytes: Buffer, packageName: string | null, opts: ReadUploadOptions): PackageContents {
  return readPackageZip(bytes, `${packageName ?? "package"}.zip`, opts);
}
