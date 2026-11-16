import { recordAuditEvent } from "@/server/audit-log";
import type { Actor } from "@/server/aws/clients";
import { fillTemplate } from "@/server/history/layout";
import { policyForSpace } from "@/server/journals/policy";
import type { PlanAppliedEvent } from "@/server/plans/hooks";
import { dbPlanStore } from "@/server/plans/store";
import { ReleaseError } from "@/server/releases/errors";
import { requestCreateRelease } from "@/server/releases/jobs";
import { getSpaceById } from "@/server/spaces/queries";
import { releaseNameFor } from "./names";
import { getRevision, updateRevision } from "./queries";

/**
 * Release after apply: applying a revision tags a release, so verification
 * and rollback have a fixed target. Registered as
 * a plan-applied hook in jobs.ts: when a plan whose origin is a revision ends
 * in state "applied" (no failed items), request a release named after the
 * revision on the commit the apply made (requestCreateRelease with the plan
 * ID; releases of a given commit never sync first), and store it on the
 * revision. Idempotent: a revision that already has a release is left alone.
 */

export type RequestRelease = typeof requestCreateRelease;

export interface TagReleaseResult {
  revisionId: string;
  releaseId: string | null;
  releaseName: string;
  runId: string | null;
  error: string | null;
}

export async function tagReleaseAfterApply(event: Pick<PlanAppliedEvent, "planId" | "actor">, deps: { requestRelease?: RequestRelease } = {}): Promise<TagReleaseResult | null> {
  const plan = await dbPlanStore.getPlan(event.planId);
  if (!plan || plan.state !== "applied" || plan.origin.kind !== "revision") return null;
  const row = await getRevision(plan.spaceId, plan.origin.revisionId);
  if (!row || row.releaseId || row.releaseRunId) return null;
  const space = await getSpaceById(plan.spaceId);
  if (!space) return null;
  const { policy } = await policyForSpace(space);
  const releaseName = releaseNameFor(policy, row.name, space.alias);
  const actor: Actor = { email: plan.applyStartedBy ?? event.actor.email };
  const request = deps.requestRelease ?? requestCreateRelease;
  const audit = (result: "ok" | "error", details: Record<string, unknown>) =>
    recordAuditEvent({ actor, action: "revision.release", spaceId: space.id, targetType: "revision", targetId: row.id, result, details: { name: row.name, planId: plan.id, release: releaseName, commit: plan.resultCommit, ...details } });
  try {
    const { runId, releaseId } = await request(
      { spaceId: space.id, name: releaseName, note: fillTemplate(policy.revisions.release.note, { name: row.name, planId: plan.id }), commit: plan.resultCommit, planId: plan.id },
      actor,
    );
    await updateRevision(row.id, { state: "applied", planId: plan.id, releaseId, releaseName, releaseRunId: runId, releaseError: null });
    await audit("ok", { releaseId, runId });
    return { revisionId: row.id, releaseId, releaseName, runId, error: null };
  } catch (err) {
    // The apply is done either way; the release can still be created by hand on the Releases page.
    const message = err instanceof ReleaseError || err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
    await updateRevision(row.id, { state: "applied", planId: plan.id, releaseName, releaseError: message });
    await audit("error", { error: message });
    return { revisionId: row.id, releaseId: null, releaseName, runId: null, error: message };
  }
}
