import type { Policy } from "@/server/policy";
import type { ValidationResult } from "@/server/validation/types";
import { formatBytes } from "./format";
import type { ImportPackageResult } from "./service";
import { PackageIoError } from "./types";

export { formatBytes };

/**
 * Request and response helpers for the package Route Handlers (upload,
 * download, export preview). Pure apart from reading the request body, so
 * the handlers stay thin and these are unit-tested.
 */

type PackageReadLimits = Policy["limits"]["packageRead"];


/**
 * The largest upload body accepted: the package caps (a folder's files may
 * total `maxTotalBytes`) plus room for the multipart framing of every file,
 * whose name and path are each at most `maxPathLength`.
 */
export function uploadBodyLimit(limits: Pick<PackageReadLimits, "maxTotalBytes" | "maxZipBytes" | "maxEntries" | "maxPathLength">): number {
  const framing = limits.maxEntries * (2 * limits.maxPathLength + 512) + 64 * 1024;
  return Math.max(limits.maxTotalBytes, limits.maxZipBytes) + framing;
}

/** The body is over the limit, or arrived shorter than its Content-Length. */
export class UploadBodyError extends Error {
  constructor(
    readonly kind: "too-large" | "truncated",
    readonly received: number,
    readonly limit: number,
    readonly declared: number | null,
  ) {
    super(kind === "too-large" ? `upload body over ${limit} bytes` : `upload body cut off at ${received} of ${declared} bytes`);
    this.name = "UploadBodyError";
  }
}

/**
 * Read the request body up to `limit` bytes. A declared Content-Length over
 * the limit is refused before anything is read; a body that grows past it
 * is cancelled. A body shorter than its Content-Length (something upstream
 * cut it off) is refused too, so a cut-off package is never read as whole.
 */
export async function readBodyWithLimit(req: Request, limit: number): Promise<Buffer> {
  const header = req.headers.get("content-length");
  const declared = header !== null && /^\d+$/.test(header) ? Number(header) : null;
  if (declared !== null && declared > limit) throw new UploadBodyError("too-large", declared, limit, declared);
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new UploadBodyError("too-large", size, limit, declared);
    }
    chunks.push(value);
  }
  if (declared !== null && size !== declared) throw new UploadBodyError("truncated", size, limit, declared);
  return Buffer.concat(chunks, size);
}

/**
 * A browser request from another site, which a cookie-authenticated POST
 * must refuse (Server Actions get this check from Next.js; Route Handlers
 * don't). The Origin's host must be the request's own host (or
 * x-forwarded-host) or one of `allowedOrigins` (DAM_ALLOWED_ORIGINS, as a
 * host or a full origin). Requests without an Origin (curl, scripts) pass:
 * they carry no ambient browser cookies.
 */
export function isCrossSiteRequest(req: Request, allowedOrigins: readonly string[]): boolean {
  if (req.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = req.headers.get("origin");
  if (origin === null) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return true;
  }
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host");
  if (host && url.host === host) return false;
  return !allowedOrigins.some((a) => a === url.host || a === url.origin);
}

