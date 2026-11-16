import type { Actor } from "@/server/aws/clients";
import { enqueue } from "@/server/jobs/enqueue";
import { defineJob, type JobDefinition } from "@/server/jobs/registry";
import { createReleaseHandler, createReleaseInput, prepareCreateRelease, type CreateReleaseRequest } from "./create";

/**
 * Jobs for the releases module.
 * src/worker/handlers.ts lists `jobs`.
 */

export const CREATE_RELEASE_QUEUE = "releases.create";

export const createReleaseJob = defineJob({
  name: CREATE_RELEASE_QUEUE,
  input: createReleaseInput,
  // No automatic retry: the dialog reports a failure ("the release wasn't created") and keeps the form,
  // so a later retry must not create the release behind the user's back. A rerun of the same input
  // still resumes by Release-Id.
  options: { retryLimit: 0, expireInSeconds: 15 * 60 },
  handler: createReleaseHandler,
});

export const jobs: JobDefinition[] = [createReleaseJob] as JobDefinition[];

/**
 * Validate and enqueue a release. The caller has checked `releases.create`
 * for the space. Pass `commit` (and `planId`) to tag the commit an apply made.
 * Returns the job_runs id for progress polling and the new release's ID.
 */
export async function requestCreateRelease(request: CreateReleaseRequest, actor: Actor): Promise<{ runId: string; releaseId: string }> {
  const input = await prepareCreateRelease(request);
  const runId = await enqueue(createReleaseJob, input, { actor, spaceId: input.spaceId });
  return { runId, releaseId: input.releaseId };
}
