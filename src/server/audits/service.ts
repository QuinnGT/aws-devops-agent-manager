import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { MODEL_ID_PATTERN, NO_REVIEW_MODEL_REASON } from "@/server/ai/models";
import { noCredentialsText } from "@/server/ai/error-kind";
import { recordAuditEvent } from "@/server/audit-log";
import type { Actor } from "@/server/aws/clients";
import { db } from "@/server/db/client";
import { auditItems, audits, findings, jobRuns } from "@/server/db/schema";
import { boss } from "@/server/jobs/boss";
import { enqueue } from "@/server/jobs/enqueue";
import { bedrockBlocksStart, checkBedrock, type ListCatalog } from "./bedrock-check";
import { AuditRequestError } from "./errors";
import { rerunCanHelp, reviewFailureKind } from "./failure";
import { auditRunJob, enqueueReview } from "./jobs";
import { getProfile, loadedPolicyForSpace } from "./profiles";
import { dispatchReviews } from "./run";
import { assertWithinLimit, assignCohorts, resolveSelection, selectionSchema, type SelectedItem } from "./selection";
import { modelsForRunner, resolveReviewer, withReviewer } from "./reviewers";
import { auditStateReason, canCancelAudit, canDeleteAudit, canEditSelection, canRerunItem, canStartAudit, HANDOFF_RERUN_REASON, type AuditItemState } from "./states";
import { getSpaceById } from "@/server/spaces/queries";
import type { AuditProfile } from "@/server/policy/sections/audits";
import { getAudit, getAuditItem, listAuditItems, profileOf, readinessOf, type AuditRow } from "./store";

/**
 * The audit lifecycle: create a draft from a
 * selection of investigations, start it, cancel it, delete a draft, review one
 * item again. The caller holds `audits.run` for the space; every function
 * takes the actor and records an audit event.
 */

export const createAuditInput = z.object({
  name: z.string().trim().min(1, "Give the audit a name.").max(200),
  profileId: z.string().trim().min(1).max(100).optional(),
  note: z.string().trim().max(2000).optional(),
  selections: z.array(selectionSchema).min(1, "Choose at least one group of investigations.").max(20),
  /** The audit's own models; empty uses the space default (src/server/ai/models.ts) */
  reviewModelId: z.string().trim().regex(MODEL_ID_PATTERN, "Enter a Bedrock model ID or inference profile ID.").nullish(),
  reportModelId: z.string().trim().regex(MODEL_ID_PATTERN, "Enter a Bedrock model ID or inference profile ID.").nullish(),
  /** Who writes the reviews (policy.audits.reviewers); empty uses the profile's runner. Checked against policy. */
  runner: z.string().trim().max(50).nullish(),
  /** The runner's option values by option ID; options left out take the policy's default */
  runnerOptions: z.record(z.string().max(100), z.string().max(100)).nullish(),
});

export type CreateAuditInput = z.input<typeof createAuditInput>;

function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new AuditRequestError("invalid", r.error.issues[0]?.message ?? "The request is not valid.");
  return r.data;
}

async function auditOrThrow(spaceId: string, auditId: string): Promise<AuditRow> {
  const a = await getAudit(spaceId, auditId);
  if (!a) throw new AuditRequestError("not-found", "The audit is not in this space.");
  return a;
}

type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

async function insertItems(tx: Tx | ReturnType<typeof db>, auditId: string, spaceId: string, items: SelectedItem[]): Promise<void> {
  for (let i = 0; i < items.length; i += 500) {
    await tx
      .insert(auditItems)
      .values(items.slice(i, i + 500).map((it) => ({ auditId, spaceId, taskId: it.taskId, incidentId: it.incidentId, cohort: it.cohort })));
  }
}

/** The profile with the audit's models written in, as stored in audits.profile_snapshot. */
function withModels(profile: AuditProfile, reviewModelId: string | null, reportModelId: string | null): AuditProfile {
  const review = { ...profile.review };
  if (reviewModelId) review.modelId = reviewModelId;
  else delete review.modelId;
  const report = { ...profile.report };
  if (reportModelId) report.modelId = reportModelId;
  else delete report.modelId;
  return { ...profile, review, report };
}

