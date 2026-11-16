import type { z } from "zod";
import { policyForSpace } from "@/server/analyzers/service";
import { enqueue as enqueueJob } from "@/server/jobs/enqueue";
import type { JobContext, JobDefinition } from "@/server/jobs/registry";
import type { Policy } from "@/server/policy";
import { VERIFY } from "./config";
import { verifyReadsJob } from "./jobs";
import { insertVerification, investigationsInWindow, loadReleaseWindow, openVerification, releaseForAuto, updateVerification } from "./queries";

/**
 * Check 2 runs by itself when new journals land (policy verify.reads.auto):
 * after a journal export or import adds investigations to a space, queue
 * verify.reads for the chosen release. Not a person's action, so no audit
 * event; the run records the job that triggered it.
 */

export type AutoOutcome =
  | { queued: true; verificationId: string; runId: string }
  | { queued: false; reason: "off" | "no-release" | "already-open" | "no-journals" };

export interface AutoDeps {
  policy?: Pick<Policy, "verify">;
  enqueue?: (input: { verificationId: string }, opts: { actor: { email: string }; spaceId: string }) => Promise<string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function queueReadsAfterJournals(spaceId: string, trigger: { runId: string }, deps: AutoDeps = {}): Promise<AutoOutcome> {
  const policy = deps.policy ?? (await policyForSpace(spaceId));
  const auto = policy.verify.reads.auto;
  if (!auto.enabled) return { queued: false, reason: "off" };
  const release = await releaseForAuto(spaceId, auto.release);
  if (!release) return { queued: false, reason: "no-release" };
  if (await openVerification(spaceId, release.id, "reads")) return { queued: false, reason: "already-open" };
  const window = await loadReleaseWindow(spaceId, release, policy.verify.reads.window);
  const { total } = await investigationsInWindow(spaceId, window.from, window.to, 1);
  if (!total) return { queued: false, reason: "no-journals" };

  const row = await insertVerification({
    spaceId,
    releaseId: release.id,
    kind: "reads",
    trigger: "journals",
    requestedBy: VERIFY.autoActor.email,
    triggeredByRunId: UUID.test(trigger.runId) ? trigger.runId : null,
  });
  const send = deps.enqueue ?? ((input, opts) => enqueueJob(verifyReadsJob, input, opts));
  const runId = await send({ verificationId: row.id }, { actor: VERIFY.autoActor, spaceId });
  await updateVerification(row.id, { jobRunId: runId });
  return { queued: true, verificationId: row.id, runId };
}

/**
 * A journal job that queues the check after it finishes, when `landed` says
 * the run added journals. A failure to queue is logged and never fails the
 * journal job. Used by src/server/journals/jobs.ts.
 */
export function withReadsCheckAfter<S extends z.ZodType, R>(
  job: JobDefinition<S, R>,
  landed: (result: R) => boolean,
  queue: (spaceId: string, trigger: { runId: string }) => Promise<unknown> = queueReadsAfterJournals,
): JobDefinition<S, R> {
  return {
    ...job,
    handler: async (input: z.output<S>, ctx: JobContext) => {
      const result = await job.handler(input, ctx);
      if (ctx.spaceId && landed(result)) {
        try {
          await queue(ctx.spaceId, { runId: ctx.runId });
        } catch (err) {
          ctx.log("verify.reads was not queued after new journals", { message: err instanceof Error ? err.message : String(err) });
        }
      }
      return result;
    },
  };
}
