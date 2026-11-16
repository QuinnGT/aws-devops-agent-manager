import { decodeParam } from "@/server/assets/guard";
import { AuthError, requirePermission, requireUser } from "@/server/auth/dal";
import { getAudit, getAuditItem, isUuid } from "@/server/audits/store";
import { getRecordText } from "@/server/audits/ui";
import { getSpaceByAlias } from "@/server/spaces/queries";

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * One journal record of an audit item, as plain text, for the incident
 * review's record card (pages/audit-item.md). Needs `audits.read`. The item
 * is looked up in the audit, and the audit in the space from the URL, so the
 * record always comes from that item's own journal.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/spaces/[alias]/audits/[auditId]/items/[itemId]/records/[n]">) {
  try {
    const { alias, auditId, itemId, n } = await ctx.params;
    await requireUser();
    const space = await getSpaceByAlias(decodeParam(alias));
    if (!space || !isUuid(auditId) || !isUuid(itemId) || !/^\d{1,7}$/.test(n)) return json(404, { error: "Not found" });
    await requirePermission("audits.read", space.id);
    const audit = await getAudit(space.id, auditId);
    const item = audit ? await getAuditItem(audit.id, itemId) : null;
    if (!item) return json(404, { error: "Not found" });
    const rec = await getRecordText(space, item.taskId, Number(n));
    if (!rec) return json(404, { error: "The journal of this investigation is not in the cache." });
    if ("missing" in rec) return json(200, { missing: true, total: rec.total });
    return json(200, { ...rec, createdAt: rec.createdAt.toISOString() });
  } catch (err) {
    if (err instanceof AuthError) return json(err.status, { error: err.status === 401 ? "Sign in again to continue." : "You can't read audits in this space." });
    throw err;
  }
}
