import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/server/db/client";
import { revisions } from "@/server/db/schema";
import { findingsForChangelog, listChangesOf } from "./queries";

/** One audit a revision's findings come from, with how many of them. */
export interface RevisionAuditSource {
  auditId: string;
  auditName: string;
  findings: number;
}

/**
 * For each revision, the audits its findings come from: the findings on its
 * to-address list and the ones its saves linked, counted once each and grouped
 * by audit (most findings first). A revision with no findings maps to an empty
 * list. Read-only; the caller checks `audits.read`, and revisions are looked
 * up together with the space.
 */
export async function revisionAuditSources(spaceId: string, revisionIds: readonly string[]): Promise<Map<string, RevisionAuditSource[]>> {
  const out = new Map<string, RevisionAuditSource[]>(revisionIds.map((id) => [id, []]));
  if (!revisionIds.length) return out;
  const rows = await db()
    .select({ id: revisions.id, toAddress: revisions.toAddressFindingIds })
    .from(revisions)
    .where(and(eq(revisions.spaceId, spaceId), inArray(revisions.id, [...revisionIds])));
  const changes = await listChangesOf(rows.map((r) => r.id));
  const idsOf = new Map(rows.map((r) => [r.id, new Set([...r.toAddress, ...changes.filter((c) => c.revisionId === r.id).flatMap((c) => c.findingIds)])]));
  const found = await findingsForChangelog(spaceId, [...idsOf.values()].flatMap((s) => [...s]));
  const byId = new Map(found.map((f) => [f.id, f]));
  for (const [revisionId, ids] of idsOf) {
    const counts = new Map<string, RevisionAuditSource>();
    for (const id of ids) {
      const f = byId.get(id);
      if (!f) continue;
      const cur = counts.get(f.auditId) ?? { auditId: f.auditId, auditName: f.auditName, findings: 0 };
      cur.findings += 1;
      counts.set(f.auditId, cur);
    }
    out.set(revisionId, [...counts.values()].sort((a, b) => b.findings - a.findings || a.auditName.localeCompare(b.auditName)));
  }
  return out;
}
