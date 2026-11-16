import { decodeParam } from "@/server/assets/guard";
import { AuthError, requirePermission } from "@/server/auth/dal";
import { exportDownloadHeaders, exportPackage, exportRequestFromSearchParams, PACKAGE_IO_PERMISSIONS, PackageIoError, packageIoStatus, refusalText } from "@/server/package-io";
import { actorOf } from "@/server/spaces/actor";
import { getSpaceByAlias } from "@/server/spaces/queries";

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

/**
 * Download the space as a package zip (pages/package-import.md, "Export
 * dialog"): `?ref=<HEAD | commit | release tag>&layout=<name>&name=<package
 * name>`. Needs `history.read` in the space. When the package fails its
 * checks and policy blocks it (`export.blockOnFailedChecks`), or the request
 * is refused, the reason comes back as plain text for the dialog to show.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/spaces/[alias]/packages/export">) {
  try {
    const { alias } = await ctx.params;
    const space = await getSpaceByAlias(decodeParam(alias));
    if (!space) return text(404, "There is no such space.");
    const user = await requirePermission(PACKAGE_IO_PERMISSIONS.export, space.id);
    const request = exportRequestFromSearchParams(new URL(req.url).searchParams);
    const r = await exportPackage(space, request, actorOf(user));
    return new Response(new Uint8Array(r.zip), { headers: exportDownloadHeaders(r) });
  } catch (err) {
    if (err instanceof AuthError) return text(err.status, err.status === 401 ? "You are signed out. Sign in and try again." : "You can't read this space's history, so you can't export it.");
    if (err instanceof PackageIoError) return text(packageIoStatus(err.code), refusalText(err));
    throw err;
  }
}
