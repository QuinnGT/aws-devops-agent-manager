import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAuditEvent } from "@/server/audit-log";
import type { Actor } from "@/server/aws/clients";
import { db } from "@/server/db/client";
import { auditItems, audits, findings } from "@/server/db/schema";
import { checkEdits } from "./edits";
import { AuditRequestError } from "./errors";
import { markChecked } from "./citation-state";
import { findingTitle } from "./findings";
import { readOutputSchema, loadedPolicyForSpace } from "./profiles";
import { auditStateReason, canReviewFindings, findingActionReason, nextFindingState, type FindingAction, type FindingState } from "./states";
import { isUuid, profileOf, type FindingRow } from "./store";

/**
 * A person's review of findings: accept, reject,
 * reopen, edit the extractor's editable fields, each with an optional note,
 * and accept every proposed finding of an item at once. Only findings of an
 * item's current review can change. Every action records reviewed_by and an
 * audit event. The caller holds `findings.review`.
 */

const note = z.string().trim().max(2000).optional();
const values = z.record(z.string().max(100), z.unknown());

export const findingActionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), note, values: values.optional() }),
  z.object({ action: z.literal("reject"), note }),
  z.object({ action: z.literal("reopen"), note }),
  z.object({ action: z.literal("edit"), note, values }),
]);

export type FindingActionInput = z.input<typeof findingActionInput>;

export interface FindingActionResult {
  findingId: string;
  state: FindingState;
  edited: boolean;
  changed: string[];
}

async function loadForReview(spaceId: string, findingId: string) {
  if (!isUuid(findingId)) return null;
  const [row] = await db()
    .select({ f: findings, audit: audits, currentReviewId: auditItems.currentReviewId })
    .from(findings)
    .innerJoin(audits, eq(audits.id, findings.auditId))
    .innerJoin(auditItems, eq(auditItems.id, findings.auditItemId))
    .where(and(eq(findings.spaceId, spaceId), eq(findings.id, findingId)));
  return row ?? null;
}

function assertCurrent(f: FindingRow, currentReviewId: string | null): void {
  if (f.reviewId !== currentReviewId) {
    throw new AuditRequestError("state", "This finding is from an earlier review of the investigation. Only the current review's findings can be changed.");
  }
}

export async function reviewFinding(actor: Actor, spaceId: string, findingId: string, input: FindingActionInput): Promise<FindingActionResult> {
  const parsed = findingActionInput.safeParse(input);
  if (!parsed.success) throw new AuditRequestError("invalid", parsed.error.issues[0]?.message ?? "The request is not valid.");
  const req = parsed.data;
  const row = await loadForReview(spaceId, findingId);
  if (!row) throw new AuditRequestError("not-found", "The finding is not in this space.");
  const { f, audit } = row;
  if (!canReviewFindings(audit.state)) throw new AuditRequestError("state", auditStateReason("review", audit.state));
  assertCurrent(f, row.currentReviewId);
  const action: FindingAction = req.action;
  const next = nextFindingState(f.state, action);
  if (!next) throw new AuditRequestError("state", findingActionReason(action, f.state));

  const profile = profileOf(audit);
  const extractor = profile.findings.find((x) => x.kind === f.kind);
  let current = f.current;
  let changed: string[] = [];
  const edits = req.action === "accept" || req.action === "edit" ? req.values : undefined;
  if (edits && Object.keys(edits).length) {
    if (!extractor) throw new AuditRequestError("state", `The audit's profile has no "${f.kind}" findings, so this finding can't be edited.`);
    const loaded = await loadedPolicyForSpace(spaceId);
    const check = checkEdits(readOutputSchema(profile, loaded.dirs), extractor, f.current, edits);
    if (!check.ok) throw new AuditRequestError("invalid", check.errors.map((e) => e.message).join(" "), { errors: check.errors });
    current = check.values!;
    changed = check.changed;
  } else if (req.action === "edit") {
    throw new AuditRequestError("invalid", "There is nothing to change.");
  }
  const edited = JSON.stringify(sortKeys(current)) !== JSON.stringify(sortKeys(f.proposed));
  const title = extractor ? findingTitle(extractor, current, f.incidentId, f.ordinal) : f.title;
  const now = new Date();
  const updated = await db()
    .update(findings)
    .set({
      state: next,
      current,
      edited,
      title,
      reviewNote: req.note !== undefined ? req.note || null : f.reviewNote,
      reviewedBy: actor.email,
      reviewedAt: now,
    })
    .where(and(eq(findings.id, f.id), eq(findings.state, f.state)))
    .returning({ id: findings.id });
  if (!updated.length) throw new AuditRequestError("state", "Someone else changed this finding. Reload and try again.");
  await recordAuditEvent({
    actor,
    action: `finding.${action}`,
    spaceId,
    targetType: "finding",
    targetId: f.id,
    details: { auditId: f.auditId, itemId: f.auditItemId, kind: f.kind, from: f.state, to: next, changed, ...(req.note ? { note: req.note.slice(0, 500) } : {}) },
  });
  return { findingId: f.id, state: next, edited, changed };
}