/** Create a draft audit. The profile is snapshotted now, so a later policy edit does not change this audit. */
export async function createAudit(actor: Actor, spaceId: string, input: CreateAuditInput): Promise<{ auditId: string; items: number }> {
  const req = parseOrThrow(createAuditInput, input);
  const loaded = await loadedPolicyForSpace(spaceId);
  const { id: profileId, profile: policyProfile } = getProfile(loaded.policy, req.profileId);
  const reviewer = resolveReviewer(loaded.policy, policyProfile, { runner: req.runner, runnerOptions: req.runnerOptions });
  // The resolved models go into the snapshot, so the audit keeps them if the space default changes later.
  const space = await getSpaceById(spaceId);
  const models = modelsForRunner(reviewer.runner, policyProfile, space?.parsedSettings, { reviewModelId: req.reviewModelId, reportModelId: req.reportModelId });
  const profile = withReviewer(withModels(policyProfile, models.review.id, req.reportModelId || space?.parsedSettings.inference.reportModelId || policyProfile.report.modelId || null), reviewer);
  const max = loaded.policy.audits.maxItemsPerAudit;
  const groups = [];
  for (const s of req.selections) groups.push({ cohort: s.cohort ?? null, tasks: await resolveSelection(spaceId, s, max) });
  const items = assignCohorts(groups, profile);
  assertWithinLimit(items.length, max);

  const auditId = await db().transaction(async (tx) => {
    const [row] = await tx
      .insert(audits)
      .values({ spaceId, name: req.name, profileId, profileSnapshot: profile, policyDigest: loaded.digest, state: "draft", note: req.note ?? null, createdBy: actor.email })
      .returning({ id: audits.id });
    await insertItems(tx, row!.id, spaceId, items);
    return row!.id;
  });
  await recordAuditEvent({
    actor,
    action: "audit.create",
    spaceId,
    targetType: "audit",
    targetId: auditId,
    details: {
      name: req.name,
      profileId,
      policyDigest: loaded.digest,
      items: items.length,
      selections: req.selections.map((s) => s.by),
      runner: reviewer.runner,
      runnerOptions: reviewer.runnerOptions,
      reviewModelId: models.review.id,
      reviewModelSource: models.review.source,
      reportModelId: models.report.id,
      reportModelSource: models.report.source,
    },
  });
  return { auditId, items: items.length };
}

export const auditModelsInput = z.object({
  /** Empty or null: the space default (src/server/ai/models.ts) */
  reviewModelId: z.string().trim().regex(MODEL_ID_PATTERN, "Enter a Bedrock model ID or inference profile ID.").or(z.literal("")).nullish(),
  reportModelId: z.string().trim().regex(MODEL_ID_PATTERN, "Enter a Bedrock model ID or inference profile ID.").or(z.literal("")).nullish(),
  /** Who writes the reviews; left out, the audit keeps its reviewer. Checked against policy. */
  runner: z.string().trim().max(50).nullish(),
  /** The runner's option values; left out, the audit keeps its values (or the defaults for a new runner) */
  runnerOptions: z.record(z.string().max(100), z.string().max(100)).nullish(),
});

/**
 * Choose a draft's reviewer and its review and report models. Empty uses the space default as
 * it is now (then the profile's fallback). The resolved IDs are written into
 * the profile snapshot as createAudit does, and the sources go into the audit
 * event, which the audit page reads to say where each model came from. Only the
 * Bedrock runner reviews with a model; for another runner the review model is
 * left empty.
 */
