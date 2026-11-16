import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { authErrorResponse, requirePermission } from "@/server/auth/dal";
import { attachmentHeader, openExportDownload } from "@/server/journals/download";
import { getSpaceByAlias } from "@/server/spaces/queries";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Download one export zip. The caller needs `journals.export` in the space
 * that owns the export; every attempt is written to the audit log.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/spaces/[alias]/journals/exports/[id]/download">) {
  try {
    const { alias, id } = await ctx.params;
    const space = await getSpaceByAlias(alias);
    if (!space || !UUID.test(id)) return Response.json({ error: "Not found" }, { status: 404 });
    const user = await requirePermission("journals.export", space.id);
    const d = await openExportDownload(space, id, { email: user.email });
    if (!d.ok) return Response.json({ error: d.reason }, { status: d.status });
    const body = Readable.toWeb(createReadStream(d.absPath)) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": attachmentHeader(d.fileName),
        "Content-Length": String(d.sizeBytes),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
}
