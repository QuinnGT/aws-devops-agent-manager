import type { JobDefinition } from "@/server/jobs/registry";
import { withReadsCheckAfter } from "@/server/verify/auto";
import { expireExportsJob } from "./expire";
import { exportJob } from "./export";
import { importJob } from "./import";

/**
 * Jobs for the journals module. An export or import that adds investigations
 * queues the release check of what the agent read (policy verify.reads.auto;
 * off by default).
 */
export const jobs: JobDefinition[] = [
  withReadsCheckAfter(exportJob, (r) => r.status === "succeeded" && r.taskCount > 0),
  withReadsCheckAfter(importJob, (r) => r.totals.imported > 0),
  expireExportsJob,
] as JobDefinition[];
