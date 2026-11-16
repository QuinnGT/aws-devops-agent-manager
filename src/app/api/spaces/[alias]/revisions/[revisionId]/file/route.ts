import { decodeParam } from "@/server/assets/guard";
import { authErrorResponse, requirePermission } from "@/server/auth/dal";
import { REVISION_PERMISSIONS } from "@/server/revisions";
import { readRevisionFile } from "@/server/revisions/views";
import { getSpaceByAlias } from "@/server/spaces/queries";

const notFound = () => Response.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });

/**
 * One package file of a revision at its branch head, as JSON for the
 * editor's file switch: `?path=<package path>`. Needs `audits.read` in the
 * space. The text is untrusted package content; the editor shows it in a
 * textarea only.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/spaces/[alias]/revisions/[revisionId]/file">) {
  try {
    const { alias, revisionId } = await ctx.params;
    const space = await getSpaceByAlias(decodeParam(alias));
    if (!space) return notFound();
    await requirePermission(REVISION_PERMISSIONS.read, space.id);
    const filePath = new URL(req.url).searchParams.get("path") ?? "";
    if (!filePath || filePath.length > 4096) return notFound();
    const file = await readRevisionFile(space, decodeParam(revisionId), filePath);
    if (!file) return notFound();
    return Response.json(file, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
}
