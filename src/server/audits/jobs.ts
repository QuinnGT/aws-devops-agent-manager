import { enqueue } from "@/server/jobs/enqueue";
import { defineJob, type JobDefinition } from "@/server/jobs/registry";
import { auditRunInput, reviewItemInput, runAuditJob, runReviewItemJob, type EnqueueReview } from "./run";

/**
 * Jobs of the audits module. src/worker/handlers.ts lists `jobs`.
 *
 * REVIEW_WORKERS is how many reviews one worker process runs at once across
 * all audits (pg-boss localConcurrency, fixed when the worker starts). Each
 * audit is further held to its profile's review.concurrency by dispatch (see
 * run.ts), so the effective limit for one audit is the smaller of the two.
 */
export const AUDIT_RUN_QUEUE = "audits.run";
export const AUDIT_REVIEW_ITEM_QUEUE = "audits.review-item";
export const REVIEW_WORKERS = 8;

const enqueueReview: EnqueueReview = (input, opts) => enqueue(auditReviewItemJob, input, opts);

export const auditRunJob = defineJob({
  name: AUDIT_RUN_QUEUE,
  input: auditRunInput,
  // A retry picks up the items that were not analyzed yet; analyzers skip unchanged reruns.
  options: { retryLimit: 2, retryDelay: 30, expireInSeconds: 2 * 60 * 60, localConcurrency: 2 },
  handler: (input, ctx) => runAuditJob(input, ctx, { enqueueReview }),
});

export const auditReviewItemJob = defineJob({
  name: AUDIT_REVIEW_ITEM_QUEUE,
  input: reviewItemInput,
  // The review's own timeout (profile review.timeoutSeconds, at most a few minutes in practice) sits well inside this.
  options: { retryLimit: 1, retryDelay: 60, expireInSeconds: 60 * 60, localConcurrency: REVIEW_WORKERS },
  handler: (input, ctx) => runReviewItemJob(input, ctx, { enqueueReview }),
});

export { enqueueReview };

export const jobs: JobDefinition[] = [auditRunJob, auditReviewItemJob] as unknown as JobDefinition[];
