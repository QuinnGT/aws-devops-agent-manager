import { decodeParam } from "@/server/assets/guard";
import { AuthError, requirePermission } from "@/server/auth/dal";
import { exportRevision, REVISION_PERMISSIONS, RevisionError, revisionDownloadHeaders } from "@/server/revisions";
import { actorOf } from "@/server/spaces/actor";
import { getSpaceByAlias } from "@/server/spaces/queries";

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

const STATUS: Partial<Record<RevisionError["code"], number>> = { "not-found": 404, "no-history": 409, "export-blocked": 409, "not-open": 409 };

/**
 * Download a revision's package at its branch head as a zip in its layout
 * (revision-detail.md, "Export package zip"). Needs `audits.read` in the
 * space (REVISION_PERMISSIONS.export), so Viewers can download it too.
 * Refused with a plain sentence while the build fails
 * (revisions.yaml export.requirePassingBuild).
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/spaces/[alias]/revisions/[revisionId]/export">) {
  try {
    const { alias, revisionId } = await ctx.params;
    const space = await getSpaceByAlias(decodeParam(alias));
    if (!space) return text(404, "There is no such space.");
    const user = await requirePermission(REVISION_PERMISSIONS.export, space.id);
    const r = await exportRevision(space, decodeParam(revisionId), actorOf(user));
    return new Response(new Uint8Array(r.zip), { headers: revisionDownloadHeaders(r) });
  } catch (err) {
    if (err instanceof AuthError) return text(err.status, err.status === 401 ? "You are signed out. Sign in and try again." : "You can't download revisions in this space.");
    if (err instanceof RevisionError) return text(STATUS[err.code] ?? 400, err.message);
    throw err;
  }
}
