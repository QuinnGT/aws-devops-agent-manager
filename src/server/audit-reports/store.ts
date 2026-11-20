import { and, eq, ne } from "drizzle-orm";
import type { ReportDraft } from "@/server/audits/contract";
import { db } from "@/server/db/client";
import { audits } from "@/server/db/schema";
import { AuditReportError } from "./errors";
import type { AuditRow } from "./queries";

/**
 * Writes of the reports module: audits.report (ReportDraft) and the finalize
 * columns. Report edits lock the audit row, so a person's edit and a narrative
 * job never overwrite each other's sections.
 */

type DraftSection = ReportDraft["sections"][number];

/** A draft with the section `id` changed by `patch` (added when missing), stamped with who changed it. Pure. */
export function patchSection(draft: ReportDraft, id: string, patch: Partial<Omit<DraftSection, "id" | "updatedBy" | "updatedAt">>, by?: { email: string; at: Date }): ReportDraft {
  const stamp = by ? { updatedBy: by.email, updatedAt: by.at.toISOString() } : {};
  const found = draft.sections.some((s) => s.id === id);
  const sections = found ? draft.sections.map((s) => (s.id === id ? { ...s, ...patch, ...stamp } : s)) : [...draft.sections, { id, ...patch, ...stamp }];
  return { ...draft, sections };
}

export function emptyDraft(builtAt: Date): ReportDraft {
  return { builtAt: builtAt.toISOString(), sections: [] };
}

/**
 * Change the audit's report draft under a row lock. `mutate` gets the stored
 * draft (null before the first build) and returns the new one. Refuses a
 * finalized audit: its report is read-only.
 */
export async function updateReportDraft(
  audit: Pick<AuditRow, "id" | "spaceId">,
  actor: { email: string },
  mutate: (draft: ReportDraft | null, row: AuditRow) => ReportDraft,
): Promise<{ draft: ReportDraft; before: ReportDraft | null }> {
  return db().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(audits)
      .where(and(eq(audits.id, audit.id), eq(audits.spaceId, audit.spaceId)))
      .for("update");
    if (!row) throw new AuditReportError("Audit not found.", "not-found");
    if (row.state === "finalized") throw new AuditReportError("This audit's record is saved, so its report can't be changed.", "read-only");
    const draft = mutate(row.report ?? null, row);
    await tx.update(audits).set({ report: draft, reportUpdatedBy: actor.email, reportUpdatedAt: new Date() }).where(eq(audits.id, row.id));
    return { draft, before: row.report ?? null };
  });
}

/** Mark the audit finalized with its commit, unless it already is. Returns false when another run finalized it first. */
export async function markFinalized(auditId: string, commit: string, actor: { email: string }, at: Date): Promise<boolean> {
  const updated = await db()
    .update(audits)
    .set({ state: "finalized", finalizedCommit: commit, finalizedBy: actor.email, finalizedAt: at })
    .where(and(eq(audits.id, auditId), ne(audits.state, "finalized")))
    .returning({ id: audits.id });
  return updated.length > 0;
}