/** Parse a multipart body read with readBodyWithLimit. */
export async function parseMultipart(body: Buffer, contentType: string | null): Promise<FormData> {
  if (!contentType || !/^multipart\/form-data\s*;/i.test(contentType)) throw new PackageIoError("bad-request", "Send the package as a form upload (multipart/form-data).");
  try {
    return await new Response(new Uint8Array(body), { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new PackageIoError("bad-request", "The upload could not be read as a form. Choose the package again and retry.");
  }
}

/** What the upload page shows above the card: a title, the next step, and the field it belongs to. */
export interface UploadProblem {
  title: string;
  body: string;
  field?: "layout" | "file";
  /** The engine's results (rejected uploads), shown as plain text */
  results?: ValidationResult[];
}

const SIZE_CODES = new Set(["package.too-large", "package.too-many-files", "package.file-too-large"]);

/** The 413 message for a body over the limit or cut off on the way. */
export function bodyProblem(err: UploadBodyError, limits: Pick<PackageReadLimits, "maxTotalBytes" | "maxZipBytes">): UploadProblem {
  if (err.kind === "truncated") {
    return {
      title: "The upload was cut off",
      body: `The app received ${formatBytes(err.received)} of ${formatBytes(err.declared ?? 0)}. Upload the package again.`,
      field: "file",
    };
  }
  return {
    title: "The package is too large",
    body: `It is ${formatBytes(err.received)}; the limit is ${formatBytes(limits.maxZipBytes)} for a zip and ${formatBytes(limits.maxTotalBytes)} of files for a folder.`,
    field: "file",
  };
}

/**
 * The upload page's message for an import that didn't map anything:
 * rejected by the read checks, over a cap, or matching nothing in the
 * layout. Null when the import can be shown on its result page.
 */
export function importProblem(
  result: Pick<ImportPackageResult, "status" | "problems" | "summary">,
  ctx: { layoutLabel: string; kind: "zip" | "folder"; sizeBytes: number; limits: Pick<PackageReadLimits, "maxZipBytes" | "maxTotalBytes"> },
): UploadProblem | null {
  if (result.status === "rejected") {
    const size = result.problems.find((p) => SIZE_CODES.has(p.code));
    if (size?.code === "package.too-large") {
      const body =
        ctx.kind === "zip"
          ? `It is ${formatBytes(ctx.sizeBytes)}; the limit is ${formatBytes(ctx.limits.maxZipBytes)}.`
          : `Its files total ${formatBytes(ctx.sizeBytes)}; the limit is ${formatBytes(ctx.limits.maxTotalBytes)} of files, or ${formatBytes(ctx.limits.maxZipBytes)} once zipped.`;
      return { title: "The package is too large", body, field: "file", results: result.problems };
    }
    if (size) return { title: "The package is too large", body: size.message, field: "file", results: result.problems };
    const empty = result.problems.every((p) => p.code === "package.empty");
    if (empty) return { title: `Nothing in this package matches ${ctx.layoutLabel}`, body: "Check the layout choice, or the package's folder names.", field: "file", results: result.problems };
    return { title: "The package was rejected", body: "Fix the package and upload it again.", field: "file", results: result.problems };
  }
  if (result.status === "analyzed" && result.summary.assets === 0) {
    return { title: `Nothing in this package matches ${ctx.layoutLabel}`, body: "Check the layout choice, or the package's folder names." };
  }
  return null;
}

/** HTTP status for a refused package request. */
export function packageIoStatus(code: PackageIoError["code"]): number {
  switch (code) {
    case "not-found":
      return 404;
    case "bad-request":
    case "unknown-layout":
    case "unknown-ref":
      return 400;
    case "no-history":
    case "upload-expired":
    case "already-planned":
    case "in-revision":
      return 409;
    case "checks-failed":
    case "not-plannable":
    case "nothing-to-plan":
    case "upload-changed":
      return 422;
  }
}

const HEX = /^[0-9a-f]{7,64}$/i;

/** The export dialog's field error for a refused source or layout. */
export function exportFieldError(err: PackageIoError, ref: string | null): { field: "ref" | "layout" | null; message: string } {
  if (err.code === "unknown-ref") {
    const r = (ref ?? "").trim();
    return { field: "ref", message: HEX.test(r) ? `No commit ${r} in the history repository.` : err.message };
  }
  if (err.code === "unknown-layout") return { field: "layout", message: err.message };
  return { field: null, message: err.message };
}

/** Plain-text body for the download when it is refused: the reason, then up to 20 errors, one per line. */
export function refusalText(err: PackageIoError): string {
  // Sentences only: the codes are for the dialog's tooltips, not for a person reading a refused download.
  const lines = err.results.slice(0, 20).map((r) => r.message);
  const more = err.results.length > 20 ? [`and ${err.results.length - 20} more`] : [];
  return [err.message, ...lines, ...more].join("\n");
}
