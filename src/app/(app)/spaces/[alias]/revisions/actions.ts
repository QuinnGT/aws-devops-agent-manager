"use server";

import { z } from "zod";
import type { ActionResult } from "@/components/plans/action-state";
import { AuthError, requirePermission } from "@/server/auth/dal";
import { abandonRevision, createPlanFromRevision, REVISION_PERMISSIONS, RevisionError, requestCreateRevision, requestSaveRevision } from "@/server/revisions";
import { actorOf } from "@/server/spaces/actor";
import { getSpaceByAlias } from "@/server/spaces/queries";

/**
 * Server Actions of the revision pages (pages/revisions.md and
 * revision-detail.md): look the space up by alias, check the permission for
 * that space with the DAL, parse the input with Zod, then call the revisions
 * service with the signed-in user as the actor. The service checks that the
 * revision belongs to the space.
 */

const NO_ACCESS = "You don't have permission to do this in this space.";
const aliasSchema = z.string().trim().min(1).max(200);
const idSchema = z.string().uuid();

async function spaceFor(alias: unknown) {
  const parsed = aliasSchema.safeParse(alias);
  return parsed.success ? getSpaceByAlias(parsed.data) : null;
}

function failure(err: unknown): { ok: false; message: string; fieldErrors: Record<string, string> } {
  if (err instanceof AuthError) return { ok: false, message: err.status === 401 ? "Sign in again to continue." : NO_ACCESS, fieldErrors: {} };
  if (err instanceof RevisionError) return { ok: false, message: err.message, fieldErrors: err.fieldErrors };
  if (err instanceof z.ZodError) return { ok: false, message: "The request is not valid. Reload the page and try again.", fieldErrors: {} };
  // createPlan refusals (plan limits, an apply in progress) are plain sentences.
  if (err instanceof Error && err.name === "PlanServiceError") return { ok: false, message: err.message, fieldErrors: {} };
  throw err;
}

// ---------- create ----------

const createForm = z.object({
  name: z.string().trim().max(200),
  base: z.enum(["live", "release"]),
  releaseId: z.string().trim().max(100),
  layout: z.string().trim().max(200),
});

export async function createRevisionAction(alias: string, input: z.input<typeof createForm>): Promise<ActionResult<{ runId: string; revisionId: string; name: string }>> {
  const space = await spaceFor(alias);
  if (!space) return { ok: false, message: NO_ACCESS, fieldErrors: {} };
  try {
    const user = await requirePermission(REVISION_PERMISSIONS.build, space.id);
    const form = createForm.parse(input);
    if (form.base === "release" && !idSchema.safeParse(form.releaseId).success) return { ok: false, message: "Choose a release.", fieldErrors: { base: "Choose a release." } };
    const base = form.base === "release" ? { kind: "release" as const, releaseId: form.releaseId } : { kind: "live" as const };
    const r = await requestCreateRevision(space, { name: form.name, base, layout: form.layout || null }, actorOf(user));
    return { ok: true, runId: r.runId, revisionId: r.revisionId, name: form.name };
  } catch (err) {
    return failure(err);
  }
}

// ---------- save ----------

const saveInput = z.object({
  revisionId: idSchema,
  message: z.string().max(5000),
  edits: z
    .array(z.object({ path: z.string().min(1).max(4096), content: z.string().nullable() }))
    .min(1)
    .max(500),
  findingIds: z.array(idSchema).max(100),
  unlinkedReason: z.string().max(5000).nullable(),
  expectedHead: z.string().max(64).nullable(),
});

export async function saveRevisionAction(alias: string, input: z.input<typeof saveInput>): Promise<ActionResult<{ runId: string; changeId: string }>> {
  const space = await spaceFor(alias);
  if (!space) return { ok: false, message: NO_ACCESS, fieldErrors: {} };
  try {
    const user = await requirePermission(REVISION_PERMISSIONS.build, space.id);
    const req = saveInput.parse(input);
    const r = await requestSaveRevision(
      space,
      req.revisionId,
      { message: req.message, edits: req.edits.map((e) => ({ path: e.path, encoding: "utf8" as const, content: e.content })), findingIds: req.findingIds, unlinkedReason: req.unlinkedReason, expectedHead: req.expectedHead },
      actorOf(user),
    );
    return { ok: true, runId: r.runId, changeId: r.changeId };
  } catch (err) {
    return failure(err);
  }
}

// ---------- plan ----------

/** Needs both `revisions.build` and `plans.create` (revision-detail.md, "Permissions"). */
export async function createRevisionPlanAction(alias: string, revisionId: string): Promise<ActionResult<{ planId: string }>> {
  const space = await spaceFor(alias);
  if (!space) return { ok: false, message: NO_ACCESS, fieldErrors: {} };
  try {
    await requirePermission(REVISION_PERMISSIONS.build, space.id);
    const user = await requirePermission(REVISION_PERMISSIONS.plan, space.id);
    const id = idSchema.parse(revisionId);
    const r = await createPlanFromRevision(space, id, actorOf(user));
    return { ok: true, planId: r.planId };
  } catch (err) {
    if (err instanceof RevisionError && err.results.length) {
      const first = err.results.slice(0, 3).map((x) => x.message);
      return { ok: false, message: `${err.message} ${first.join(" ")}`.trim(), fieldErrors: {} };
    }
    return failure(err);
  }
}

// ---------- abandon ----------

export async function abandonRevisionAction(alias: string, revisionId: string, note: string): Promise<ActionResult> {
  const space = await spaceFor(alias);
  if (!space) return { ok: false, message: NO_ACCESS, fieldErrors: {} };
  try {
    const user = await requirePermission(REVISION_PERMISSIONS.build, space.id);
    const id = idSchema.parse(revisionId);
    const text = z.string().max(2000).parse(note);
    await abandonRevision(space, id, actorOf(user), { note: text });
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
}
