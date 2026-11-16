"use server";

import { z } from "zod";
import type { ActionResult } from "@/components/plans/action-state";
import { AuthError, permissionsIn, requirePermission } from "@/server/auth/dal";
import { createPlanFromDrafts, discardDraft, draftAccessContext } from "@/server/drafts/service";
import type { Permission } from "@/server/policy";
import { actionError } from "@/server/plans/action-errors";
import type { PlanActor } from "@/server/plans/types";
import { getSpaceByAlias } from "@/server/spaces/queries";

/** Server Actions of the drafts page (pages/drafts.md, "Data"). */

async function spaceActor(alias: string, permission: Permission): Promise<{ spaceId: string; actor: PlanActor }> {
  const space = await getSpaceByAlias(z.string().min(1).max(200).parse(alias));
  if (!space) throw new AuthError(403, "Space not found");
  const user = await requirePermission(permission, space.id);
  return { spaceId: space.id, actor: { email: user.email, name: user.name, permissions: await permissionsIn(user, space.id) } };
}

const createInput = z.object({
  draftIds: z.array(z.string().uuid()).min(1, "Choose at least one draft.").max(200),
  title: z.string().trim().min(1, "Enter a plan title.").max(200, "Keep the title under 200 characters."),
});

/** "Create plan from <N> drafts": the viewer's own open drafts become one plan, which starts its check. */
export async function createPlanFromDraftsAction(alias: string, draftIds: string[], title: string): Promise<ActionResult<{ planId: string }>> {
  try {
    const input = createInput.parse({ draftIds, title });
    const { spaceId, actor } = await spaceActor(alias, "plans.create");
    const r = await createPlanFromDrafts({ spaceId, draftIds: input.draftIds, title: input.title }, actor);
    return { ok: true, planId: r.planId };
  } catch (err) {
    return actionError(err);
  }
}

/** "Discard" on a draft row. */
export async function discardDraftAction(alias: string, draftId: string): Promise<ActionResult> {
  try {
    const id = z.string().uuid().parse(draftId);
    const { spaceId, actor } = await spaceActor(alias, "drafts.write");
    const ctx = await draftAccessContext(id);
    if (!ctx || ctx.spaceId !== spaceId) throw new AuthError(403, "Draft not found in this space");
    await discardDraft({ spaceId, draftId: id }, actor);
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}