export async function setAuditModels(
  actor: Actor,
  spaceId: string,
  auditId: string,
  input: z.input<typeof auditModelsInput>,
): Promise<{ review: { id: string | null; source: string | null }; report: { id: string | null; source: string | null } }> {
  const req = parseOrThrow(auditModelsInput, input);
  const audit = await auditOrThrow(spaceId, auditId);
  if (audit.state !== "draft") throw new AuditRequestError("state", `The audit is ${audit.state === "reviewing" ? "in review" : audit.state}; its models can be changed only while it is a draft.`);
  const loaded = await loadedPolicyForSpace(spaceId);
  const space = await getSpaceById(spaceId);
  // The policy's own fallbacks, not the snapshot's (which holds the earlier choice).
  const policyProfile = loaded.policy.audits.profiles[audit.profileId] ?? profileOf(audit);
  const current = profileOf(audit);
  const changesReviewer = req.runner !== undefined || req.runnerOptions !== undefined;
  let reviewer = { runner: current.review.runner, runnerOptions: current.review.runnerOptions ?? {} };
  if (changesReviewer) {
    const runner = req.runner || current.review.runner;
    const same = runner === current.review.runner;
    reviewer = resolveReviewer(loaded.policy, same ? current : policyProfile, { runner, runnerOptions: req.runnerOptions ?? (same ? current.review.runnerOptions : undefined) });
  }
  const models = modelsForRunner(reviewer.runner, policyProfile, space?.parsedSettings, { reviewModelId: req.reviewModelId || null, reportModelId: req.reportModelId || null });
  const reportId = models.report.source === "review-model" ? null : models.report.id;
  const snapshot = withReviewer(withModels(current, models.review.id, reportId), reviewer);
  const updated = await db()
    .update(audits)
    .set({ profileSnapshot: snapshot })
    .where(and(eq(audits.id, audit.id), eq(audits.state, "draft")))
    .returning({ id: audits.id });
  if (!updated.length) throw new AuditRequestError("state", "The audit is no longer a draft.");
  await recordAuditEvent({
    actor,
    action: "audit.models.set",
    spaceId,
    targetType: "audit",
    targetId: audit.id,
    details: {
      runner: reviewer.runner,
      runnerOptions: reviewer.runnerOptions,
      previousRunner: current.review.runner,
      reviewModelId: models.review.id,
      reviewModelSource: models.review.source,
      reportModelId: models.report.id,
      reportModelSource: models.report.source,
      previousReviewModelId: current.review.modelId ?? null,
      previousReportModelId: current.report.modelId ?? null,
    },
  });
  return models;
}

export const auditDraftInput = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(200),
  note: z.string().trim().max(2000).nullish(),
});

/** Rename a draft or change its note. */
export async function updateAuditDraft(actor: Actor, spaceId: string, auditId: string, input: z.input<typeof auditDraftInput>): Promise<void> {
  const req = parseOrThrow(auditDraftInput, input);
  const audit = await auditOrThrow(spaceId, auditId);
  if (audit.state !== "draft") throw new AuditRequestError("state", auditStateReason("edit", audit.state));
  const note = req.note === undefined ? audit.note : req.note || null;
  if (req.name === audit.name && note === audit.note) return;
  await db()
    .update(audits)
    .set({ name: req.name, note })
    .where(and(eq(audits.id, audit.id), eq(audits.state, "draft")));
  await recordAuditEvent({ actor, action: "audit.update", spaceId, targetType: "audit", targetId: audit.id, details: { name: req.name, renamed: req.name !== audit.name, noteChanged: note !== audit.note } });
}

/** Add investigations to a draft. Tasks already in the audit keep their cohort; a different cohort is refused. */
export async function addAuditItems(actor: Actor, spaceId: string, auditId: string, selections: unknown): Promise<{ added: number; items: number }> {
  const sels = parseOrThrow(z.array(selectionSchema).min(1).max(20), selections);
  const audit = await auditOrThrow(spaceId, auditId);
  if (!canEditSelection(audit.state)) throw new AuditRequestError("state", auditStateReason("edit", audit.state));
  const profile = profileOf(audit);
  const max = (await loadedPolicyForSpace(spaceId)).policy.audits.maxItemsPerAudit;
  const existing = await listAuditItems(audit.id);
  const groups = [];
  for (const s of sels) groups.push({ cohort: s.cohort ?? null, tasks: await resolveSelection(spaceId, s, max) });
  const asked = assignCohorts(groups, profile);
  const byTask = new Map(existing.map((e) => [e.taskId, e]));
  for (const a of asked) {
    const e = byTask.get(a.taskId);
    if (e && e.cohort !== a.cohort) throw new AuditRequestError("invalid", `Investigation ${a.taskId} is already in the audit in cohort ${e.cohort ?? "none"}.`);
  }
  const fresh = asked.filter((a) => !byTask.has(a.taskId));
  assertWithinLimit(existing.length + fresh.length, max);
  await insertItems(db(), audit.id, spaceId, fresh);
  await recordAuditEvent({ actor, action: "audit.items.add", spaceId, targetType: "audit", targetId: audit.id, details: { added: fresh.length, taskIds: fresh.map((f) => f.taskId).slice(0, 200) } });
  return { added: fresh.length, items: existing.length + fresh.length };
}

