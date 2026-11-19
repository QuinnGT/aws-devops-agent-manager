import { and, asc, eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { findings } from "@/server/db/schema";
import type { SpaceRow } from "@/server/spaces/queries";
import type { AuditViewer } from "./actions";
import { findingViewBuilder, type CitationView, type FindingView } from "./loaders";
import { loadedPolicyForSpace } from "./profiles";
import { getAudit, getAuditItem, isUuid, profileOf } from "./store";
import { journalRecordCount } from "./ui";

/**
 * One finding for the Findings tab's detail pane: the whole finding with the
 * profile's labels, its citations with their check results, and the actions
 * the viewer has. Reads one finding and its siblings, not the journal, so the
 * pane opens quickly; a citation's record is read on demand through the
 * records route, as on the incident page. Read-only; the caller checks
 * `audits.read` for the space first.
 */

export interface FindingDetail {
  finding: FindingView;
  taskId: string;
  /** Position among the findings of the same kind in this review, for "Fix 2 of 3" */
  sibling: { index: number; count: number };
  /** Records in the investigation's journal; null when it isn't cached */
  totalRecords: number | null;
}

export async function loadFindingDetail(space: Pick<SpaceRow, "id">, auditId: string, findingId: string, viewer: AuditViewer): Promise<FindingDetail | null> {
  if (!isUuid(findingId)) return null;
  const audit = await getAudit(space.id, auditId);
  if (!audit) return null;
  const [row] = await db()
    .select()
    .from(findings)
    .where(and(eq(findings.id, findingId), eq(findings.auditId, audit.id), eq(findings.spaceId, space.id)));
  if (!row) return null;
  const item = await getAuditItem(audit.id, row.auditItemId);
  if (!item) return null;
  const profile = profileOf(audit);
  const loaded = await loadedPolicyForSpace(space.id);
  const siblings = await db()
    .select({ id: findings.id })
    .from(findings)
    .where(and(eq(findings.reviewId, row.reviewId), eq(findings.kind, row.kind)))
    .orderBy(asc(findings.ordinal));
  const records = await journalRecordCount(space.id, item.taskId);
  const build = findingViewBuilder(audit, profile, loaded.dirs, viewer);
  const plain = (c: Parameters<Parameters<typeof build>[2]>[0]): CitationView => ({ ...c, recordId: null, href: null });
  return {
    finding: build(row, row.reviewId === item.currentReviewId, plain),
    taskId: item.taskId,
    sibling: { index: Math.max(0, siblings.findIndex((s) => s.id === row.id)), count: Math.max(1, siblings.length) },
    totalRecords: records > 0 ? records : null,
  };
}
