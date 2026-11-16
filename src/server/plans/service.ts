import { and, eq, inArray } from "drizzle-orm";
import { recordAuditEvent } from "@/server/audit-log";
import { db } from "@/server/db/client";
import { drafts, planItems, plans } from "@/server/db/schema";
import { enqueue } from "@/server/jobs/enqueue";
import { missingRoleReason } from "@/server/auth/role-words";
import { getAppPolicy } from "@/server/policy";
import { getSpaceById, type Space } from "@/server/spaces/queries";
import { type ActionButton, planActions, type PlanActions, REASONS } from "./actions";
import { validationFailedCount } from "./check";
import { applyPermissionFor, type PlanOrigin } from "./contract";
import { createPlanInternal, type InternalPlanItemInput } from "./create";
import { planApplyJob, planCheckJob } from "./jobs";
import { OPEN_STATES } from "./states";
import { dbPlanStore } from "./store";
import { hasPermission, type PlanActor, type PlanItemRow, type PlanRow, PlanServiceError, type PlanState, type PlanSummary } from "./types";

/**
 * Service functions behind the plan page's Server Actions. Each takes the
 * acting user from the session with their permissions in the plan's space.
 * The Server Action checks the base permission with the DAL first
 * (planAccessContext gives the space ID to check); these functions enforce
 * the state rules and the actions table, so a hidden button is also refused
 * here.
 */

export interface PlanRef {
  spaceId: string;
  planId: string;
}

/** What a Server Action needs before requirePermission: the plan's space, origin and author. */
export async function planAccessContext(planId: string): Promise<{ spaceId: string; origin: PlanOrigin; createdBy: string; state: PlanState } | null> {
  const plan = await dbPlanStore.getPlan(planId);
  return plan ? { spaceId: plan.spaceId, origin: plan.origin, createdBy: plan.createdBy, state: plan.state } : null;
}

async function load(ref: PlanRef): Promise<{ plan: PlanRow; space: Space; items: PlanItemRow[] }> {
  const plan = await dbPlanStore.getPlan(ref.planId);
  if (!plan || plan.spaceId !== ref.spaceId) throw new PlanServiceError("Plan not found.", {}, 404);
  const space = await getSpaceById(plan.spaceId);
  if (!space) throw new PlanServiceError("Space not found.", {}, 404);
  return { plan, space, items: await dbPlanStore.getItems(plan.id) };
}

/** The actions table for this user and plan. */
export function actionsFor(plan: PlanRow, items: readonly PlanItemRow[], space: Pick<Space, "parsedSettings">, actor: PlanActor): PlanActions {
  const summary = plan.summary as PlanSummary | null;
  return planActions({
    plan,
    viewer: { email: actor.email, permissions: actor.permissions },
    settings: { approvalRequired: space.parsedSettings.approvalRequired },
    writeCount: summary?.writes ?? 0,
    validationFailed: validationFailedCount(summary),
    failedCount: items.filter((i) => i.progress === "failed").length,
    roleReasons: actor.role === undefined ? undefined : roleReasonsFor(plan.origin, actor.role),
  });
}

/** Disabled reasons that name the caller's role (pages pass the role; Server Actions don't need it). */
export function roleReasonsFor(origin: PlanOrigin, role: string | null): { apply: string; create: string } {
  const policy = getAppPolicy().policy;
  const applyPerm = applyPermissionFor(origin);
  return {
    apply: missingRoleReason(policy, role, applyPerm, applyPerm === "rollbacks.apply" ? "apply restore plans" : "apply plans"),
    create: missingRoleReason(policy, role, "plans.create", "change plans"),
  };
}

function ensure<A extends string>(button: ActionButton<A> | null, action: A, fallback: string): void {
  if (!button || button.action !== action) throw new PlanServiceError(fallback, {}, 409);
  if (!button.enabled) throw new PlanServiceError(button.disabledReason ?? fallback, {}, 409);
}

function audit(actor: PlanActor, action: string, plan: PlanRow, details: Record<string, unknown> = {}, result: "ok" | "error" | "denied" = "ok") {
  return recordAuditEvent({ actor: { email: actor.email, name: actor.name ?? null }, action, spaceId: plan.spaceId, targetType: "plan", targetId: plan.id, result, details });
}

async function transition(plan: PlanRow, from: readonly PlanState[], patch: Partial<typeof plans.$inferInsert>): Promise<void> {
  const ok = await dbPlanStore.updatePlan(plan.id, patch, { whereStates: from });
  if (!ok) throw new PlanServiceError("The plan changed in the meantime. Reload the page.", {}, 409);
}

/**
 * Copy the current content of each item's draft into the plan (a draft in
 * the plan was edited). The item keeps a newer base when it was rebased.
 */
