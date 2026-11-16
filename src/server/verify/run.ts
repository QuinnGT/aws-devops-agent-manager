import { z } from "zod";
import type { JobContext } from "@/server/jobs/registry";
import { getRelease, type ReleaseRow } from "@/server/releases/queries";
import { getSpaceById, type Space } from "@/server/spaces/queries";
import { BLOCKED_MESSAGES } from "./config";
import { getVerification, updateVerification, type VerificationRow } from "./queries";
import type { BlockedReason, VerifyKind, VerifyState } from "./types";

/** Shared steps of the verify.live and verify.reads jobs: load the run, mark it running, finish it. */

export const verifyJobInput = z.object({ verificationId: z.string().uuid() });
export type VerifyJobInput = z.output<typeof verifyJobInput>;

export interface VerifyJobResult {
  verificationId: string;
  state: VerifyState;
  blockedReason?: BlockedReason;
  /** Short counts for the job log and the job progress page */
  summary?: Record<string, number | string | boolean>;
}

export interface StartedRun {
  run: VerificationRow;
  release: ReleaseRow;
  space: Space;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Load and mark a run running. Returns the finished result instead when the run already finished (a retried job). */
export async function startRun(input: VerifyJobInput, ctx: JobContext, kind: VerifyKind): Promise<StartedRun | VerifyJobResult> {
  const run = await getVerification(input.verificationId);
  if (!run) throw new Error(`Verification ${input.verificationId} not found`);
  if (run.kind !== kind) throw new Error(`Verification ${run.id} is a ${run.kind} check, not ${kind}`);
  if (ctx.spaceId && ctx.spaceId !== run.spaceId) throw new Error("The job's space does not match the verification's space");
  if (run.state === "succeeded" || run.state === "blocked" || run.state === "cancelled") {
    return { verificationId: run.id, state: run.state, ...(run.blockedReason ? { blockedReason: run.blockedReason as BlockedReason } : {}) };
  }
  const [release, space] = await Promise.all([getRelease(run.spaceId, run.releaseId), getSpaceById(run.spaceId)]);
  if (!release || !space) throw new Error(`The release or space of verification ${run.id} no longer exists`);
  await updateVerification(run.id, { state: "running", startedAt: new Date(), message: null, ...(UUID.test(ctx.runId) ? { jobRunId: ctx.runId } : {}) });
  return { run, release, space };
}

export function isFinished(v: StartedRun | VerifyJobResult): v is VerifyJobResult {
  return "state" in v;
}

export async function finishBlocked(run: VerificationRow, reason: BlockedReason, detail: string | null, extra: { result?: unknown; investigations?: string[] } = {}): Promise<VerifyJobResult> {
  const message = detail ? `${BLOCKED_MESSAGES[reason]} ${detail}` : BLOCKED_MESSAGES[reason];
  await updateVerification(run.id, {
    state: "blocked",
    blockedReason: reason,
    message: message.slice(0, 2000),
    result: (extra.result ?? null) as object | null,
    investigations: extra.investigations ?? [],
    investigationCount: extra.investigations?.length ?? 0,
    finishedAt: new Date(),
  });
  return { verificationId: run.id, state: "blocked", blockedReason: reason };
}

export async function finishSucceeded(run: VerificationRow, result: object, investigations: string[] = []): Promise<void> {
  await updateVerification(run.id, { state: "succeeded", blockedReason: null, message: null, result, investigations, investigationCount: investigations.length, finishedAt: new Date() });
}

export async function finishCancelled(run: VerificationRow): Promise<VerifyJobResult> {
  await updateVerification(run.id, { state: "cancelled", finishedAt: new Date() });
  return { verificationId: run.id, state: "cancelled" };
}

export async function finishFailed(run: VerificationRow, err: unknown): Promise<void> {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  await updateVerification(run.id, { state: "failed", message: message.slice(0, 2000), finishedAt: new Date() });
}

/** A JobContext whose progress maps 0..1 onto [from, to] of the parent's, with a message prefix. */
export function subContext(ctx: JobContext, from: number, to: number, prefix?: string): JobContext {
  return {
    ...ctx,
    progress: (fraction, message) => ctx.progress(from + Math.max(0, Math.min(1, fraction)) * (to - from), message && prefix ? `${prefix}: ${message}` : (message ?? prefix)),
  };
}
