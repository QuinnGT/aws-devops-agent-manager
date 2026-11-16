import { and, asc, eq, isNotNull } from "drizzle-orm";
import { normalizeBundle } from "@/server/analyzers/normalize";
import { loadJournalBundle } from "@/server/analyzers/store";
import { db } from "@/server/db/client";
import { auditItems, audits, reviews } from "@/server/db/schema";
import { checkCitations } from "./citations";
import { compareReviews, loadReferenceReview, type ReviewComparison } from "./compare";

/**
 * Reads an audit's current reviews and compares each with the reference
 * review for its incident in `referenceDir` (`<incident>.json`). Read-only.
 * The reference's citation check runs against the journal stored for the item.
 */
export interface AuditComparison {
  auditId: string;
  auditName: string;
  comparisons: ReviewComparison[];
  /** Incidents with an app review but no reference file */
  missingReference: string[];
  /** Items without a current review */
  notReviewed: string[];
}

export async function compareAudit(auditId: string, referenceDir: string): Promise<AuditComparison> {
  const [audit] = await db().select({ id: audits.id, name: audits.name, spaceId: audits.spaceId }).from(audits).where(eq(audits.id, auditId));
  if (!audit) throw new Error(`No audit with ID ${auditId}`);
  const items = await db()
    .select({ item: auditItems, review: reviews })
    .from(auditItems)
    .leftJoin(reviews, and(eq(reviews.id, auditItems.currentReviewId), isNotNull(auditItems.currentReviewId)))
    .where(eq(auditItems.auditId, auditId))
    .orderBy(asc(auditItems.incidentId), asc(auditItems.taskId));

  const comparisons: ReviewComparison[] = [];
  const missingReference: string[] = [];
  const notReviewed: string[] = [];
  for (const { item, review } of items) {
    const incident = item.incidentId ?? item.taskId;
    if (!review) {
      notReviewed.push(incident);
      continue;
    }
    const ref = loadReferenceReview(referenceDir, incident);
    if (!ref) {
      missingReference.push(incident);
      continue;
    }
    const bundle = await loadJournalBundle(item.spaceId, item.taskId);
    const refCheck = bundle ? checkCitations(ref.raw, normalizeBundle(bundle)) : null;
    comparisons.push(compareReviews(incident, review.output, ref.converted, { app: review.citationCheck, reference: refCheck }));
  }
  return { auditId: audit.id, auditName: audit.name, comparisons, missingReference, notReviewed };
}