async function refreshFromDrafts(items: readonly PlanItemRow[]): Promise<void> {
  const ids = items.map((i) => i.draftId).filter((d): d is string => Boolean(d));
  if (!ids.length) return;
  const rows = await db().select().from(drafts).where(inArray(drafts.id, ids));
  for (const it of items) {
    const d = rows.find((r) => r.id === it.draftId);
    if (!d) continue;
    const newerBase = d.baseVersion !== null && (it.baseVersion === null || d.baseVersion > it.baseVersion);
    await dbPlanStore.updateItem(it.id, {
      desired: d.desired,
      assetKey: d.desired.key,
      name: d.name,
      ...(newerBase ? { baseVersion: d.baseVersion, baseUpdatedAt: d.baseUpdatedAt } : {}),
    });
  }
}

/**
 * Put the plan back into "checking" and enqueue a check. Used by re-check and
 * when a draft in the plan is saved. The caller has checked permission.
 */
export async function requestCheck(plan: PlanRow, items: readonly PlanItemRow[], actor: { email: string }, opts: { rebase: boolean }): Promise<string> {
  const policy = getAppPolicy().policy;
  await refreshFromDrafts(items);
  const clearApproval = Boolean(plan.approvedAt) && policy.plans.approval.recheckClearsApproval;
  await transition(plan, ["checking", "ready", "waiting", "approved"], {
    state: "checking",
    checkError: null,
    checkRequestedBy: actor.email,
    ...(clearApproval ? { approvedAt: null, approvedBy: null, approvedByName: null } : {}),
  });
  const runId = await enqueue(planCheckJob, { planId: plan.id, rebase: opts.rebase }, { actor: { email: actor.email }, spaceId: plan.spaceId });
  await db().update(plans).set({ checkRunId: runId }).where(eq(plans.id, plan.id));
  return runId;
}

/** "Re-check live space": check again and plan conflicted items against the live version as it is now. */
export async function recheckPlan(ref: PlanRef, actor: PlanActor): Promise<{ checkRunId: string }> {
  const { plan, space, items } = await load(ref);
  ensure(actionsFor(plan, items, space, actor).recheck, "recheck", "This plan can't be re-checked now.");
  const checkRunId = await requestCheck(plan, items, actor, { rebase: true });
  await audit(actor, "plan.recheck", plan, { checkRunId });
  return { checkRunId };
}

export async function requestApproval(ref: PlanRef, actor: PlanActor): Promise<void> {
  const { plan, space, items } = await load(ref);
  ensure(actionsFor(plan, items, space, actor).primary, "request-approval", "Approval can't be requested now.");
  await transition(plan, ["ready"], {
    state: "waiting",
    approvalRequestedBy: actor.email,
    approvalRequestedAt: new Date(),
    rejectedAt: null,
    rejectedBy: null,
    rejectNote: null,
  });
  await audit(actor, "plan.approval.request", plan);
}

export async function approvePlan(ref: PlanRef, actor: PlanActor): Promise<void> {
  const { plan, space, items } = await load(ref);
  if (!hasPermission(actor, "plans.approve")) throw new PlanServiceError("You need the Publisher role to approve.", {}, 403);
  ensure(actionsFor(plan, items, space, actor).primary, "approve", "This plan can't be approved now.");
  await transition(plan, ["waiting"], { state: "approved", approvedBy: actor.email, approvedByName: actor.name ?? null, approvedAt: new Date() });
  await audit(actor, "plan.approve", plan);
}

export async function rejectPlan(ref: PlanRef & { note: string }, actor: PlanActor): Promise<void> {
  const { plan, space, items } = await load(ref);
  const policy = getAppPolicy().policy.plans;
  ensure(actionsFor(plan, items, space, actor).reject, "reject", "This plan can't be rejected now.");
  const note = ref.note.trim();
  if (policy.approval.rejectNoteRequired && !note) throw new PlanServiceError("Say why you reject the plan.", { note: "Enter a note for the author." });
  if (note.length > policy.limits.noteMaxChars) throw new PlanServiceError("The note is too long.", { note: `Keep it under ${policy.limits.noteMaxChars} characters.` });
  await transition(plan, ["waiting"], {
    state: "ready",
    approvalRequestedAt: null,
    approvalRequestedBy: null,
    rejectedBy: actor.email,
    rejectedAt: new Date(),
    rejectNote: note || null,
  });
  await audit(actor, "plan.reject", plan, { note: note || null });
}

export async function updatePlanReason(ref: PlanRef & { reason: string | null }, actor: PlanActor): Promise<void> {
  const { plan, space, items } = await load(ref);
  if (!actionsFor(plan, items, space, actor).canEditReason) throw new PlanServiceError("The change reason can't be edited now.", {}, 409);
  const reason = normalizeReason(ref.reason);
  await transition(plan, OPEN_STATES, { reason });
}