/** Remove investigations from a draft. */
export async function removeAuditItems(actor: Actor, spaceId: string, auditId: string, itemIds: string[]): Promise<{ removed: number }> {
  const audit = await auditOrThrow(spaceId, auditId);
  if (!canEditSelection(audit.state)) throw new AuditRequestError("state", auditStateReason("edit", audit.state));
  const ids = itemIds.filter((i) => /^[0-9a-f-]{36}$/i.test(i));
  if (!ids.length) return { removed: 0 };
  const removed = await db()
    .delete(auditItems)
    .where(and(eq(auditItems.auditId, audit.id), inArray(auditItems.id, ids)))
    .returning({ taskId: auditItems.taskId });
  await recordAuditEvent({ actor, action: "audit.items.remove", spaceId, targetType: "audit", targetId: audit.id, details: { removed: removed.length, taskIds: removed.map((r) => r.taskId).slice(0, 200) } });
  return { removed: removed.length };
}

export interface StartResult {
  runId: string;
  items: number;
  skipped: number;
}

/**
 * Start a draft. Every item must be ready (journal cached, required ground
 * truth stored) unless `skipIncomplete` is set, in which case the incomplete
 * ones are marked skipped with the reason. A profile with cohorts needs at
 * least one runnable item in each cohort.
 */
export async function startAudit(
  actor: Actor,
  spaceId: string,
  auditId: string,
  opts: { skipIncomplete?: boolean } = {},
  deps: { listCatalog?: ListCatalog } = {},
): Promise<StartResult> {
  const audit = await auditOrThrow(spaceId, auditId);
  if (!canStartAudit(audit.state)) throw new AuditRequestError("state", auditStateReason("start", audit.state));
  const profile = profileOf(audit);
  // Only the Bedrock reviewer needs a model and the space's credentials. Review files and the other runners do not.
  if (profile.review.runner === "ai-sdk") {
    if (!profile.review.modelId) throw new AuditRequestError("invalid", NO_REVIEW_MODEL_REASON, { missing: "reviewModel" });
    // The reviews call Bedrock with the space's credentials: with none, every review would fail at once.
    const space = await getSpaceById(spaceId);
    if (!space) throw new AuditRequestError("not-found", "The space no longer exists.");
    const bedrock = await checkBedrock(space, actor, { list: deps.listCatalog });
    if (bedrockBlocksStart(bedrock.kind)) {
      throw new AuditRequestError("not-ready", noCredentialsText(true), { bedrock: bedrock.kind, region: bedrock.region });
    }
  }
  const items = await listAuditItems(audit.id);
  if (!items.length) throw new AuditRequestError("invalid", "The audit has no investigations.");
  const readiness = await readinessOf(spaceId, items, profile);
  const notReady = readiness.filter((r) => !r.ready);
  if (notReady.length && !opts.skipIncomplete) {
    throw new AuditRequestError("not-ready", `${notReady.length} of ${items.length} investigation(s) are not ready to run.`, {
      notReady: notReady.map((r) => ({ itemId: r.itemId, taskId: r.taskId, incidentId: r.incidentId, reason: r.reason })),
    });
  }
  const runnable = new Set(readiness.filter((r) => r.ready).map((r) => r.itemId));
  if (!runnable.size) throw new AuditRequestError("not-ready", "No investigation in the audit is ready to run.");
  for (const c of profile.cohorts) {
    if (!items.some((i) => i.cohort === c.id && runnable.has(i.id))) {
      throw new AuditRequestError("not-ready", `The cohort "${c.label}" has no investigation that is ready to run.`, { cohort: c.id });
    }
  }

  const started = await db().transaction(async (tx) => {
    const [a] = await tx.select({ state: audits.state }).from(audits).where(eq(audits.id, audit.id)).for("update");
    if (!a || a.state !== "draft") return false;
    for (const r of notReady) {
      await tx
        .update(auditItems)
        .set({ state: "skipped", stateReason: r.reason })
        .where(eq(auditItems.id, r.itemId));
    }
    await tx.update(audits).set({ state: "running" }).where(eq(audits.id, audit.id));
    return true;
  });
  if (!started) throw new AuditRequestError("state", "The audit was started by someone else.");

  let runId: string;
  try {
    runId = await enqueue(auditRunJob, { auditId: audit.id }, { actor, spaceId });
  } catch (err) {
    // Put the audit back as it was, so it can be started again.
    await db().transaction(async (tx) => {
      await tx.update(audits).set({ state: "draft" }).where(eq(audits.id, audit.id));
      await tx
        .update(auditItems)
        .set({ state: "pending", stateReason: null })
        .where(and(eq(auditItems.auditId, audit.id), eq(auditItems.state, "skipped")));
    });
    throw err;
  }
  await db().update(audits).set({ runId }).where(eq(audits.id, audit.id));
  await recordAuditEvent({
    actor,
    action: "audit.start",
    spaceId,
    targetType: "audit",
    targetId: audit.id,
    details: { runId, items: runnable.size, skipped: notReady.length, profileId: audit.profileId },
  });
  return { runId, items: runnable.size, skipped: notReady.length };
}

