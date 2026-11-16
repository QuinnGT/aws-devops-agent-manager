import { z } from "zod";
import { getViewerZone } from "@/components/common/viewer-zone";
import { recordAuditEvent } from "@/server/audit-log";
import { authErrorResponse, can, requireUser } from "@/server/auth/dal";
import { actorOf } from "@/server/spaces/actor";
import { auditExportStream, auditFilterSchema, resolveAuditScope } from "@/server/spaces/audit-log";
import { listSpaces } from "@/server/spaces/queries";

const formatSchema = z.enum(["csv", "json"]).default("csv");

/**
 * Audit log export as CSV or JSON (auditlog.read). A caller with the global
 * permission gets every event; a caller bound per space gets only those
 * spaces' events. The same filters as the audit log page apply, with the
 * `from` and `to` days in the caller's time zone, as on the page.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const params = Object.fromEntries(new URL(req.url).searchParams);
    const format = formatSchema.safeParse(params.format || undefined);
    const filter = auditFilterSchema.safeParse(params);
    if (!format.success || !filter.success) return Response.json({ error: "Invalid export parameters" }, { status: 400 });

    const spaces = await listSpaces();
    const scope = await resolveAuditScope(
      spaces.map((s) => s.id),
      (spaceId) => can(user, "auditlog.read", spaceId),
    );
    if (!scope) return Response.json({ error: "Missing permission auditlog.read" }, { status: 403 });

    const { timeZone } = await getViewerZone();
    const { before: _before, ...filterDetails } = filter.data;
    await recordAuditEvent({
      actor: actorOf(user),
      action: "auditlog.export",
      spaceId: filter.data.space?.length === 1 ? filter.data.space[0] : null,
      details: { format: format.data, filter: filterDetails, timeZone, scope: scope.all ? "all" : scope.spaceIds },
    });

    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(auditExportStream(format.data, { ...filter.data, before: undefined }, scope, { timeZone }), {
      headers: {
        "Content-Type": format.data === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="audit-log-${stamp}.${format.data}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
}
