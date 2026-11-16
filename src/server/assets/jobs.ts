import type { Actor } from "@/server/aws/clients";
import { enqueue } from "@/server/jobs/enqueue";
import { defineJob, type JobDefinition } from "@/server/jobs/registry";
import { addReasonHandler, addReasonInput, prepareAddReason, type AddReasonRequest } from "./reasons";

/**
 * Jobs for the assets module.
 * src/worker/handlers.ts lists `jobs`.
 */

export const ADD_REASON_QUEUE = "assets.add-reason";

export const addReasonJob = defineJob({
  name: ADD_REASON_QUEUE,
  input: addReasonInput,
  options: { retryLimit: 3, retryDelay: 15, expireInSeconds: 10 * 60 },
  handler: addReasonHandler,
});

export const jobs: JobDefinition[] = [addReasonJob] as JobDefinition[];

/**
 * Validate and enqueue an add-reason job. The caller must have checked
 * `reasons.write` for the space. Returns the job_runs id for progress polling.
 */
export async function requestAddReason(request: AddReasonRequest, actor: Actor): Promise<{ runId: string; reasonId: string }> {
  const input = await prepareAddReason(request);
  const runId = await enqueue(addReasonJob, input, { actor, spaceId: input.spaceId });
  return { runId, reasonId: input.reasonId };
}