/** Cancel job runs that have not finished; queued ones are also cancelled in pg-boss. */
export async function cancelJobRuns(runIds: string[]): Promise<number> {
  const ids = [...new Set(runIds)];
  if (!ids.length) return 0;
  const rows = await db()
    .update(jobRuns)
    .set({ status: "cancelled", message: "Cancelled with the audit", finishedAt: new Date() })
    .where(and(inArray(jobRuns.id, ids), inArray(jobRuns.status, ["queued", "running"])))
    .returning({ queue: jobRuns.queue, bossJobId: jobRuns.bossJobId });
  const byQueue = new Map<string, string[]>();
  for (const r of rows) if (r.bossJobId) byQueue.set(r.queue, [...(byQueue.get(r.queue) ?? []), r.bossJobId]);
  if (byQueue.size) {
    try {
      const b = await boss();
      for (const [queue, bossIds] of byQueue) await b.cancel(queue, bossIds);
    } catch {
      // job_runs says cancelled and every audit job checks the audit's state before and during its work.
    }
  }
  return rows.length;
}

const OPEN_ITEM_STATES: AuditItemState[] = ["pending", "analyzing", "reviewing"];

/** Cancel a running audit: its jobs are cancelled and unfinished items skipped. Reviews already stored are kept. */
export async function cancelAudit(actor: Actor, spaceId: string, auditId: string): Promise<{ skipped: number; jobsCancelled: number }> {
  const audit = await auditOrThrow(spaceId, auditId);
  if (!canCancelAudit(audit.state)) throw new AuditRequestError("state", auditStateReason("cancel", audit.state));
  const outcome = await db().transaction(async (tx) => {
    const [a] = await tx.select({ state: audits.state }).from(audits).where(eq(audits.id, audit.id)).for("update");
    if (!a || a.state !== "running") return null;
    await tx.update(audits).set({ state: "cancelled" }).where(eq(audits.id, audit.id));
    const open = await tx
      .update(auditItems)
      .set({ state: "skipped", stateReason: "The audit was cancelled." })
      .where(and(eq(auditItems.auditId, audit.id), inArray(auditItems.state, OPEN_ITEM_STATES)))
      .returning({ reviewJobRunId: auditItems.reviewJobRunId });
    return open;
  });
  if (!outcome) throw new AuditRequestError("state", "The audit is no longer running.");
  const runIds = [audit.runId, ...outcome.map((o) => o.reviewJobRunId)].filter((x): x is string => !!x);
  const jobsCancelled = await cancelJobRuns(runIds);
  await recordAuditEvent({ actor, action: "audit.cancel", spaceId, targetType: "audit", targetId: audit.id, details: { skipped: outcome.length, jobsCancelled } });
  return { skipped: outcome.length, jobsCancelled };
}

/** Delete a draft audit and its items. Running and finalized audits are never deleted. */
export async function deleteAudit(actor: Actor, spaceId: string, auditId: string): Promise<void> {
  const audit = await auditOrThrow(spaceId, auditId);
  if (!canDeleteAudit(audit.state)) throw new AuditRequestError("state", auditStateReason("delete", audit.state));
  const deleted = await db()
    .delete(audits)
    .where(and(eq(audits.id, audit.id), eq(audits.state, "draft")))
    .returning({ id: audits.id });
  if (!deleted.length) throw new AuditRequestError("state", "The audit is no longer a draft.");
  await recordAuditEvent({ actor, action: "audit.delete", spaceId, targetType: "audit", targetId: audit.id, details: { name: audit.name, profileId: audit.profileId } });
}

