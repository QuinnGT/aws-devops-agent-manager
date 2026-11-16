import { decodeParam } from "@/server/assets/guard";
import { AuthError, requirePermission } from "@/server/auth/dal";
import { exportFieldError, exportRequestFromSearchParams, PACKAGE_IO_PERMISSIONS, PackageIoError, packageIoStatus, previewExport } from "@/server/package-io";
import { getSpaceByAlias } from "@/server/spaces/queries";

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * The export dialog's facts for a source and layout (what goes in, what is
 * left out, whether the checks pass), without building a download or
 * writing to the audit log. Same query and permission as the download.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/spaces/[alias]/packages/export/preview">) {
  let ref: string | null = null;
  try {
    const { alias } = await ctx.params;
    const space = await getSpaceByAlias(decodeParam(alias));
    if (!space) return json(404, { error: "There is no such space.", field: null });
    await requirePermission(PACKAGE_IO_PERMISSIONS.export, space.id);
    const request = exportRequestFromSearchParams(new URL(req.url).searchParams);
    ref = request.ref ?? null;
    return json(200, { preview: await previewExport(space, request) });
  } catch (err) {
    if (err instanceof AuthError) return json(err.status, { error: err.status === 401 ? "You are signed out. Sign in and try again." : "You can't read this space's history.", field: null });
    if (err instanceof PackageIoError) {
      const f = exportFieldError(err, ref);
      return json(packageIoStatus(err.code), { error: f.message, field: f.field });
    }
    throw err;
  }
}
