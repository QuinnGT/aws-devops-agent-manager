import { defineJob, type JobDefinition } from "@/server/jobs/registry";
import { VERIFY_QUEUES } from "./config";
import { runVerifyLive } from "./live-job";
import { runVerifyReads } from "./reads-job";
import { verifyJobInput } from "./run";

/**
 * Jobs for the verify module. src/worker/handlers.ts
 * lists `jobs`. A retried job finds its verification run and finishes it; a
 * run that already finished returns its state.
 */

/** verify.live: sync the space, then compare the release with the live index. */
export const verifyLiveJob = defineJob({
  name: VERIFY_QUEUES.live,
  input: verifyJobInput,
  options: { retryLimit: 1, retryDelay: 60, expireInSeconds: 30 * 60, localConcurrency: 1 },
  handler: (input, ctx) => runVerifyLive(input, ctx),
});

/** verify.reads: the deployed-vs-read analyzer on the investigations that ran on the release, aggregated per file. */
export const verifyReadsJob = defineJob({
  name: VERIFY_QUEUES.reads,
  input: verifyJobInput,
  options: { retryLimit: 1, retryDelay: 60, expireInSeconds: 60 * 60, localConcurrency: 1 },
  handler: (input, ctx) => runVerifyReads(input, ctx),
});

export const VERIFY_JOBS = { live: verifyLiveJob, reads: verifyReadsJob } as const;

export const jobs: JobDefinition[] = [verifyLiveJob, verifyReadsJob] as JobDefinition[];
