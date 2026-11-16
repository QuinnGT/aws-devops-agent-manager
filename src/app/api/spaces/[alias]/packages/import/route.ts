import { decodeParam } from "@/server/assets/guard";
import { AuthError, requirePermission, requireUser } from "@/server/auth/dal";
import { env } from "@/server/env";
import { policyForSpace } from "@/server/journals/policy";
import {
  bodyProblem,
  importPackage,
  importProblem,
  importRequestFromForm,
  isCrossSiteRequest,
  PACKAGE_IO_PERMISSIONS,
  PackageIoError,
  packageIoStatus,
  parseMultipart,
  readBodyWithLimit,
  recordRefusedUpload,
  UploadBodyError,
  uploadBodyLimit,
  type UploadProblem,
} from "@/server/package-io";
import { actorOf } from "@/server/spaces/actor";
import { getSpaceByAlias } from "@/server/spaces/queries";

const problem = (status: number, p: UploadProblem, extra: Record<string, unknown> = {}) => Response.json({ error: p, ...extra }, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Upload a package (pages/package-import.md, "Reading"): a zip in `file`,
 * or a folder as `files` plus `paths`, and an optional `layout`. Needs
 * `plans.create` in the space. The body is read only after the permission
 * check, up to the package caps (limits.yaml `packageRead`) plus multipart
 * framing; a larger or cut-off body is refused with 413 and never parsed.
 *
 * 200 `{ importId, status }` when the result page can show the import; 4xx
 * `{ error: { title, body, field?, results? }, importId? }` otherwise.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/spaces/[alias]/packages/import">) {
  try {
    const { alias } = await ctx.params;
    // This route is outside proxy.ts, so check the session before revealing whether the space exists.
    await requireUser();
    const space = await getSpaceByAlias(decodeParam(alias));
    if (!space) return problem(404, { title: "There is no such space", body: "Check the address and try again." });
    const user = await requirePermission(PACKAGE_IO_PERMISSIONS.import, space.id);
    if (isCrossSiteRequest(req, env().allowedOrigins)) return problem(403, { title: "The upload came from another site", body: "Upload the package from this app's import page." });
    const { policy } = await policyForSpace(space);
    const limits = policy.limits.packageRead;
    const limit = uploadBodyLimit(limits);

    let form: FormData;
    try {
      form = await parseMultipart(await readBodyWithLimit(req, limit), req.headers.get("content-type"));
    } catch (err) {
      if (!(err instanceof UploadBodyError)) throw err;
      await recordRefusedUpload(space, actorOf(user), { reason: err.kind, sizeBytes: err.declared ?? err.received, limitBytes: limit });
      return problem(413, bodyProblem(err, limits));
    }

    const request = await importRequestFromForm(form);
    const result = await importPackage(space, request, actorOf(user));
    const upload = request.upload;
    const sizeBytes = upload.kind === "zip" ? upload.bytes.length : upload.files.reduce((n, f) => n + f.data.length, 0);
    const layoutName = result.layout ?? request.layout ?? policy.packageLayouts.defaultLayout;
    const layoutLabel = (layoutName && policy.packageLayouts.layouts[layoutName]?.label) || layoutName || "the layout";
    const p = importProblem(result, { layoutLabel, kind: upload.kind, sizeBytes, limits });
    if (p) return problem(422, p, { importId: result.importId });
    return Response.json({ importId: result.importId, status: result.status }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof AuthError) return problem(err.status, { title: err.status === 401 ? "You are signed out" : "You can't import packages in this space", body: err.status === 401 ? "Sign in and try again." : "Ask an Admin for a role that can create plans in this space." });
    if (err instanceof PackageIoError) {
      return problem(packageIoStatus(err.code), {
        title: err.code === "unknown-layout" ? "Choose a layout from the list" : "The upload could not be read",
        body: err.message,
        field: err.code === "unknown-layout" ? "layout" : "file",
      });
    }
    throw err;
  }
}