/**
 * Accept every proposed finding of the item's current review whose citations
 * all passed the check, or whose failed citations a reviewer has checked. A
 * finding with an unchecked failed citation is never bulk accepted: a person
 * opens it and decides (pages/audit-detail.md, "Bulk accept").
 */
export async function acceptAllProposed(actor: Actor, spaceId: string, auditId: string, itemId: string, opts: { note?: string } = {}): Promise<{ accepted: number; skipped: number }> {
  if (!isUuid(auditId) || !isUuid(itemId)) throw new AuditRequestError("not-found", "The investigation is not in this audit.");
  const [row] = await db()
    .select({ audit: audits, item: auditItems })
    .from(auditItems)
    .innerJoin(audits, eq(audits.id, auditItems.auditId))
    .where(and(eq(audits.spaceId, spaceId), eq(audits.id, auditId), eq(auditItems.id, itemId)));
  if (!row) throw new AuditRequestError("not-found", "The investigation is not in this audit.");
  if (!canReviewFindings(row.audit.state)) throw new AuditRequestError("state", auditStateReason("review", row.audit.state));
  if (!row.item.currentReviewId) throw new AuditRequestError("state", "The investigation has no review yet.");
  const n = (opts.note ?? "").trim().slice(0, 2000);
  const proposed = and(eq(findings.reviewId, row.item.currentReviewId), eq(findings.state, "proposed"));
  const accepted = await db()
    .update(findings)
    .set({ state: "accepted", reviewedBy: actor.email, reviewedAt: new Date(), ...(n ? { reviewNote: n } : {}) })
    .where(and(proposed, sql`not ${OPEN_CITATION_PROBLEM}`))
    .returning({ id: findings.id, kind: findings.kind });
  const [{ skipped } = { skipped: 0 }] = await db().select({ skipped: count() }).from(findings).where(proposed);
  await recordAuditEvent({
    actor,
    action: "finding.accept-all",
    spaceId,
    targetType: "audit_item",
    targetId: itemId,
    details: { auditId, reviewId: row.item.currentReviewId, accepted: accepted.length, skipped: Number(skipped), findingIds: accepted.map((a) => a.id).slice(0, 200), ...(n ? { note: n.slice(0, 500) } : {}) },
  });
  return { accepted: accepted.length, skipped: Number(skipped) };
}

/** Proposed findings with a failed citation that no reviewer has checked yet (jsonb `citations`). */
export const OPEN_CITATION_PROBLEM = sql`jsonb_path_exists(${findings.citations}, '$[*] ? (@.ok == false && !exists(@.checked))')`;

export const citationCheckInput = z.object({
  record: z.number().int().min(1).max(10_000_000),
  note: z.string().trim().min(1, "Say what you found in the record.").max(500),
});

/**
 * "I checked the record": a reviewer read the record a failed citation points
 * at and says what they found. Every failed citation of that record in the
 * finding gets `checked` (who, when, the note); the check's own result stays
 * in the record. Allowed while the finding's audit is in review and the
 * finding is from the item's current review, in any state. The caller holds
 * `findings.review`.
 */
export async function checkCitation(actor: Actor, spaceId: string, findingId: string, input: z.input<typeof citationCheckInput>): Promise<{ findingId: string; record: number; checked: number }> {
  const parsed = citationCheckInput.safeParse(input);
  if (!parsed.success) throw new AuditRequestError("invalid", parsed.error.issues[0]?.message ?? "The request is not valid.");
  const req = parsed.data;
  const row = await loadForReview(spaceId, findingId);
  if (!row) throw new AuditRequestError("not-found", "The finding is not in this space.");
  const { f, audit } = row;
  if (!canReviewFindings(audit.state)) throw new AuditRequestError("state", auditStateReason("review", audit.state));
  assertCurrent(f, row.currentReviewId);
  const failed = f.citations.filter((c) => c.record === req.record && !c.ok);
  if (!failed.length) throw new AuditRequestError("invalid", `The finding has no failed citation of R${req.record}.`);
  const checked = { by: actor.email, at: new Date().toISOString(), note: req.note };
  // Read and write in one transaction, so two reviewers checking at once keep the first note.
  const changed = await db().transaction(async (tx) => {
    const [cur] = await tx.select({ citations: findings.citations }).from(findings).where(eq(findings.id, f.id)).for("update");
    const next = markChecked(cur?.citations ?? [], req.record, checked);
    if (next.changed) await tx.update(findings).set({ citations: next.citations }).where(eq(findings.id, f.id));
    return next.changed;
  });
  if (!changed) throw new AuditRequestError("state", `Someone already checked R${req.record} for this finding.`);
  await recordAuditEvent({
    actor,
    action: "finding.citation.check",
    spaceId,
    targetType: "finding",
    targetId: f.id,
    details: { auditId: f.auditId, itemId: f.auditItemId, record: req.record, problems: [...new Set(failed.map((c) => c.problem ?? "unknown"))], note: req.note },
  });
  return { findingId: f.id, record: req.record, checked: changed };
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}
