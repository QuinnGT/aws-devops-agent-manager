import { z } from "zod";
import { recordAuditEvent } from "@/server/audit-log";
import type { Actor } from "@/server/aws/clients";
import { enqueue as enqueueJob } from "@/server/jobs/enqueue";
import { getRelease } from "@/server/releases/queries";
import { VERIFY_AUDIT_ACTION } from "./config";
import { VERIFY_JOBS } from "./jobs";
import { insertVerification, openVerification, updateVerification } from "./queries";
import { VERIFY_KINDS, type VerifyKind } from "./types";

/**
 * Starting a check (a person on the release page). The Server Action checks
 * `sync.run` for the space first (VERIFY_PERMISSIONS.start); the release is
 * looked up in that space, so a client can't name a release of another space.
 */

export const requestVerificationInput = z.object({
  spaceId: z.string().uuid(),
  releaseId: z.string().uuid(),
  kind: z.enum(VERIFY_KINDS),
});

export type RequestVerificationInput = z.input<typeof requestVerificationInput>;

export class VerifyRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyRequestError";
  }
}

export type EnqueueVerify = (kind: VerifyKind, input: { verificationId: string }, opts: { actor: Actor; spaceId: string }) => Promise<string>;

const defaultEnqueue: EnqueueVerify = (kind, input, opts) => enqueueJob(VERIFY_JOBS[kind], input, opts);

export interface RequestVerificationResult {
  verificationId: string;
  /** job_runs id for progress polling; null when the open check has none yet */
  runId: string | null;
  /** A check of this kind was already queued or running; it is returned instead of a new one */
  alreadyOpen: boolean;
}

export async function requestVerification(
  request: RequestVerificationInput,
  actor: Actor,
  deps: { enqueue?: EnqueueVerify } = {},
): Promise<RequestVerificationResult> {
  const parsed = requestVerificationInput.safeParse(request);
  if (!parsed.success) throw new VerifyRequestError("Choose a release and a check.");
  const { spaceId, releaseId, kind } = parsed.data;
  const release = await getRelease(spaceId, releaseId);
  if (!release) throw new VerifyRequestError("This space has no such release.");
  const open = await openVerification(spaceId, releaseId, kind);
  if (open) return { verificationId: open.id, runId: open.jobRunId, alreadyOpen: true };

  const row = await insertVerification({ spaceId, releaseId, kind, trigger: "manual", requestedBy: actor.email });
  let runId: string;
  try {
    runId = await (deps.enqueue ?? defaultEnqueue)(kind, { verificationId: row.id }, { actor, spaceId });
  } catch (err) {
    await updateVerification(row.id, { state: "failed", message: "The check could not be queued.", finishedAt: new Date() });
    throw err;
  }
  await updateVerification(row.id, { jobRunId: runId });
  await recordAuditEvent({
    actor,
    action: VERIFY_AUDIT_ACTION,
    spaceId,
    targetType: "release",
    targetId: releaseId,
    details: { kind, release: release.name, verificationId: row.id, runId },
  });
  return { verificationId: row.id, runId, alreadyOpen: false };
}
