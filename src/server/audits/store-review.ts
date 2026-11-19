import { and, eq, inArray } from "drizzle-orm";
import { canonicalJson } from "@/server/analyzers/registry";
import { jsonbSafe } from "@/server/analyzers/store";
import { recordAuditEvent } from "@/server/audit-log";
import type { Actor } from "@/server/aws/clients";
import { db } from "@/server/db/client";
import { auditItems, findings, modelCalls, reviews } from "@/server/db/schema";
import type { FindingInput, ReviewRunResult } from "./contract";
import { extractFindings, findingTitle } from "./findings";
import type { AuditItemState } from "./states";
import { profileOf, type AuditItemRow, type AuditRow, type FindingRow } from "./store";

/**
 * Storing one review: its review row, model calls, findings, the item's state
 * and the audit events. A review job (run.ts) and the import of a review file
 * (handoff-import.ts) both end here, so a review stored either way is checked
 * and recorded the same way.
 */

export interface ReviewItemResult {
  status: "reviewed" | "failed" | "skipped";
  reviewId: string | null;
  findings: number;
  carried: number;
  reason: string | null;
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

export interface StoreReviewInput {
  audit: AuditRow;
  item: AuditItemRow;
  spaceId: string;
  /** Who stored the review: the user who started the audit, or who imported the file */
  actor: Actor;
  result: ReviewRunResult;
  /** The "running" review row a job inserted when it began; without one, a finished row is inserted now */
  reviewId?: string;
  jobRunId: string | null;
  /** The item must still be in one of these states when the findings are stored; a job reviews items that are "reviewing" */
  fromStates: readonly AuditItemState[];
  progress?: (fraction: number, message: string) => Promise<void>;
}

/** Write the review row and its model calls. Returns the review's ID. */
async function writeReviewRow(input: StoreReviewInput): Promise<string> {
  const { audit, item, spaceId, actor, result } = input;
  const fields = {
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
  };
  let reviewId = input.reviewId;
  if (reviewId) {
    await db().update(reviews).set(fields).where(eq(reviews.id, reviewId));
  } else {
    const [row] = await db()
      .insert(reviews)
      .values({ auditId: audit.id, auditItemId: item.id, spaceId, jobRunId: input.jobRunId, startedBy: actor.email, ...fields })
      .returning({ id: reviews.id });
    reviewId = row!.id;
  }
  if (result.modelCalls.length) {
    await db()
      .insert(modelCalls)
      .values(
        result.modelCalls.map((c) => ({
          spaceId,
          auditId: audit.id,
          reviewId: reviewId!,
          purpose: c.purpose,
          runner: c.runner,
          modelId: c.modelId,
          region: c.region,
          steps: c.steps,
          inputTokens: c.inputTokens,
          outputTokens: c.outputTokens,
          durationMs: Math.round(c.durationMs),
          error: c.error,
          actor: actor.email,
        })),
      );
  }
  return reviewId;
}

/**
 * Store a finished review. A failed result (or one without output that passed
 * the schema) leaves the item failed, or reviewed again from its earlier
 * review with a note. A good one becomes the item's current review: its
 * findings are inserted, a decision on the previous review's finding is carried
 * over where the same values are proposed, and the item is reviewed.
 */
export async function storeReview(input: StoreReviewInput): Promise<ReviewItemResult> {
  const { audit, item, spaceId, actor, result } = input;
  const profile = profileOf(audit);
  const reviewId = await writeReviewRow(input);

  const ok = result.state === "succeeded" && result.schemaValid && result.output !== null && result.output !== undefined;
  if (!ok) {
    const reason = reviewFailureReason(result);
    await db()
      .update(auditItems)
      .set(item.currentReviewId ? { state: "reviewed", stateReason: `The latest review failed: ${reason} The findings shown are from the earlier review.` } : { state: "failed", stateReason: reason })
      .where(and(eq(auditItems.id, item.id), inArray(auditItems.state, [...input.fromStates])));
    return { status: "failed", reviewId, findings: 0, carried: 0, reason };
  }

  const extracted = extractFindings(profile, result.output, { incidentId: item.incidentId, citationCheck: result.citationCheck });
  const outcome = await db().transaction(async (tx) => {
    const [cur] = await tx.select().from(auditItems).where(eq(auditItems.id, item.id)).for("update");
    if (!cur || !input.fromStates.includes(cur.state)) return null;
    const previous = cur.currentReviewId ? await tx.select().from(findings).where(eq(findings.reviewId, cur.currentReviewId)) : [];
    let carried = 0;
    const rows: NewFinding[] = extracted.map((f) => {
      const base: NewFinding = {
        auditId: audit.id,
        auditItemId: item.id,
        reviewId,
        spaceId,
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
      actor,
      action: "audit.item.review-replaced",
      spaceId,
      targetType: "audit_item",
      targetId: item.id,
      details: { auditId: audit.id, reviewId, previousReviewId: item.currentReviewId, decidedBefore: outcome.superseded, carried: outcome.carried },
    });
  }
  await input.progress?.(1, `Review stored with ${outcome.findings} finding(s)`);
  return { status: "reviewed", reviewId, findings: outcome.findings, carried: outcome.carried, reason: null };
}
