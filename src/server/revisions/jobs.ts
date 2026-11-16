import { defineJob, type JobDefinition } from "@/server/jobs/registry";
import { onPlanApplied } from "@/server/plans/hooks";
import { createRevisionHandler, createRevisionInput } from "./create";
import { tagReleaseAfterApply } from "./release";
import { saveRevisionHandler, saveRevisionInput } from "./save";

/**
 * Jobs of the revisions module. src/worker/handlers.ts lists `jobs`; loading
 * this file in the worker also registers the plan-applied hook that tags a
 * release after a revision's plan is applied.
 */

export const CREATE_REVISION_QUEUE = "revisions.create";
export const SAVE_REVISION_QUEUE = "revisions.save";

export const createRevisionJob = defineJob({
  name: CREATE_REVISION_QUEUE,
  input: createRevisionInput,
  // Resumable (the first commit carries Revision-Id), so one retry is safe.
  options: { retryLimit: 1, retryDelay: 30, expireInSeconds: 30 * 60 },
  handler: (input, ctx) => createRevisionHandler(input, ctx),
});

export const saveRevisionJob = defineJob({
  name: SAVE_REVISION_QUEUE,
  input: saveRevisionInput,
  // One save at a time per revision; later saves wait in the queue. Retried saves find their own
  // commit by Revision-Change-Id, and a save refused for a moved branch fails without a retry loop.
  options: { retryLimit: 1, retryDelay: 10, expireInSeconds: 15 * 60, queuePolicy: "singleton", singletonKey: (input) => input.revisionId },
  handler: saveRevisionHandler,
});

onPlanApplied(async (event) => {
  await tagReleaseAfterApply(event);
});

export const jobs: JobDefinition[] = [createRevisionJob, saveRevisionJob] as JobDefinition[];
