import { decodeParam } from "@/server/assets/guard";
import { AuthError, requirePermission, requireUser } from "@/server/auth/dal";
import { AuditRequestError } from "@/server/audits/errors";
import { uploadGroundTruth, type UploadFile } from "@/server/audits/evidence";
import { loadedPolicyForSpace } from "@/server/audits/profiles";
import { getAudit, isUuid } from "@/server/audits/store";
import { env } from "@/server/env";
import { isCrossSiteRequest, readBodyWithLimit, UploadBodyError } from "@/server/package-io/http";
import { actorOf } from "@/server/spaces/actor";
import { getSpaceByAlias } from "@/server/spaces/queries";

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const problem = (status: number, title: string, body: string) => json(status, { error: { title, body } });

/** Multipart framing on top of the policy's upload cap. */
const FRAMING_BYTES = 1024 * 1024;
const MAX_FILES = 500;

/**
 * Upload ground truth for a draft audit (pages/audit-new.md, "Ground truth
 * card"): files or zips in the `files` field of a multipart form. Needs
 * `audits.run` in the space. The body is read only after the permission
 * check, up to `maxEvidenceUploadBytes` plus framing; the service applies the
 * cap to the files and the zip rules. 200 with the match report, or
 * `{ error: { title, body } }`.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/spaces/[alias]/audits/[auditId]/ground-truth">) {
  try {
    const { alias, auditId } = await ctx.params;
    // Outside proxy.ts: check the session before revealing whether the space exists.
    await requireUser();
    const space = await getSpaceByAlias(decodeParam(alias));
    if (!space || !isUuid(auditId)) return problem(404, "There is no such audit", "Check the address and try again.");
    const user = await requirePermission("audits.run", space.id);
    if (isCrossSiteRequest(req, env().allowedOrigins)) return problem(403, "The upload came from another site", "Upload the files from this app's audit page.");
    const audit = await getAudit(space.id, auditId);
    if (!audit) return problem(404, "There is no such audit", "Check the address and try again.");
    if (audit.state === "finalized") return problem(409, "The audit is finalized", "Start a new audit to use new ground truth.");
    const cap = (await loadedPolicyForSpace(space.id)).policy.audits.maxEvidenceUploadBytes;
    const mb = Math.floor(cap / 1048576);

    let form: FormData;
    try {
      const body = await readBodyWithLimit(req, cap + FRAMING_BYTES);
      const type = req.headers.get("content-type");
      if (!type || !/^multipart\/form-data\s*;/i.test(type)) return problem(400, "The upload could not be read", "Send the files as a form upload.");
      form = await new Response(new Uint8Array(body), { headers: { "content-type": type } }).formData();
    } catch (err) {
      if (err instanceof UploadBodyError) {
        return problem(413, err.kind === "too-large" ? `The upload is larger than ${mb} MB` : "The upload was cut off", err.kind === "too-large" ? "Upload fewer files at a time, or a smaller zip." : "Try again.");
      }
      return problem(400, "The upload could not be read", "Choose the files again and retry.");
    }

    const files: UploadFile[] = [];
    for (const v of form.getAll("files")) {
      if (typeof v === "string") continue;
      if (files.length >= MAX_FILES) return problem(400, `Upload at most ${MAX_FILES} files at a time`, "Put them in a zip, or upload them in parts.");
      files.push({ fileName: v.name || "upload", bytes: Buffer.from(await v.arrayBuffer()) });
    }
    const report = await uploadGroundTruth(actorOf(user), space.id, files, { auditId });
    return json(200, { report });
  } catch (err) {
    if (err instanceof AuthError) return problem(err.status, err.status === 401 ? "You are signed out" : "You can't upload ground truth in this space", err.status === 401 ? "Sign in and try again." : "Ask an Admin for a role that can run audits.");
    if (err instanceof AuditRequestError) return problem(err.code === "not-found" ? 404 : 422, "The upload was not stored", err.message);
    throw err;
  }
}
