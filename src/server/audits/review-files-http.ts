import { Readable } from "node:stream";
import { decodeParam } from "@/server/assets/guard";
import { AuthError, requirePermission, requireUser } from "@/server/auth/dal";
import { env } from "@/server/env";
import { attachmentHeader } from "@/server/journals/download";
import { isCrossSiteRequest, readBodyWithLimit, UploadBodyError } from "@/server/package-io/http";
import { actorOf } from "@/server/spaces/actor";
import { getSpaceByAlias } from "@/server/spaces/queries";
import { AuditRequestError } from "./errors";
import { exportReviewFiles } from "./handoff";
import { importReviews, type ImportFile } from "./handoff-import";
import { loadedPolicyForSpace } from "./profiles";
import { isUuid } from "./store";

/**
 * The Route Handlers behind "Download review files" and "Import review" (the
 * audit's Investigations tab and an investigation's page). The routes in
 * src/app/api/spaces/[alias]/audits/[auditId]/review-files and
 * .../items/[itemId]/review-files only pass their parameters here.
 *
 * Download needs `audits.read` and `journals.export`: the files hold journal
 * text. Import needs `audits.run`. Both look the audit and item up inside the
 * space from the URL, so an ID from another space is "not found".
 */

export interface ReviewFilesParams {
  alias: string;
  auditId: string;
  itemId?: string;
}

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;
const json = (status: number, body: unknown) => Response.json(body, { status, headers: NO_STORE });
const problem = (status: number, title: string, body: string, field?: string) => json(status, { error: { title, body, ...(field ? { field } : {}) } });

/** Multipart framing on top of the policy's upload cap. */
const FRAMING_BYTES = 256 * 1024;
const MAX_FILES = 20;

function statusOf(err: AuditRequestError): number {
  switch (err.code) {
    case "not-found":
      return 404;
    case "state":
    case "confirm":
      return 409;
    default:
      return 422;
  }
}

function authProblem(err: AuthError, what: string): Response {
  return problem(err.status, err.status === 401 ? "You are signed out" : `You can't ${what} in this space`, err.status === 401 ? "Sign in and try again." : "Ask an Admin for a role that can.");
}

/** GET: the review files as a zip, for the whole audit or for one investigation. */
export async function downloadReviewFiles(p: ReviewFilesParams): Promise<Response> {
  try {
    await requireUser();
    const space = await getSpaceByAlias(decodeParam(p.alias));
    if (!space || !isUuid(p.auditId) || (p.itemId !== undefined && !isUuid(p.itemId))) return problem(404, "There is no such audit", "Check the address and try again.");
    await requirePermission("audits.read", space.id);
    const user = await requirePermission("journals.export", space.id);
    const out = await exportReviewFiles(actorOf(user), space.id, p.auditId, { itemId: p.itemId });
    // JSZip's typings call this a web stream; at run time it is a Node Readable (as in journals/export-zip.ts).
    const nodeStream = out.zip.generateNodeStream({ streamFiles: true, compression: "DEFLATE", compressionOptions: { level: 6 } }) as unknown as Readable;
    const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: { ...NO_STORE, "Content-Type": "application/zip", "Content-Disposition": attachmentHeader(out.fileName), "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    if (err instanceof AuthError) return authProblem(err, "download review files");
    if (err instanceof AuditRequestError) return problem(statusOf(err), "There are no review files to download", err.message);
    throw err;
  }
}

/** POST: import reviews from the `files` of a multipart form, with the `reviewer` label. */
export async function uploadReviews(req: Request, p: ReviewFilesParams): Promise<Response> {
  try {
    await requireUser();
    const space = await getSpaceByAlias(decodeParam(p.alias));
    if (!space || !isUuid(p.auditId) || (p.itemId !== undefined && !isUuid(p.itemId))) return problem(404, "There is no such audit", "Check the address and try again.");
    const user = await requirePermission("audits.run", space.id);
    if (isCrossSiteRequest(req, env().allowedOrigins)) return problem(403, "The upload came from another site", "Import the reviews from this app's audit page.");
    const limits = (await loadedPolicyForSpace(space.id)).policy.audits.handoff.import;
    const mbText = `${Math.floor(limits.maxUploadBytes / 1048576)} MB`;

    let form: FormData;
    try {
      const body = await readBodyWithLimit(req, limits.maxUploadBytes + FRAMING_BYTES);
      const type = req.headers.get("content-type");
      if (!type || !/^multipart\/form-data\s*;/i.test(type)) return problem(400, "The upload could not be read", "Send the files as a form upload.");
      form = await new Response(new Uint8Array(body), { headers: { "content-type": type } }).formData();
    } catch (err) {
      if (err instanceof UploadBodyError) {
        return problem(413, err.kind === "too-large" ? `The upload is larger than ${mbText}` : "The upload was cut off", err.kind === "too-large" ? "Import fewer reviews at a time, or a smaller zip." : "Try again.", "files");
      }
      return problem(400, "The upload could not be read", "Choose the files again and retry.");
    }

    const files: ImportFile[] = [];
    for (const v of form.getAll("files")) {
      if (typeof v === "string") continue;
      if (files.length >= MAX_FILES) return problem(400, `Import at most ${MAX_FILES} files at a time`, "Put the review folders in one zip.", "files");
      files.push({ fileName: v.name || "upload", bytes: Buffer.from(await v.arrayBuffer()) });
    }
    const reviewer = form.get("reviewer");
    const report = await importReviews(actorOf(user), space.id, p.auditId, files, { reviewer: typeof reviewer === "string" ? reviewer : "", itemId: p.itemId });
    return json(200, { report });
  } catch (err) {
    if (err instanceof AuthError) return authProblem(err, "import reviews");
    if (err instanceof AuditRequestError) {
      const field = typeof err.details?.field === "string" ? err.details.field : undefined;
      return problem(statusOf(err), "The reviews were not imported", err.message, field);
    }
    throw err;
  }
}
