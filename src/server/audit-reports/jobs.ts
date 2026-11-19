import { z } from "zod";
import { snapshotProfile } from "@/server/audits/profiles";
import type { Actor } from "@/server/aws/clients";
import { enqueue } from "@/server/jobs/enqueue";
import { defineJob, type JobDefinition } from "@/server/jobs/registry";
import { getSpaceById } from "@/server/spaces/queries";
import { AuditReportError } from "./errors";
import { finalizeAuditHandler, finalizeAuditInput, prepareFinalizeAudit } from "./finalize";
import { noReportModelReason } from "./model";
import { getAuditInSpace } from "./queries";
import { draftNarrativeHandler, draftNarrativeInput } from "./narrative";

/**
 * Jobs for the reports module.
 * src/worker/handlers.ts lists `jobs`.
 */

export const DRAFT_NARRATIVE_QUEUE = "audit-reports.draft-narrative";
export const FINALIZE_QUEUE = "audit-reports.finalize";

export const draftNarrativeJob = defineJob({
  name: DRAFT_NARRATIVE_QUEUE,
  input: draftNarrativeInput,
  // No automatic retry: every attempt is a billed model call, and a person decides whether to try again.
  options: { retryLimit: 0, expireInSeconds: 30 * 60, queuePolicy: "singleton", singletonKey: (i) => i.auditId },
  handler: (input, ctx) => draftNarrativeHandler(input, ctx),
});

export const finalizeAuditJob = defineJob({
  name: FINALIZE_QUEUE,
  input: finalizeAuditInput,
  // A retry is safe: it finds its own commit by the Audit-Id trailer.
  options: { retryLimit: 1, retryDelay: 30, expireInSeconds: 15 * 60, queuePolicy: "singleton", singletonKey: (i) => i.auditId },
  handler: finalizeAuditHandler,
});

export const jobs: JobDefinition[] = [draftNarrativeJob, finalizeAuditJob] as unknown as JobDefinition[];

/**
 * Enqueue narrative drafts. The caller (a Server Action) has checked
 * `audits.run` for the space. Returns the job_runs id for progress polling.
 */
export async function requestDraftNarrative(input: z.input<typeof draftNarrativeInput>, actor: Actor): Promise<{ runId: string }> {
  const parsed = draftNarrativeInput.parse(input);
  const space = await getSpaceById(parsed.spaceId);
  if (!space) throw new AuditReportError("Space not found.", "not-found");
  const audit = await getAuditInSpace(space.id, parsed.auditId);
  if (!audit) throw new AuditReportError("Audit not found.", "not-found");
  if (audit.state === "finalized") throw new AuditReportError("This audit's record is saved, so its report can't be changed.", "read-only");
  // An audit whose reviews use no Bedrock model has none for its report unless one was chosen on the draft; say so now, not in a failed job.
  const snapshot = snapshotProfile(audit.profileSnapshot);
  if (!snapshot.report.modelId && !snapshot.review.modelId) throw new AuditReportError(noReportModelReason(snapshot.review.runner), "invalid");
  return { runId: await enqueue(draftNarrativeJob, parsed, { actor, spaceId: space.id }) };
}

/**
 * Check and enqueue finalize. The caller (a Server Action) has checked
 * `audits.run` for the space. Throws AuditReportError("not-ready") with the
 * problems when the audit can't be finalized yet.
 */
export async function requestFinalizeAudit(input: z.input<typeof finalizeAuditInput>, actor: Actor): Promise<{ runId: string }> {
  const parsed = await prepareFinalizeAudit(input);
  return { runId: await enqueue(finalizeAuditJob, parsed, { actor, spaceId: parsed.spaceId }) };
}
