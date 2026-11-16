"use server";

import { z } from "zod";
import type { ActionResult } from "@/components/plans/action-state";
import { AuthError, permissionsIn, requirePermission } from "@/server/auth/dal";
import type { Permission } from "@/server/policy";
import { actionError } from "@/server/plans/action-errors";
import { applyPermissionFor } from "@/server/plans/contract";
import { approvePlan, createRetryPlan, discardPlan, planAccessContext, recheckPlan, rejectPlan, requestApproval, startApply, updatePlanReason } from "@/server/plans/service";
import type { PlanActor } from "@/server/plans/types";
import { getSpaceByAlias } from "@/server/spaces/queries";

/**
 * Server Actions of the plan review page (pages/plan-review.md). Each looks
 * up the plan's space, checks that it is the space in the URL, checks the
 * permission with the DAL, parses input with Zod and calls the service with
 * the actor. The service enforces the buttons-by-role table again.
 */

const ref = z.object({ alias: z.string().min(1).max(200), planId: z.string().uuid() });
const reasonText = z.string().max(10_000).nullable();

async function actorFor(input: z.infer<typeof ref>, permission: Permission | ((origin: Awaited<ReturnType<typeof planAccessContext>> & object) => Permission)) {
  const [ctx, space] = await Promise.all([planAccessContext(input.planId), getSpaceByAlias(input.alias)]);
  // A plan of another space is "not found" here, like an unknown one.
  if (!ctx || !space || space.id !== ctx.spaceId) throw new AuthError(403, "Plan not found in this space");
  const user = await requirePermission(typeof permission === "function" ? permission(ctx) : permission, ctx.spaceId);
  const actor: PlanActor = { email: user.email, name: user.name, permissions: await permissionsIn(user, ctx.spaceId) };
  return { actor, spaceId: ctx.spaceId };
}

export async function recheckPlanAction(alias: string, planId: string): Promise<ActionResult> {
  try {
    const input = ref.parse({ alias, planId });
    const { actor, spaceId } = await actorFor(input, "plans.create");
    await recheckPlan({ spaceId, planId: input.planId }, actor);
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}

/** "Request approval": saves the change reason first, so the approver sees it. */
export async function requestApprovalAction(alias: string, planId: string, reason: string | null): Promise<ActionResult> {
  try {
    const input = ref.parse({ alias, planId });
    const text = reasonText.parse(reason);
    const { actor, spaceId } = await actorFor(input, "plans.create");
    await updatePlanReason({ spaceId, planId: input.planId, reason: text }, actor);
    await requestApproval({ spaceId, planId: input.planId }, actor);
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}

export async function approvePlanAction(alias: string, planId: string): Promise<ActionResult> {
  try {
    const input = ref.parse({ alias, planId });
    const { actor, spaceId } = await actorFor(input, "plans.approve");
    await approvePlan({ spaceId, planId: input.planId }, actor);
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}

export async function rejectPlanAction(alias: string, planId: string, note: string): Promise<ActionResult> {
  try {
    const input = ref.parse({ alias, planId });
    const text = z.string().max(10_000).parse(note);
    const { actor, spaceId } = await actorFor(input, "plans.approve");
    await rejectPlan({ spaceId, planId: input.planId, note: text }, actor);
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}

/** "Apply <N> changes" after the confirmation: the reason in the form replaces the plan's reason. */
export async function applyPlanAction(alias: string, planId: string, reason: string | null): Promise<ActionResult<{ applyRunId: string; writes: number }>> {
  try {
    const input = ref.parse({ alias, planId });
    const text = reasonText.parse(reason);
    const { actor, spaceId } = await actorFor(input, (ctx) => applyPermissionFor(ctx.origin));
    const r = await startApply({ spaceId, planId: input.planId, reason: text }, actor);
    return { ok: true, ...r };
  } catch (err) {
    return actionError(err);
  }
}

export async function discardPlanAction(alias: string, planId: string): Promise<ActionResult> {
  try {
    const input = ref.parse({ alias, planId });
    const { actor, spaceId } = await actorFor(input, "plans.create");
    await discardPlan({ spaceId, planId: input.planId }, actor);
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}

/** "Create a plan for the failed items": returns the new plan to open. */
export async function retryFailedAction(alias: string, planId: string): Promise<ActionResult<{ planId: string }>> {
  try {
    const input = ref.parse({ alias, planId });
    const { actor, spaceId } = await actorFor(input, "plans.create");
    const r = await createRetryPlan({ spaceId, planId: input.planId }, actor);
    return { ok: true, planId: r.planId };
  } catch (err) {
    return actionError(err);
  }
}
