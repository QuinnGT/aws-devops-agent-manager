"use server";

import { z } from "zod";
import type { ActionResult } from "@/components/plans/action-state";
import { AuthError, permissionsIn, requirePermission } from "@/server/auth/dal";
import { discardDraft, draftAccessContext, getDraft, rebaseDraft, saveNewDraft, updateDraft } from "@/server/drafts/service";
import { actionError } from "@/server/plans/action-errors";
import { type PlanActor, PlanServiceError } from "@/server/plans/types";
import type { ValidationResult } from "@/server/validation/types";
import { getSpaceByAlias } from "@/server/spaces/queries";

/** Server Actions of the draft editor (draft-editor.md, "Data"): save, discard and "Use v<b> as the base". All need drafts.write. */

async function draftsActor(alias: string): Promise<{ spaceId: string; actor: PlanActor }> {
  const space = await getSpaceByAlias(z.string().min(1).max(200).parse(alias));
  if (!space) throw new AuthError(403, "Space not found");
  const user = await requirePermission("drafts.write", space.id);
  return { spaceId: space.id, actor: { email: user.email, name: user.name, permissions: await permissionsIn(user, space.id) } };
}

async function ownDraftInSpace(spaceId: string, draftId: string, assetId?: string) {
  const ctx = await draftAccessContext(draftId);
  if (!ctx || ctx.spaceId !== spaceId) throw new AuthError(403, "Draft not found in this space");
  if (assetId) {
    const d = await getDraft(spaceId, draftId);
    if (!d || d.assetId !== assetId) throw new AuthError(403, "Draft not found for this asset");
  }
}

const file = z.object({ path: z.string().min(1).max(512), encoding: z.enum(["utf8", "base64"]), content: z.string() });
const saveInput = z.object({
  assetId: z.string().min(1).max(200),
  draftId: z.string().uuid().nullable(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).nullable(),
  /** For the first save: where the editor's starting text came from, and its version */
  from: z.enum(["live", "committed"]).nullable(),
  expectedBaseVersion: z.number().int().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  refs: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  /** Changed files only; the draft keeps the others */
  files: z.array(file).max(2000),
});

export type SaveDraftInput = z.input<typeof saveInput>;
export type SaveDraftResult = ActionResult<{ draftId: string; updatedAt: string; validation: ValidationResult[] }>;

export async function saveDraftAction(alias: string, raw: SaveDraftInput): Promise<SaveDraftResult> {
  try {
    const input = saveInput.parse(raw);
    const { spaceId, actor } = await draftsActor(alias);
    if (input.draftId) {
      await ownDraftInSpace(spaceId, input.draftId, input.assetId);
      const r = await updateDraft(
        { spaceId, draftId: input.draftId, expectedUpdatedAt: input.expectedUpdatedAt, metadata: input.metadata, refs: input.refs, files: input.files, filesMode: "merge" },
        actor,
      );
      return { ok: true, draftId: r.draft.id, updatedAt: r.draft.updatedAt.toISOString(), validation: r.validation };
    }
    if (!input.from || input.expectedBaseVersion === null) throw new PlanServiceError("The editor's starting version is missing. Reload the page.");
    const r = await saveNewDraft(
      { spaceId, assetId: input.assetId, from: input.from, expectedBaseVersion: input.expectedBaseVersion, metadata: input.metadata, refs: input.refs, files: input.files, filesMode: "merge" },
      actor,
    );
    return { ok: true, draftId: r.draftId, updatedAt: r.updatedAt.toISOString(), validation: r.validation };
  } catch (err) {
    return actionError(err);
  }
}

export async function discardDraftAction(alias: string, draftId: string): Promise<ActionResult> {
  try {
    const id = z.string().uuid().parse(draftId);
    const { spaceId, actor } = await draftsActor(alias);
    await ownDraftInSpace(spaceId, id);
    await discardDraft({ spaceId, draftId: id }, actor);
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}

/** "Use v<b> as the base": keeps the draft's text, moves its base to the live version. */
export async function rebaseDraftAction(alias: string, draftId: string): Promise<ActionResult> {
  try {
    const id = z.string().uuid().parse(draftId);
    const { spaceId, actor } = await draftsActor(alias);
    await ownDraftInSpace(spaceId, id);
    await rebaseDraft({ spaceId, draftId: id }, actor);
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}
