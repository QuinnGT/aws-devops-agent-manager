"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { recordAuditEvent } from "@/server/audit-log";
import { AuthError, permissionsIn, requirePermission, type AppUser } from "@/server/auth/dal";
import { URL_ASSET_ID } from "@/server/assets/config";
import { assetActionRules } from "@/server/assets/edit-rules";
import { assetDirectory, getIndexedAsset, type IndexedAsset } from "@/server/assets/queries";
import { createDraftFromAsset, getDraft, listDrafts, updateDraft, STATUS_KEY, type DraftActor } from "@/server/drafts";
import { policyFor } from "@/server/assets/browse";
import { openSpaceHistoryRepo } from "@/server/assets/repo";
import type { Permission } from "@/server/policy";
import { plainErrorOf } from "@/server/jobs/error-text";
import { PlanServiceError } from "@/server/plans/types";
import { createRollbackPlan, ReleaseError } from "@/server/releases";
import { actorOf } from "@/server/spaces/actor";
import { getSpaceByAlias, type Space } from "@/server/spaces/queries";

/**
 * Server Actions of the asset page and list: thin wrappers that look up the
 * space, check the permission for it with the DAL, parse input with Zod and
 * call the drafts or releases service with the acting user.
 */

export type AssetActionResult = { ok: true; message: string } | { ok: false; message: string };

const NO_ACCESS = "You don't have permission to do this in this space.";

const target = z.object({ alias: z.string().min(1).max(100), assetId: z.string().regex(URL_ASSET_ID) });

interface Context {
  space: Space;
  user: AppUser;
  asset: IndexedAsset;
}

type Lookup = { ok: true; ctx: Context } | { ok: false; result: AssetActionResult };

async function lookup(input: unknown, permission: Permission): Promise<Lookup> {
  const parsed = target.safeParse(input);
  const space = parsed.success ? await getSpaceByAlias(parsed.data.alias) : null;
  // A missing space and a missing permission read the same, so the action doesn't reveal which spaces exist.
  if (!parsed.success || !space) return { ok: false, result: { ok: false, message: NO_ACCESS } };
  let user: AppUser;
  try {
    user = await requirePermission(permission, space.id);
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, result: { ok: false, message: err.status === 401 ? "Sign in again to continue." : NO_ACCESS } };
    throw err;
  }
  const asset = await getIndexedAsset(space.id, parsed.data.assetId);
  if (!asset) return { ok: false, result: { ok: false, message: "This asset is not recorded in this space." } };
  return { ok: true, ctx: { space, user, asset } };
}

async function draftActor(user: AppUser, spaceId: string): Promise<DraftActor> {
  return { ...actorOf(user), permissions: await permissionsIn(user, spaceId) };
}

async function rulesFor(ctx: Context) {
  const [directory, repo] = await Promise.all([assetDirectory(ctx.space.id), openSpaceHistoryRepo(ctx.space)]);
  const m = ctx.asset.metadata;
  const metadata = m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
  return assetActionRules(policyFor(repo), { assetType: ctx.asset.assetType, metadata }, (type, id) => {
    const d = directory.get(id);
    return d && d.assetType === type ? d.name : undefined;
  });
}

/** The user's open or planned draft of the asset, or a new one from the live version (the Active switch). */
async function ensureDraft(ctx: Context, actor: DraftActor): Promise<string> {
  const mine = await listDrafts(ctx.space.id, { createdBy: ctx.user.email });
  const open = mine.find((d) => d.assetId === ctx.asset.assetId);
  if (open) return open.id;
  return (await createDraftFromAsset({ spaceId: ctx.space.id, assetId: ctx.asset.assetId }, actor)).draftId;
}

function failure(err: unknown, what: string): AssetActionResult {
  if (err instanceof AuthError) return { ok: false, message: err.status === 401 ? "Sign in again to continue." : NO_ACCESS };
  if (err instanceof PlanServiceError) return { ok: false, message: err.message };
  if (err instanceof ReleaseError) {
    const first = err.problems.find((p) => p.level === "error");
    return { ok: false, message: first ? `${err.message} ${first.message}` : err.message };
  }
  // Anything else is a failed live read or an unexpected error: plain words from liveErrorMessage.
  return { ok: false, message: `${what}. ${plainErrorOf(err)}` };
}

const statusInput = z.enum(["ACTIVE", "INACTIVE"]);

/** The Active switch: put the status change in the user's draft of the asset. */
export async function setStatusInDraftAction(alias: string, assetId: string, status: string): Promise<AssetActionResult> {
  const found = await lookup({ alias, assetId }, "drafts.write");
  if (!found.ok) return found.result;
  const parsed = statusInput.safeParse(status);
  if (!parsed.success) return { ok: false, message: "Choose Active or Inactive." };
  const { ctx } = found;
  if (ctx.asset.deletedAt) return { ok: false, message: "This asset was deleted from the space." };
  const rules = await rulesFor(ctx);
  if (!rules.supportsStatus || !rules.rules.status) return { ok: false, message: rules.rules.reason ?? "The Active switch doesn't apply to this asset type." };
  try {
    const actor = await draftActor(ctx.user, ctx.space.id);
    const draftId = await ensureDraft(ctx, actor);
    const draft = await getDraft(ctx.space.id, draftId);
    if (!draft) return { ok: false, message: "Your draft could not be read. Reload the page." };
    const before = draft.desired.metadata[STATUS_KEY] ?? null;
    await updateDraft({ spaceId: ctx.space.id, draftId, metadata: { ...draft.desired.metadata, [STATUS_KEY]: parsed.data }, expectedUpdatedAt: draft.updatedAt.toISOString() }, actor);
    await recordAuditEvent({
      actor: { email: actor.email, name: actor.name ?? null },
      action: "draft.update",
      spaceId: ctx.space.id,
      targetType: "draft",
      targetId: draftId,
      details: { assetId: ctx.asset.assetId, assetType: ctx.asset.assetType, via: "asset status switch", status: { before, after: parsed.data } },
    });
  } catch (err) {
    return failure(err, "Could not add the change to your draft");
  }
  return { ok: true, message: "Added to your draft. Create a plan to apply it." };
}

const versionInput = z.coerce.number().int().min(1).max(1_000_000_000);

/** "Restore v<N> as a plan" and "Restore as a plan": a rollback plan for one version of the asset. */
export async function restoreVersionAction(alias: string, assetId: string, version: number): Promise<AssetActionResult> {
  const found = await lookup({ alias, assetId }, "plans.create");
  if (!found.ok) return found.result;
  const parsed = versionInput.safeParse(version);
  if (!parsed.success) return { ok: false, message: "Pick a recorded version." };
  const { ctx } = found;
  const rules = await rulesFor(ctx);
  if (!rules.typeEditable) return { ok: false, message: rules.rules.reason ?? "This asset can't be restored in this app." };
  if (rules.contentLocked) return { ok: false, message: rules.contentLocked };
  let planId: string;
  try {
    const r = await createRollbackPlan({ spaceId: ctx.space.id, target: { kind: "version", assetId: ctx.asset.assetId, version: parsed.data } }, actorOf(ctx.user));
    planId = r.planId;
  } catch (err) {
    return failure(err, "Could not create the plan");
  }
  redirect(`/spaces/${encodeURIComponent(ctx.space.alias)}/plans/${encodeURIComponent(planId)}`);
}
