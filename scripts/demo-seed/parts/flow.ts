import { and, eq, inArray } from "drizzle-orm";
import JSZip from "jszip";
import { loadFixContext } from "@/server/audits/fixes";
import { exportReviewFiles } from "@/server/audits/handoff";
import { importReviews } from "@/server/audits/handoff-import";
import { runAuditJob, type EnqueueReview } from "@/server/audits/run";
import { createAudit, startAudit } from "@/server/audits/service";
import { getAudit, profileOf } from "@/server/audits/store";
import { benchmarkFixture, benchmarkReviews } from "@/server/audits/testing";
import { db } from "@/server/db/client";
import { audits, jobRuns } from "@/server/db/schema";
import { testJobContext } from "@/server/jobs/registry";
import { addFindingsToRevision } from "@/server/revisions";
import type { Space } from "@/server/spaces/queries";
import { logger, SAMPLE, type SeedPerson } from "../lib/common";
import { settle } from "../lib/jobs";

/**
 * The parts of the demo that connect an audit to the rest of the app:
 *
 *   sendFixesToRevision   accepted package fixes of an audit that no save has
 *                         linked go on an open revision's to-address list, as
 *                         "Add to revision…" does. The audit's flow strip then
 *                         counts them as queued, and the revision shows them
 *                         under "To address".
 *   seedReviewFilesAudit  an audit reviewed with review files (no Bedrock):
 *                         one investigation has an imported review, written
 *                         from the sample reference review, and the others
 *                         wait for a review file.
 *
 * No AWS, Bedrock or network calls.
 */

const log = logger("flow");

/** Put up to `count` of the audit's accepted package fixes that are in no revision on the revision's to-address list. Returns how many were added. */
export async function sendFixesToRevision(space: Space, o: { auditId: string; revisionId: string; count: number; actor: SeedPerson }): Promise<number> {
  const audit = await getAudit(space.id, o.auditId);
  if (!audit) throw new Error(`Audit ${o.auditId} is not in ${space.alias}`);
  const ctx = await loadFixContext(space.id, o.auditId, profileOf(audit), { canBuild: true });
  const ids = ctx.progress.open.slice(0, o.count);
  if (!ids.length) {
    log(`no accepted package fix of ${audit.name} is outside a revision`);
    return 0;
  }
  const { added } = await addFindingsToRevision(space, { revisionId: o.revisionId, findingIds: ids }, { email: o.actor.email });
  log(`sent ${added} accepted package fixes of ${audit.name} to a revision; ${ctx.progress.open.length - added} stay in no revision`);
  return added;
}

export const REVIEW_FILES_AUDIT = {
  name: "Early November, review files",
  incidents: ["INCIDENT-20102", "INCIDENT-20103", "INCIDENT-20107"],
  /** The incident whose review is imported; the others wait for a review file */
  imported: "INCIDENT-20102",
  /** Who wrote the imported review, as a person types it on import */
  reviewer: "Kiro CLI",
} as const;

/**
 * An audit whose reviewer is "Review files" (runner `handoff`): started, analyzed,
 * one review imported back from a zip of the exported folders. The journals and
 * ground truth must already be in the space. Returns the audit ID.
 */
export async function seedReviewFilesAudit(space: Space, actor: SeedPerson): Promise<string> {
  const a = REVIEW_FILES_AUDIT;
  const old = await db().select({ id: audits.id }).from(audits).where(and(eq(audits.spaceId, space.id), eq(audits.name, a.name)));
  if (old.length) await db().delete(audits).where(inArray(audits.id, old.map((r) => r.id)));

  const { auditId } = await createAudit(actor, space.id, {
    name: a.name,
    note: "Reviewed outside the app with an approved coding agent, so no Amazon Bedrock access is needed.",
    runner: "handoff",
    selections: [{ by: "incidents", incidentIds: [...a.incidents] }],
  });
  const { runId } = await startAudit(actor, space.id, auditId, {});
  // A review-files audit queues no model review; the stub only records a call that should not happen.
  const enqueueReview: EnqueueReview = async (input, opts) => {
    const [row] = await db().insert(jobRuns).values({ queue: "audits.review-item", actorEmail: opts.actor.email, spaceId: opts.spaceId, input }).returning({ id: jobRuns.id });
    return row!.id;
  };
  const runReview = async (): Promise<never> => {
    throw new Error("A review-files audit makes no model review");
  };
  const result = await runAuditJob({ auditId }, testJobContext({ actor, spaceId: space.id, runId }), { enqueueReview, runReview });
  await settle(runId, result);

  // The exported folders, with a review.json written from the sample reference review in one of them.
  const audit = (await getAudit(space.id, auditId))!;
  const fields = profileOf(audit).findings.find((f) => f.kind === "diagnosis")!.fields;
  const reference = benchmarkReviews(SAMPLE.auditDir).find((r) => String(r.raw.incident) === a.imported);
  if (!reference) throw new Error(`No sample review for ${a.imported}`);
  const exported = await exportReviewFiles(actor, space.id, auditId);
  const folder = exported.items.find((i) => i.incidentId === a.imported)?.folder;
  const manifest = folder ? await exported.zip.file(`${folder}/manifest.json`)?.async("string") : undefined;
  if (!folder || !manifest) throw new Error(`The review files have no folder for ${a.imported}`);
  const zip = new JSZip();
  zip.file(`${folder}/manifest.json`, manifest);
  zip.file(`${folder}/review.json`, JSON.stringify(benchmarkFixture(reference.raw, fields).output, null, 2));
  const report = await importReviews(actor, space.id, auditId, [{ fileName: "reviews.zip", bytes: await zip.generateAsync({ type: "nodebuffer" }) }], { reviewer: a.reviewer });
  if (report.totals.imported !== 1) throw new Error(`The review of ${a.imported} was not imported: ${report.results.map((r) => r.reason).join("; ")}`);
  log(`review-files audit ${a.name} (${auditId}): ${report.totals.imported} review imported, ${a.incidents.length - 1} waiting for a review file`);
  return auditId;
}
