import { z } from "zod";
import { recordAuditEvent } from "@/server/audit-log";
import { defineJob, type JobDefinition } from "@/server/jobs/registry";
import { getSpaceById } from "@/server/spaces/queries";
import { runPlanApply } from "./apply";
import { runPlanCheck } from "./check";
import { notifyPlanApplied } from "./hooks";
import { applyDepsFor, checkDepsFor } from "./runtime";
import { dbPlanStore } from "./store";

/**
 * Jobs of the plans module. src/worker/handlers.ts lists `jobs`.
 * Both run in the worker: the check with the space's read role, apply with
 * the write role for writes (actor: the user who started the job).
 */

export const PLAN_CHECK_QUEUE = "plans.check";
export const PLAN_APPLY_QUEUE = "plans.apply";

export const planCheckInput = z.object({
  planId: z.string().uuid(),
  /** Plan against live as it is now (re-check from the conflict callout) */
  rebase: z.boolean().default(false),
});

export const planApplyInput = z.object({ planId: z.string().uuid() });

async function spaceOfPlan(planId: string) {
  const plan = await dbPlanStore.getPlan(planId);
  if (!plan) throw new Error(`Plan ${planId} not found.`);
  const space = await getSpaceById(plan.spaceId);
  if (!space) throw new Error(`The space of plan ${planId} is not registered.`);
  return { plan, space };
}

export const planCheckJob = defineJob({
  name: PLAN_CHECK_QUEUE,
  input: planCheckInput,
  options: { retryLimit: 2, retryDelay: 20, expireInSeconds: 30 * 60 },
  handler: async (input, ctx) => {
    const { space } = await spaceOfPlan(input.planId);
    await ctx.progress(0.1, "Reading the live space");
    try {
      const outcome = await runPlanCheck(input.planId, { runId: ctx.runId, rebase: input.rebase }, await checkDepsFor(space, ctx.actor));
      if (outcome.status === "checked") {
        await recordAuditEvent({ actor: ctx.actor, action: "plan.check", spaceId: space.id, targetType: "plan", targetId: input.planId, details: { summary: outcome.summary, rebase: input.rebase } });
      }
      await ctx.progress(1, outcome.status === "checked" ? "Checked against the live space" : outcome.reason);
      return outcome;
    } catch (err) {
      await recordAuditEvent({
        actor: ctx.actor,
        action: "plan.check",
        spaceId: space.id,
        targetType: "plan",
        targetId: input.planId,
        result: "error",
        details: { error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300) },
      });
      throw err;
    }
  },
});

export const planApplyJob = defineJob({
  name: PLAN_APPLY_QUEUE,
  input: planApplyInput,
  // Retries resume: finished items are not written again, started ones re-send the same clientTokens.
  options: { retryLimit: 3, retryDelay: 30, expireInSeconds: 2 * 60 * 60 },
  handler: async (input, ctx) => {
    const { space } = await spaceOfPlan(input.planId);
    const deps = await applyDepsFor(space, ctx.actor);
    const outcome = await runPlanApply(input.planId, { runId: ctx.runId, actor: ctx.actor }, { ...deps, progress: ctx.progress, cancelled: ctx.cancelled, log: ctx.log });
    // "skipped" covers a retried job that finds the plan already applied; the hooks check the plan state themselves.
    if (outcome.status === "applied" || outcome.status === "skipped") {
      await notifyPlanApplied({ planId: input.planId, spaceId: space.id, actor: ctx.actor, log: ctx.log });
    }
    return outcome;
  },
});

export const jobs: JobDefinition[] = [planCheckJob, planApplyJob] as JobDefinition[];
