import { defineJob, type JobDefinition } from "@/server/jobs/registry";
import { CONNECTION_TEST_QUEUE, connectionTestInput, runConnectionTest } from "./connection-test";

/** Connection test for one space. One at a time per space; no retries (an Admin re-runs it). */
export const connectionTestJob = defineJob({
  name: CONNECTION_TEST_QUEUE,
  input: connectionTestInput,
  options: { retryLimit: 0, expireInSeconds: 10 * 60, singletonKey: (i) => i.spaceId },
  handler: (input, ctx) => runConnectionTest(input, ctx),
});

/** Jobs for the spaces module. Register each job with defineJob and list it here. */
export const jobs: JobDefinition[] = [connectionTestJob as unknown as JobDefinition];
