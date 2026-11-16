import { eq } from "drizzle-orm";
import { authErrorResponse, can, requireUser } from "@/server/auth/dal";
import { db } from "@/server/db/client";
import { jobRuns } from "@/server/db/schema";
import { jobStatusView } from "@/server/jobs/status";

/**
 * Job progress for the UI. The caller must be the job's actor or be able to read the job's space.
 * `error` is a plain sentence; `waitingForWorker` is true once the job has been
 * queued longer than policy api.workerWaitSeconds without a worker picking it up.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/jobs/[id]">) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "Not found" }, { status: 404 });
    const [run] = await db().select().from(jobRuns).where(eq(jobRuns.id, id));
    if (!run) return Response.json({ error: "Not found" }, { status: 404 });
    const allowed = run.actorEmail === user.email || (await can(user, "assets.read", run.spaceId));
    if (!allowed) return Response.json({ error: "Not found" }, { status: 404 });
    const view = await jobStatusView(run);
    return Response.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const r = authErrorResponse(err);
    if (r) return r;
    throw err;
  }
}