/**
 * "Rerun failed reviews": every failed item whose cause a rerun can fix
 * (failure.ts, rerunCanHelp). Failures from missing or expired credentials
 * are rerun only once the space's Bedrock check passes again; refused access
 * is left for an IAM change. Failed reviews have no findings, so nothing
 * needs confirming. Returns how many were queued and how many were left.
 */
export async function rerunFailedItems(actor: Actor, spaceId: string, auditId: string, deps: { listCatalog?: ListCatalog } = {}): Promise<{ queued: number; left: number }> {
  const audit = await auditOrThrow(spaceId, auditId);
  const failed = (await listAuditItems(audit.id)).filter((i) => i.state === "failed");
  if (!failed.length) return { queued: 0, left: 0 };
  // A hand-off audit has no review job to run again.
  if (profileOf(audit).review.runner === "handoff") return { queued: 0, left: failed.length };
  const kinds = new Map(failed.map((i) => [i.id, reviewFailureKind(i.stateReason)]));
  let accessWorksNow = false;
  if ([...kinds.values()].some((k) => k === "no-credentials" || k === "expired")) {
    const space = await getSpaceById(spaceId);
    accessWorksNow = !!space && (await checkBedrock(space, actor, { list: deps.listCatalog })).kind === null;
  }
  const todo = failed.filter((i) => rerunCanHelp(kinds.get(i.id)!, accessWorksNow));
  for (const i of todo) await rerunItem(actor, spaceId, audit.id, i.id);
  return { queued: todo.length, left: failed.length - todo.length };
}

/**
 * Review one item again. The new review gets new findings; the earlier ones
 * stay stored with their review and decisions, and a decision is carried to
 * the new finding at the same kind and position when the model proposes the
 * same values. When the current review has accepted or rejected findings the
 * caller must pass `confirmReplace`, so decisions are never replaced silently.
 */
export async function rerunItem(actor: Actor, spaceId: string, auditId: string, itemId: string, opts: { confirmReplace?: boolean } = {}): Promise<{ queued: boolean }> {
  const audit = await auditOrThrow(spaceId, auditId);
  const item = await getAuditItem(audit.id, itemId);
  if (!item) throw new AuditRequestError("not-found", "The investigation is not in this audit.");
  if (profileOf(audit).review.runner === "handoff") throw new AuditRequestError("state", HANDOFF_RERUN_REASON);
  let allowed = canRerunItem(audit.state, item.state);
  if (!allowed && item.state === "reviewing" && (audit.state === "running" || audit.state === "reviewing")) {
    // A review whose job ended without settling the item (worker lost) can be started again.
    const [run] = item.reviewJobRunId ? await db().select({ status: jobRuns.status }).from(jobRuns).where(eq(jobRuns.id, item.reviewJobRunId)) : [];
    allowed = !run || (run.status !== "queued" && run.status !== "running");
  }
  if (!allowed) {
    throw new AuditRequestError("state", audit.state === "running" || audit.state === "reviewing" ? "This investigation's review is still in progress." : auditStateReason("rerun", audit.state));
  }
  if (!item.analyzedAt) throw new AuditRequestError("state", "The analyzers have not run on this investigation yet.");
  if (item.currentReviewId) {
    const decided = await db()
      .select({ id: findings.id })
      .from(findings)
      .where(and(eq(findings.reviewId, item.currentReviewId), inArray(findings.state, ["accepted", "rejected"])));
    if (decided.length && !opts.confirmReplace) {
      throw new AuditRequestError(
        "confirm",
        `${decided.length} finding(s) of the current review are accepted or rejected. A new review replaces them as the item's current findings; the decisions stay with the earlier review and carry over only where the model proposes the same values.`,
        { decided: decided.length },
      );
    }
  }
  await db().transaction(async (tx) => {
    await tx.update(auditItems).set({ state: "pending", stateReason: null }).where(eq(auditItems.id, item.id));
    if (audit.state === "reviewing") await tx.update(audits).set({ state: "running" }).where(eq(audits.id, audit.id));
  });
  const queued = await dispatchReviews(audit.id, actor, enqueueReview);
  await recordAuditEvent({
    actor,
    action: "audit.item.rerun",
    spaceId,
    targetType: "audit_item",
    targetId: item.id,
    details: { auditId: audit.id, taskId: item.taskId, previousReviewId: item.currentReviewId, confirmReplace: !!opts.confirmReplace },
  });
  return { queued: queued > 0 };
}
