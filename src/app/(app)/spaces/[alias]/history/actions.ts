"use server";

import { AuthError, requirePermission } from "@/server/auth/dal";
import { requestAddReason } from "@/server/assets/jobs";
import { addReasonRequest, ReasonError } from "@/server/assets/reasons";
import { getSpaceByAlias } from "@/server/spaces/queries";
import type { AddReasonState } from "@/components/assets/add-reason-form";

/** Add a change reason to a change made outside the app. Requires reasons.write in the space. */
export async function addReasonAction(_prev: AddReasonState, formData: FormData): Promise<AddReasonState> {
  const alias = String(formData.get("alias") ?? "");
  const space = alias ? await getSpaceByAlias(alias) : null;
  if (!space) return { status: "error", message: "Space not found" };
  try {
    const user = await requirePermission("reasons.write", space.id);
    const parsed = addReasonRequest.safeParse({
      spaceId: space.id,
      assetId: String(formData.get("assetId") ?? ""),
      commit: String(formData.get("commit") ?? ""),
      reason: String(formData.get("reason") ?? ""),
      link: String(formData.get("link") ?? ""),
    });
    if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Check the form" };
    const { runId } = await requestAddReason(parsed.data, { email: user.email });
    return { status: "queued", runId };
  } catch (err) {
    if (err instanceof AuthError) {
      return { status: "error", message: err.status === 401 ? "Sign in again to add a reason" : "You don't have permission to add reasons in this space" };
    }
    if (err instanceof ReasonError) return { status: "error", message: err.message };
    throw err;
  }
}
