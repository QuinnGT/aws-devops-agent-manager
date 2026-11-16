"use server";

import { z } from "zod";
import type { RunCheckState } from "@/components/verify/action-state";
import { AuthError, requirePermission } from "@/server/auth/dal";
import { getReleaseByName } from "@/server/releases/queries";
import { actorOf } from "@/server/spaces/actor";
import { getSpaceByAlias } from "@/server/spaces/queries";
import { requestVerification, VERIFY_KINDS, VERIFY_PERMISSIONS, VerifyRequestError } from "@/server/verify";

/**
 * "Run check" on the release Verification tab: find the space by alias,
 * check `sync.run` there (VERIFY_PERMISSIONS.start), look the release up in
 * that space by name, then queue the check. The audit log entry is written
 * by requestVerification.
 */

const input = z.object({
  alias: z.string().trim().min(1).max(200),
  releaseName: z.string().trim().min(1).max(200),
  kind: z.enum(VERIFY_KINDS),
});

const NO_ACCESS = "You don't have permission to run checks in this space.";

export async function runVerificationCheckAction(alias: string, releaseName: string, kind: string, _prev: RunCheckState): Promise<RunCheckState> {
  void _prev;
  const parsed = input.safeParse({ alias, releaseName, kind });
  if (!parsed.success) return { status: "error", message: "Choose a release and a check." };
  const space = await getSpaceByAlias(parsed.data.alias);
  if (!space) return { status: "error", message: NO_ACCESS };
  try {
    const user = await requirePermission(VERIFY_PERMISSIONS.start, space.id);
    const release = await getReleaseByName(space.id, parsed.data.releaseName);
    if (!release) return { status: "error", message: `This space has no release named ${parsed.data.releaseName}.` };
    const r = await requestVerification({ spaceId: space.id, releaseId: release.id, kind: parsed.data.kind }, actorOf(user));
    return { status: "started", runId: r.runId, alreadyOpen: r.alreadyOpen };
  } catch (err) {
    if (err instanceof AuthError) return { status: "error", message: err.status === 401 ? "Sign in again to continue." : NO_ACCESS };
    if (err instanceof VerifyRequestError) return { status: "error", message: err.message };
    console.error("Queuing a release check failed", err);
    return { status: "error", message: "The check could not be queued. Try again in a minute." };
  }
}
