import { defineJob, type JobDefinition } from "@/server/jobs/registry";
import { analyzersRunInput, runAnalyzersJob } from "./service";

/** analyzers.run: run analyzers over cached journals and store their output per investigation. */
export const analyzersRunJob = defineJob({
  name: "analyzers.run",
  input: analyzersRunInput,
  options: { retryLimit: 1, retryDelay: 30, expireInSeconds: 60 * 60, localConcurrency: 1 },
  handler: (input, ctx) => runAnalyzersJob(input, ctx),
});

/** Jobs for the analyzers module. Register each job with defineJob and list it here. */
export const jobs: JobDefinition[] = [analyzersRunJob as unknown as JobDefinition];