function normalizeReason(reason: string | null | undefined): string | null {
  const max = getAppPolicy().policy.plans.limits.reasonMaxChars;
  const r = reason?.trim() ?? "";
  if (r.length > max) throw new PlanServiceError("The change reason is too long.", { reason: `Keep it under ${max} characters.` });
  return r || null;
}

/**
 * "Apply <N> changes": move the plan to applying and enqueue the apply job.
 * `reason` (when given) replaces the plan's change reason first.
 */
export async function startApply(ref: PlanRef & { reason?: string | null }, actor: PlanActor): Promise<{ applyRunId: string; writes: number }> {
  const { plan, space, items } = await load(ref);
  const actions = actionsFor(plan, items, space, actor);
  if (actions.primary?.action !== "apply" && space.parsedSettings.approvalRequired && plan.state !== "approved" && OPEN_STATES.includes(plan.state)) {
    throw new PlanServiceError(REASONS.approvalFirst, {}, 409);
  }
  ensure(actions.primary, "apply", "This plan can't be applied now.");
  const reason = ref.reason !== undefined ? normalizeReason(ref.reason) : plan.reason;
  if (space.parsedSettings.changeReasonRequired && !reason) {
    throw new PlanServiceError("Enter a change reason. This space requires one.", { reason: "Enter a change reason. This space requires one." });
  }
  const from: PlanState[] = space.parsedSettings.approvalRequired ? ["approved"] : ["ready", "waiting", "approved"];
  await transition(plan, from, { state: "applying", reason, applyStartedBy: actor.email, applyStartedAt: new Date(), finishedAt: null });
  const applyRunId = await enqueue(planApplyJob, { planId: plan.id }, { actor: { email: actor.email }, spaceId: plan.spaceId });
  await db().update(plans).set({ applyRunId }).where(eq(plans.id, plan.id));
  const writes = (plan.summary as PlanSummary | null)?.writes ?? 0;
  await audit(actor, "plan.apply.start", plan, { applyRunId, writes, reason });
  return { applyRunId, writes };
}

/** "Discard plan": close it without applying. Its drafts stay saved and open. */
export async function discardPlan(ref: PlanRef, actor: PlanActor): Promise<void> {
  const { plan, space, items } = await load(ref);
  ensure(actionsFor(plan, items, space, actor).discard, "discard", "This plan can't be discarded now.");
  await transition(plan, [...OPEN_STATES, "failed"], { state: "discarded", discardedBy: actor.email, discardedAt: new Date() });
  await db()
    .update(drafts)
    .set({ status: "open", planId: null, updatedAt: new Date() })
    .where(and(eq(drafts.planId, plan.id), eq(drafts.status, "planned")));
  await audit(actor, "plan.discard", plan);
}

/** "Create a plan for the failed items" after a failed apply. Live is compared at check time. */
export async function createRetryPlan(ref: PlanRef, actor: PlanActor): Promise<{ planId: string; checkRunId: string }> {
  const { plan, space, items } = await load(ref);
  ensure(actionsFor(plan, items, space, actor).retryFailed, "retry-failed", "There are no failed items to retry.");
  const failed = items.filter((i) => i.progress === "failed");
  const upserts: InternalPlanItemInput[] = failed
    .filter((i) => i.kind === "upsert" && i.desired)
    .map((i) => ({
      desired: { ...i.desired!, ...(i.assetId ? { assetId: i.assetId } : {}) },
      baseVersion: null,
      baseUpdatedAt: null,
      removeMetadataKeys: i.removeMetadataKeys,
      note: i.note ?? undefined,
      draftId: i.draftId,
    }));
  const deletes = failed.filter((i) => i.kind === "delete" && i.assetId).map((i) => ({ assetId: i.assetId!, ...(i.note ? { note: i.note } : {}) }));
  const max = getAppPolicy().policy.plans.limits.titleMaxChars;
  const result = await createPlanInternal(
    { spaceId: plan.spaceId, title: `Retry: ${plan.title}`.slice(0, max), origin: { kind: "retry", planId: plan.id }, items: upserts, deletes, reason: plan.reason },
    actor,
    {
      inTx: async (tx, newPlanId, inserted) => {
        const draftIds = inserted.map((i) => i.draftId).filter((d): d is string => Boolean(d));
        if (draftIds.length) await tx.update(drafts).set({ status: "planned", planId: newPlanId, updatedAt: new Date() }).where(inArray(drafts.id, draftIds));
      },
    },
  );
  return result;
}

/** Plan items of a plan that came from these drafts (for the draft editor's "In plan" notice). */
export async function itemsForDrafts(draftIds: readonly string[]): Promise<{ draftId: string; planId: string }[]> {
  if (!draftIds.length) return [];
  const rows = await db()
    .select({ draftId: planItems.draftId, planId: planItems.planId })
    .from(planItems)
    .where(inArray(planItems.draftId, [...draftIds]));
  return rows.filter((r): r is { draftId: string; planId: string } => Boolean(r.draftId));
}
