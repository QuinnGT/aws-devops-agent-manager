import { and, asc, count, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { inferenceRegion } from "@/server/ai/bedrock";
import { normalizeBundle } from "@/server/analyzers/normalize";
import { ANALYZER_IDS, canonicalJson, getAnalyzer } from "@/server/analyzers/registry";
import { analyzeBundle } from "@/server/analyzers/service";
import { jsonbSafe, latestRunsForTask, loadJournalBundle } from "@/server/analyzers/store";
import { recordAuditEvent } from "@/server/audit-log";
import type { Actor } from "@/server/aws/clients";
import { db } from "@/server/db/client";
import { auditItems, audits, findings, modelCalls, reviews } from "@/server/db/schema";
import type { JobContext } from "@/server/jobs/registry";
import { policyForSpace } from "@/server/journals/policy";
import type { LoadedPolicy } from "@/server/policy";
import type { AuditProfile } from "@/server/policy/sections/audits";
import { runReview as defaultRunReview } from "@/server/review";
import { getSpaceById, toAwsConfig } from "@/server/spaces/queries";
import type { FindingInput, ReviewRunInput, ReviewRunResult, RunReview } from "./contract";
import { extractFindings, findingTitle } from "./findings";
import { stateAfterItemsFinished, type AuditItemState } from "./states";
import { currentEvidenceDocs, getAuditById, getAuditItem, isUuid, listAuditItems, profileOf, type AuditRow, type FindingRow } from "./store";

/**
 * The audit pipeline in the worker.
 *
 * audits.run          runs the profile's analyzers on every pending item (the
 *                     analyzers module's analyzeBundle, which stores output per
 *                     investigation and skips unchanged reruns), records the
 *                     journal SHA-256 per item, and dispatches review jobs.
 * audits.review-item  reviews one item with runReview, stores the review, its
 *                     model calls and its findings, then dispatches the next item.
 *
 * Concurrency: pg-boss fixes localConcurrency when the worker starts, so the
 * profile's review.concurrency is applied by dispatch instead. At most that
 * many items of one audit are in state "reviewing" (a review job queued or
 * running); each finished review job dispatches the next waiting item. The
 * worker's own cap (REVIEW_WORKERS in jobs.ts) bounds reviews across audits.
 */

export const auditRunInput = z.object({ auditId: z.string().uuid() });
export const reviewItemInput = z.object({ auditId: z.string().uuid(), itemId: z.string().uuid() });
export type ReviewItemInput = z.output<typeof reviewItemInput>;

export type EnqueueReview = (input: ReviewItemInput, opts: { actor: Actor; spaceId: string }) => Promise<string>;

export interface RunDeps {
  enqueueReview: EnqueueReview;
  /** Tests pass a fake; the worker uses the reviewer's runReview */
  runReview?: RunReview;
  /** Policy for the space (directories for the reviewer, output rules for analyzers) */
  policy?: LoadedPolicy;
}

const jobRunIdOf = (ctx: Pick<JobContext, "runId">) => (isUuid(ctx.runId) ? ctx.runId : null);

/** Claim up to the free review slots of a running audit and queue their review jobs. Returns the number queued. */
export async function dispatchReviews(auditId: string, actor: Actor, enqueueReview: EnqueueReview, log?: JobContext["log"]): Promise<number> {
  const claimed = await db().transaction(async (tx) => {
    const [a] = await tx.select().from(audits).where(eq(audits.id, auditId)).for("update");
    if (!a || a.state !== "running") return null;
    const profile = profileOf(a);
    const [{ n } = { n: 0 }] = await tx
      .select({ n: count() })
      .from(auditItems)
      .where(and(eq(auditItems.auditId, auditId), eq(auditItems.state, "reviewing")));
    const slots = profile.review.concurrency - n;
    if (slots <= 0) return null;
    const next = await tx
      .select({ id: auditItems.id })
      .from(auditItems)
      .where(and(eq(auditItems.auditId, auditId), eq(auditItems.state, "pending"), isNotNull(auditItems.analyzedAt)))
      .orderBy(asc(auditItems.createdAt), asc(auditItems.taskId))
      .limit(slots);
    if (!next.length) return null;
    await tx
      .update(auditItems)
      .set({ state: "reviewing", stateReason: null, reviewJobRunId: null })
      .where(inArray(auditItems.id, next.map((x) => x.id)));
    return { spaceId: a.spaceId, ids: next.map((x) => x.id) };
  });
  if (!claimed) return 0;
  let queued = 0;
  for (const itemId of claimed.ids) {
    try {
      const runId = await enqueueReview({ auditId, itemId }, { actor, spaceId: claimed.spaceId });
      await db().update(auditItems).set({ reviewJobRunId: runId }).where(eq(auditItems.id, itemId));
      queued++;
    } catch (err) {
      // Put it back so the next dispatch tries again.
      await db()
        .update(auditItems)
        .set({ state: "pending" })
        .where(and(eq(auditItems.id, itemId), eq(auditItems.state, "reviewing")));
      log?.(`could not queue the review of item ${itemId}`, { message: err instanceof Error ? err.message : String(err) });
    }
  }
  return queued;
}

/** Move a running audit to "reviewing" once every item has finished. Records audit.run.completed. */
export async function maybeFinishAudit(auditId: string, actor: Actor): Promise<boolean> {
  const done = await db().transaction(async (tx) => {
    const [a] = await tx.select().from(audits).where(eq(audits.id, auditId)).for("update");
    if (!a || a.state !== "running") return null;
    const states = (await tx.select({ state: auditItems.state }).from(auditItems).where(eq(auditItems.auditId, auditId))).map((r) => r.state as AuditItemState);
    if (stateAfterItemsFinished(a.state, states) !== "reviewing") return null;
    await tx.update(audits).set({ state: "reviewing" }).where(eq(audits.id, auditId));
    const by = (s: AuditItemState) => states.filter((x) => x === s).length;
    return { spaceId: a.spaceId, counts: { items: states.length, reviewed: by("reviewed"), failed: by("failed"), skipped: by("skipped") } };
  });
  if (!done) return false;
  await recordAuditEvent({ actor, action: "audit.run.completed", spaceId: done.spaceId, targetType: "audit", targetId: auditId, details: done.counts });
  return true;
}

export interface AuditRunResult {
  status: "analyzed" | "cancelled" | "not-running";
  items: number;
  analyzed: number;
  failed: number;
  reviewsQueued: number;
  /** Profile analyzers that were not run: unknown IDs, or analyzers that need a package */
  notRun: string[];
}

/** Handler of `audits.run`. */
export async function runAuditJob(input: z.output<typeof auditRunInput>, ctx: JobContext, deps: RunDeps): Promise<AuditRunResult> {
  const audit = await getAuditById(input.auditId);
  if (!audit) throw new Error(`Audit ${input.auditId} not found`);
  if (ctx.spaceId && ctx.spaceId !== audit.spaceId) throw new Error("The job's space does not match the audit");
  const result: AuditRunResult = { status: "analyzed", items: 0, analyzed: 0, failed: 0, reviewsQueued: 0, notRun: [] };
  if (audit.state !== "running") return { ...result, status: "not-running" };

  const profile = profileOf(audit);
  const loaded = deps.policy ?? (await policyForSpaceId(audit.spaceId));
  const known = profile.analyzers.filter((id) => (ANALYZER_IDS as readonly string[]).includes(id));
  const ids = known.filter((id) => getAnalyzer(id).requires.length === 0);
  result.notRun = profile.analyzers.filter((id) => !ids.includes(id));
  if (result.notRun.length) ctx.log("profile analyzers not run", { notRun: result.notRun });

  const todo = (await listAuditItems(audit.id)).filter((i) => (i.state === "pending" && !i.analyzedAt) || i.state === "analyzing");
  result.items = todo.length;
  const stillRunning = async () => !(await ctx.cancelled()) && (await getAuditById(audit.id))?.state === "running";

  for (const [i, item] of todo.entries()) {
    if (!(await stillRunning())) {
      result.status = "cancelled";
      break;
    }
    await ctx.progress(i / Math.max(todo.length, 1), `Running analyzers on investigation ${i + 1} of ${todo.length}`);
    const claimed = await db()
      .update(auditItems)
      .set({ state: "analyzing" })
      .where(and(eq(auditItems.id, item.id), inArray(auditItems.state, ["pending", "analyzing"])))
      .returning({ id: auditItems.id });
    if (!claimed.length) continue;
    const fail = async (reason: string) => {
      result.failed++;
      await db()
        .update(auditItems)
        .set({ state: "failed", stateReason: reason })
        .where(and(eq(auditItems.id, item.id), eq(auditItems.state, "analyzing")));
    };
    const bundle = await loadJournalBundle(audit.spaceId, item.taskId);
    if (!bundle) {
      await fail("The journal is not in the journal cache.");
      continue;
    }
    try {
      const r = await analyzeBundle(audit.spaceId, bundle, ids, { policy: loaded.policy, packageFiles: null }, { jobRunId: jobRunIdOf(ctx), log: ctx.log });
      await db()
        .update(auditItems)
        .set({ state: "pending", journalSha256: r.bundleSha256, analyzedAt: new Date(), analyzerErrors: r.errors })
        .where(and(eq(auditItems.id, item.id), eq(auditItems.state, "analyzing")));
      result.analyzed++;
    } catch (err) {
      await fail(`The analyzers could not run: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`);
      continue;
    }
    result.reviewsQueued += await dispatchReviews(audit.id, ctx.actor, deps.enqueueReview, ctx.log);
  }
  result.reviewsQueued += await dispatchReviews(audit.id, ctx.actor, deps.enqueueReview, ctx.log);
  // The reviews run as their own jobs after this one; this message is about the analyzers only.
  const analyzedText = `Analyzers ran on ${result.analyzed} ${result.analyzed === 1 ? "investigation" : "investigations"}${result.failed ? `; ${result.failed} couldn't be analyzed` : ""}. Reviews follow.`;
  await ctx.progress(1, result.status === "cancelled" ? "Cancelled" : analyzedText);
  await maybeFinishAudit(audit.id, ctx.actor);
  return result;
}

async function policyForSpaceId(spaceId: string): Promise<LoadedPolicy> {
  const space = await getSpaceById(spaceId);
  if (!space) throw new Error(`Space ${spaceId} not found`);
  return policyForSpace(space);
}

export interface ReviewItemResult {
  status: "reviewed" | "failed" | "skipped";
  reviewId: string | null;
  findings: number;
  carried: number;
  reason: string | null;
}

/** Handler of `audits.review-item`. Always dispatches the next waiting item and settles the audit at the end. */
export async function runReviewItemJob(input: ReviewItemInput, ctx: JobContext, deps: RunDeps): Promise<ReviewItemResult> {
  const audit = await getAuditById(input.auditId);
  if (!audit) throw new Error(`Audit ${input.auditId} not found`);
  if (ctx.spaceId && ctx.spaceId !== audit.spaceId) throw new Error("The job's space does not match the audit");
  try {
    const item = await getAuditItem(audit.id, input.itemId);
    if (!item) throw new Error(`Audit item ${input.itemId} not found`);
    if (audit.state !== "running" || item.state !== "reviewing") {
      return { status: "skipped", reviewId: null, findings: 0, carried: 0, reason: `The audit is ${audit.state} and the item is ${item.state}.` };
    }
    return await reviewOne(audit, item, ctx, deps);
  } finally {
    await dispatchReviews(audit.id, ctx.actor, deps.enqueueReview, ctx.log);
    await maybeFinishAudit(audit.id, ctx.actor);
  }
}

function crashedResult(profile: AuditProfile, err: unknown): ReviewRunResult {
  return {
    state: "failed",
    runner: profile.review.runner,
    modelId: profile.review.modelId ?? "not set",
    promptDigest: "",
    output: null,
    schemaValid: false,
    schemaErrors: [],
    citationCheck: null,
    steps: 0,
    inputTokens: null,
    outputTokens: null,
    durationMs: 0,
    error: `The reviewer stopped with an error: ${(err instanceof Error ? err.message : String(err)).slice(0, 500)}`,
    modelCalls: [],
  };
}

/** Why a review gives no findings, in words. */
export function reviewFailureReason(r: Pick<ReviewRunResult, "state" | "error" | "schemaValid" | "schemaErrors" | "output">): string {
  if (r.state === "failed") return r.error ?? "The review failed.";
  if (r.output === null || r.output === undefined) return "The model returned no structured output.";
  if (!r.schemaValid) {
    const first = r.schemaErrors.slice(0, 3).join("; ");
    return `The review output did not pass the profile's output schema${first ? ` (${first})` : ""}.`;
  }
  return r.error ?? "The review failed.";
}

type NewFinding = typeof findings.$inferInsert;

/**
 * Carry a person's decision from the previous review's finding at the same
 * kind and position when the model proposed exactly the same values. Pure.
 * Anything else starts as proposed; the earlier findings stay with their
 * review, decisions included.
 */
export function carryDecision(previous: readonly FindingRow[], f: FindingInput): FindingRow | null {
  const prev = previous.find((p) => p.kind === f.kind && p.ordinal === f.ordinal);
  if (!prev || prev.state === "proposed") return null;
  return canonicalJson(prev.proposed) === canonicalJson(f.values) ? prev : null;
}

async function reviewOne(audit: AuditRow, item: NonNullable<Awaited<ReturnType<typeof getAuditItem>>>, ctx: JobContext, deps: RunDeps): Promise<ReviewItemResult> {
  const profile = profileOf(audit);
  // A review left "running" by an earlier attempt of this job (worker restart).
  await db()
    .update(reviews)
    .set({ state: "failed", error: "The review job stopped before this review finished.", finishedAt: new Date() })
    .where(and(eq(reviews.auditItemId, item.id), eq(reviews.state, "running")));

  const space = await getSpaceById(audit.spaceId);
  if (!space) throw new Error(`Space ${audit.spaceId} not found`);
  const loaded = deps.policy ?? (await policyForSpace(space));
  const failItem = async (reason: string): Promise<ReviewItemResult> => {
    await db()
      .update(auditItems)
      .set(item.currentReviewId ? { state: "reviewed", stateReason: `The latest review failed: ${reason} The findings shown are from the earlier review.` } : { state: "failed", stateReason: reason })
      .where(and(eq(auditItems.id, item.id), eq(auditItems.state, "reviewing")));
    return { status: "failed", reviewId: null, findings: 0, carried: 0, reason };
  };

  const bundle = await loadJournalBundle(space.id, item.taskId);
  if (!bundle) return failItem("The journal is not in the journal cache.");
  const norm = normalizeBundle(bundle);
  const runs = await latestRunsForTask(space.id, item.taskId);
  const analyzerOutputs = Object.fromEntries(runs.filter((r) => profile.analyzers.includes(r.analyzer)).map((r) => [r.analyzer, r.output]));
  const docs = item.incidentId
    ? await currentEvidenceDocs(
        space.id,
        [item.incidentId],
        profile.inputs.map((i) => i.kind),
      )
    : [];
  const groundTruth = docs.map((d) => ({
    kind: d.kind,
    label: profile.inputs.find((i) => i.kind === d.kind)?.label ?? d.kind,
    fileName: d.fileName,
    body: d.body,
    fields: d.fields,
  }));

  const [review] = await db()
    .insert(reviews)
    .values({
      auditId: audit.id,
      auditItemId: item.id,
      spaceId: space.id,
      runner: profile.review.runner,
      modelId: profile.review.modelId ?? "not set",
      promptDigest: "",
      state: "running",
      jobRunId: jobRunIdOf(ctx),
      startedBy: ctx.actor.email,
    })
    .returning({ id: reviews.id });
  const reviewId = review!.id;
  await ctx.progress(0.1, "Model review running");

  const region = inferenceRegion(space, space.parsedSettings);
  const input: ReviewRunInput = {
    space: toAwsConfig(space),
    region,
    actor: ctx.actor,
    profile,
    policyDirs: loaded.dirs,
    incidentId: item.incidentId,
    cohort: item.cohort ? { id: item.cohort, label: profile.cohorts.find((c) => c.id === item.cohort)?.label ?? item.cohort } : null,
    bundle: norm,
    analyzerOutputs,
    groundTruth,
    cancelled: async () => (await ctx.cancelled()) || (await getAuditById(audit.id))?.state !== "running",
  };
  let result: ReviewRunResult;
  try {
    result = await (deps.runReview ?? defaultRunReview)(input);
  } catch (err) {
    result = crashedResult(profile, err);
  }

  await db()
    .update(reviews)
    .set({
      state: result.state,
      runner: result.runner,
      modelId: result.modelId,
      promptDigest: result.promptDigest,
      output: result.output === undefined ? null : jsonbSafe(result.output),
      schemaValid: result.schemaValid,
      schemaErrors: jsonbSafe(result.schemaErrors.slice(0, 200)),
      citationCheck: result.citationCheck ? jsonbSafe(result.citationCheck) : null,
      error: result.error,
      steps: result.steps,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      durationMs: Math.round(result.durationMs),
      finishedAt: new Date(),
    })
    .where(eq(reviews.id, reviewId));
  if (result.modelCalls.length) {
    await db()
      .insert(modelCalls)
      .values(
        result.modelCalls.map((c) => ({
          spaceId: space.id,
          auditId: audit.id,
          reviewId,
          purpose: c.purpose,
          runner: c.runner,
          modelId: c.modelId,
          region: c.region,
          steps: c.steps,
          inputTokens: c.inputTokens,
          outputTokens: c.outputTokens,
          durationMs: Math.round(c.durationMs),
          error: c.error,
          actor: ctx.actor.email,
        })),
      );
  }

  const ok = result.state === "succeeded" && result.schemaValid && result.output !== null && result.output !== undefined;
  if (!ok) {
    const out = await failItem(reviewFailureReason(result));
    return { ...out, reviewId };
  }

  const extracted = extractFindings(profile, result.output, { incidentId: item.incidentId, citationCheck: result.citationCheck });
  const outcome = await db().transaction(async (tx) => {
    const [cur] = await tx.select().from(auditItems).where(eq(auditItems.id, item.id)).for("update");
    if (!cur || cur.state !== "reviewing") return null;
    const previous = cur.currentReviewId ? await tx.select().from(findings).where(eq(findings.reviewId, cur.currentReviewId)) : [];
    let carried = 0;
    const rows: NewFinding[] = extracted.map((f) => {
      const base: NewFinding = {
        auditId: audit.id,
        auditItemId: item.id,
        reviewId,
        spaceId: space.id,
        incidentId: item.incidentId,
        kind: f.kind,
        ordinal: f.ordinal,
        title: f.title,
        proposed: jsonbSafe(f.values),
        current: jsonbSafe(f.values),
        citations: jsonbSafe(f.citations),
      };
      const prev = carryDecision(previous, f);
      if (!prev) return base;
      carried++;
      const ex = profile.findings.find((x) => x.kind === f.kind);
      return {
        ...base,
        current: prev.current,
        title: ex ? findingTitle(ex, prev.current, item.incidentId, f.ordinal) : f.title,
        state: prev.state,
        edited: prev.edited,
        reviewNote: prev.reviewNote,
        reviewedBy: prev.reviewedBy,
        reviewedAt: prev.reviewedAt,
        carriedFromId: prev.id,
      };
    });
    if (rows.length) await tx.insert(findings).values(rows);
    await tx.update(auditItems).set({ state: "reviewed", stateReason: null, currentReviewId: reviewId }).where(eq(auditItems.id, item.id));
    return { findings: rows.length, carried, superseded: previous.filter((p) => p.state !== "proposed").length };
  });
  if (!outcome) return { status: "skipped", reviewId, findings: 0, carried: 0, reason: "The item was skipped or cancelled while it was reviewed." };
  if (outcome.carried || outcome.superseded) {
    await recordAuditEvent({
      actor: ctx.actor,
      action: "audit.item.review-replaced",
      spaceId: space.id,
      targetType: "audit_item",
      targetId: item.id,
      details: { auditId: audit.id, reviewId, previousReviewId: item.currentReviewId, decidedBefore: outcome.superseded, carried: outcome.carried },
    });
  }
  await ctx.progress(1, `Review stored with ${outcome.findings} finding(s)`);
  return { status: "reviewed", reviewId, findings: outcome.findings, carried: outcome.carried, reason: null };
}
