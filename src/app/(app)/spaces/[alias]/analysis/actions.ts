"use server";

import { z } from "zod";
import { analyzersRunJob } from "@/server/analyzers/jobs";
import { ANALYZER_IDS } from "@/server/analyzers/registry";
import { AnalyzerRequestError, startAnalyzerRun } from "@/server/analyzers/service";
import { AuthError, requirePermission, requireUser } from "@/server/auth/dal";
import { enqueue } from "@/server/jobs/enqueue";
import { getSpaceByAlias } from "@/server/spaces/queries";

const runInput = z.object({
  alias: z.string().min(1).max(200),
  taskIds: z.array(z.string().min(1).max(300)).min(1).max(2000),
  analyzers: z.array(z.enum(ANALYZER_IDS)).min(1).optional(),
});

export type RunAnalyzersResult = { ok: true; runId: string } | { ok: false; error: string };

/** Starts an analyzers.run job for investigations in one space. Needs audits.run in that space. */
export async function runAnalyzersAction(raw: unknown): Promise<RunAnalyzersResult> {
  try {
    await requireUser();
    const parsed = runInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "Choose at least one investigation and one analyzer." };
    const space = await getSpaceByAlias(parsed.data.alias);
    if (!space) return { ok: false, error: "Space not found." };
    const user = await requirePermission("audits.run", space.id);
    const { runId } = await startAnalyzerRun(
      { email: user.email },
      space.id,
      { taskIds: parsed.data.taskIds, analyzers: parsed.data.analyzers },
      { enqueue: (input, opts) => enqueue(analyzersRunJob, input, opts) },
    );
    return { ok: true, runId };
  } catch (err) {
    if (err instanceof AuthError) {
      return { ok: false, error: err.status === 401 ? "Your session ended. Sign in again." : "You need the audits.run permission in this space." };
    }
    if (err instanceof AnalyzerRequestError) return { ok: false, error: err.message };
    throw err;
  }
}
