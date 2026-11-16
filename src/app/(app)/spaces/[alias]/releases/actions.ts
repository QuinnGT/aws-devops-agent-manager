"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import type { CreateReleaseState, NameCheckState, RollbackPlanState } from "@/components/releases/action-state";
import { liveErrorNeedsSettings } from "@/server/assets/live";
import { AuthError, requirePermission } from "@/server/auth/dal";
import { checkReleaseNameForSpace, createRollbackPlan, getReleaseByName, ReleaseError, RELEASE_PERMISSIONS, requestCreateRelease } from "@/server/releases";
import { actorOf } from "@/server/spaces/actor";
import { getSpaceByAlias } from "@/server/spaces/queries";

/**
 * Server Actions for the release pages: find the space by alias, check the
 * permission for that space with the DAL, parse the form with Zod, then call
 * the releases service with the signed-in user as the actor.
 */

const aliasSchema = z.string().trim().min(1).max(200);
const NO_ACCESS = "You don't have permission to do this in this space.";

async function spaceFor(alias: unknown) {
  const parsed = aliasSchema.safeParse(alias);
  return parsed.success ? getSpaceByAlias(parsed.data) : null;
}

function authMessage(err: AuthError): string {
  return err.status === 401 ? "Sign in again to continue." : NO_ACCESS;
}

function text(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v : "";
}

// ---------- create release ----------

const createForm = z.object({
  name: z.string().trim().max(200),
  note: z.string().max(20000),
  commit: z.string().trim().max(64),
  planId: z.string().trim().max(200),
});

export async function createReleaseAction(alias: string, _prev: CreateReleaseState, formData: FormData): Promise<CreateReleaseState> {
  const space = await spaceFor(alias);
  if (!space) return { status: "error", message: NO_ACCESS, fieldErrors: {} };
  try {
    const user = await requirePermission(RELEASE_PERMISSIONS.create, space.id);
    const form = createForm.parse({ name: text(formData.get("name")), note: text(formData.get("note")), commit: text(formData.get("commit")), planId: text(formData.get("planId")) });
    const { runId } = await requestCreateRelease({ spaceId: space.id, name: form.name, note: form.note, commit: form.commit, planId: form.planId }, actorOf(user));
    return { status: "started", runId, name: form.name };
  } catch (err) {
    if (err instanceof AuthError) return { status: "error", message: authMessage(err), fieldErrors: {} };
    if (err instanceof ReleaseError) return { status: "error", message: err.message, fieldErrors: err.fieldErrors };
    if (err instanceof z.ZodError) {
      const field = err.issues[0]?.path[0];
      const message = field === "commit" ? "Enter a commit hash of 7 to 64 hex characters." : "Check the name and the notes.";
      return { status: "error", message, fieldErrors: typeof field === "string" ? { [field]: message } : {} };
    }
    throw err;
  }
}

// ---------- inline name check ----------

export async function checkReleaseNameAction(alias: string, name: string): Promise<NameCheckState> {
  const space = await spaceFor(alias);
  if (!space) return { ok: false, message: NO_ACCESS };
  const parsed = z.string().max(200).safeParse(name);
  if (!parsed.success) return { ok: false, message: "Use a shorter name." };
  try {
    await requirePermission(RELEASE_PERMISSIONS.create, space.id);
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, message: authMessage(err) };
    throw err;
  }
  return checkReleaseNameForSpace(space.id, parsed.data);
}

// ---------- a failed release job ----------

/** Whether a failed release job's error is one an Admin fixes in Space settings, so the dialog adds the next step. */
export async function releaseErrorNeedsSettingsAction(alias: string, error: string): Promise<boolean> {
  const space = await spaceFor(alias);
  if (!space) return false;
  try {
    await requirePermission(RELEASE_PERMISSIONS.create, space.id);
  } catch (err) {
    if (err instanceof AuthError) return false;
    throw err;
  }
  const parsed = z.string().max(2000).safeParse(error);
  return parsed.success && liveErrorNeedsSettings(parsed.data);
}

// ---------- create rollback plan ----------

const rollbackForm = z.object({ title: z.string().max(1000) });

export async function createRollbackPlanAction(alias: string, releaseName: string, _prev: RollbackPlanState, formData: FormData): Promise<RollbackPlanState> {
  const space = await spaceFor(alias);
  if (!space) return { status: "error", message: NO_ACCESS, fieldErrors: {}, problems: [] };
  let planId: string;
  try {
    const user = await requirePermission(RELEASE_PERMISSIONS.planRollback, space.id);
    const form = rollbackForm.parse({ title: text(formData.get("title")) });
    const name = z.string().trim().min(1).max(200).parse(releaseName);
    const release = await getReleaseByName(space.id, name);
    if (!release) return { status: "error", message: `This space has no release named ${name}.`, fieldErrors: {}, problems: [] };
    const created = await createRollbackPlan({ spaceId: space.id, target: { kind: "release", releaseId: release.id }, title: form.title }, actorOf(user));
    planId = created.planId;
  } catch (err) {
    if (err instanceof AuthError) return { status: "error", message: authMessage(err), fieldErrors: {}, problems: [] };
    if (err instanceof ReleaseError) return { status: "error", message: err.message, fieldErrors: err.fieldErrors, problems: err.problems.map((p) => p.message) };
    if (err instanceof z.ZodError) return { status: "error", message: "Use a shorter plan title.", fieldErrors: { title: "Use a shorter plan title." }, problems: [] };
    if (err instanceof Error && err.name === "PlanServiceError") return { status: "error", message: err.message, fieldErrors: {}, problems: [] };
    throw err;
  }
  // The plan page shows the plan in "checking" while the live-space check runs.
  redirect(`/spaces/${encodeURIComponent(space.alias)}/plans/${encodeURIComponent(planId)}`);
}
