import { eq } from "drizzle-orm";
import { analyzersRunJob } from "@/server/analyzers/jobs";
import { startAnalyzerRun } from "@/server/analyzers/service";
import { db } from "@/server/db/client";
import { journalTasks } from "@/server/db/schema";
import { enqueue } from "@/server/jobs/enqueue";
import type { Space } from "@/server/spaces/queries";
import type { SeedPerson } from "../lib/common";
import { runQueued } from "../lib/jobs";

/** The Analysis page's part: the journal analyzers over every investigation cached in the space, run in this process. */
export async function seedAnalysis(space: Space, actor: SeedPerson): Promise<{ tasks: number; result: unknown }> {
  const tasks = await db().select({ taskId: journalTasks.taskId }).from(journalTasks).where(eq(journalTasks.spaceId, space.id));
  if (!tasks.length) return { tasks: 0, result: null };
  const { runId } = await startAnalyzerRun(actor, space.id, { taskIds: tasks.map((t) => t.taskId) }, { enqueue: (input, opts) => enqueue(analyzersRunJob, input, opts) });
  const result = await runQueued(runId, "analyzers");
  return { tasks: tasks.length, result };
}
