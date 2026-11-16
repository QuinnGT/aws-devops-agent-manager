import { z } from "zod";
import { decodeParam } from "@/server/assets/guard";
import { AuditReportError, checkAuditReportExport, exportAuditReport, REPORT_PERMISSIONS } from "@/server/audit-reports";
import { AuthError, requirePermission } from "@/server/auth/dal";
import { actorOf } from "@/server/spaces/actor";
import { getSpaceByAlias } from "@/server/spaces/queries";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;
const json = (status: number, body: unknown) => Response.json(body, { status, headers: HEADERS });
const problem = (status: number, error: string) => json(status, { error });

const query = z.object({
  audience: z.enum(["shareable", "internal"]),
  check: z.enum(["1"]).optional(),
});

/**
 * The audit report's HTML export (pages/audit-report.md, "Export dialog"):
 * `?audience=shareable|internal`. Needs `audits.read` in the space: an export
 * is a read, as journal exports are. The output rules run first; a refused
 * export answers 422 with what they found and where. A passing export
 * answers with the file name and the HTML, which the dialog saves as a
 * download; it is never rendered in this app. `&check=1` runs only the
 * check, so the page can show what a refused export found.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/spaces/[alias]/audits/[auditId]/report/export">) {
  try {
    const { alias, auditId } = await ctx.params;
    const space = await getSpaceByAlias(decodeParam(alias));
    if (!space) return problem(404, "There is no such space.");
    const user = await requirePermission(REPORT_PERMISSIONS.export, space.id);
    const url = new URL(req.url);
    const q = query.safeParse({ audience: url.searchParams.get("audience") ?? undefined, check: url.searchParams.get("check") ?? undefined });
    if (!q.success) return problem(400, "Choose the Shareable or Internal audience.");
    if (!z.string().uuid().safeParse(auditId).success) return problem(404, "This audit doesn't exist in this space.");
    const input = { spaceId: space.id, auditId, audience: q.data.audience };

    if (q.data.check) {
      const r = await checkAuditReportExport(input);
      return json(200, { ok: r.ok, violations: r.violations, warnings: r.warnings });
    }
    const r = await exportAuditReport(input, actorOf(user));
    if (!r.ok) return json(422, { ok: false, violations: r.violations, warnings: r.warnings });
    return json(200, { ok: true, fileName: r.fileName, html: r.html, warnings: r.warnings, unapproved: r.unapproved });
  } catch (err) {
    if (err instanceof AuthError) return problem(err.status, err.status === 401 ? "You are signed out. Sign in and try again." : "You can't read this space's audits, so you can't export this report.");
    if (err instanceof AuditReportError) return problem(err.code === "not-found" ? 404 : 400, err.code === "not-found" ? "This audit doesn't exist in this space." : err.message);
    throw err;
  }
}
