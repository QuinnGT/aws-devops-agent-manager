"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import type { FormState } from "@/components/spaces/form-state";
import { AuthError, requirePermission, requireUser, roleFor } from "@/server/auth/dal";
import { errorState, formValues, okState } from "@/server/spaces/action-result";
import { actorOf } from "@/server/spaces/actor";
import { getBinding, removeBinding, saveBinding } from "@/server/spaces/bindings";
import { SpaceServiceError } from "@/server/spaces/errors";
import { createHistoryRepo, updateHistoryRepo } from "@/server/spaces/history-repos";
import { bindingInputSchema, historyRepoFieldsSchema } from "@/server/spaces/validators";

function uuidOrThrow(id: unknown): string {
  const r = z.uuid().safeParse(id);
  if (!r.success) throw new AuthError(403, "Unknown item");
  return r.data;
}

function repoFields(v: Record<string, string>) {
  return historyRepoFieldsSchema.parse({
    name: v.name,
    remoteUrl: v.remoteUrl,
    deployKeyFile: v.deployKeyFile,
    defaultBranch: v.defaultBranch,
    pushEnabled: v.pushEnabled,
  });
}

/** Create a history repository (global spaces.manage). */
export async function createHistoryRepoAction(_prev: FormState, form: FormData): Promise<FormState> {
  const v = formValues(form);
  try {
    const user = await requirePermission("spaces.manage", null);
    await createHistoryRepo(repoFields(v), actorOf(user));
  } catch (err) {
    return errorState(err, v);
  }
  refresh();
  return okState("Repository added.");
}

/** Edit a history repository (global spaces.manage). */
export async function updateHistoryRepoAction(repoId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const v = formValues(form);
  try {
    const id = uuidOrThrow(repoId);
    const user = await requirePermission("spaces.manage", null);
    await updateHistoryRepo(id, repoFields(v), actorOf(user));
  } catch (err) {
    return errorState(err, v);
  }
  refresh();
  return okState("Repository saved.");
}

/** Bind a user or group to a role, globally or for one space (bindings.manage in that scope). */
export async function saveBindingAction(_prev: FormState, form: FormData): Promise<FormState> {
  const v = formValues(form);
  try {
    await requireUser();
    const input = bindingInputSchema.parse({ spaceId: v.spaceId, subjectType: v.subjectType, subject: v.subject, role: v.role });
    const user = await requirePermission("bindings.manage", input.spaceId);
    await saveBinding(input, actorOf(user), await roleFor(user, input.spaceId));
  } catch (err) {
    return errorState(err, v);
  }
  refresh();
  return okState("Binding saved.");
}

/** Remove a binding (bindings.manage in the binding's scope). */
export async function removeBindingAction(bindingId: string, _prev: FormState): Promise<FormState> {
  try {
    const id = uuidOrThrow(bindingId);
    await requireUser();
    const binding = await getBinding(id);
    if (!binding) throw new SpaceServiceError("That binding no longer exists.");
    const user = await requirePermission("bindings.manage", binding.spaceId);
    await removeBinding(id, actorOf(user), await roleFor(user, binding.spaceId));
  } catch (err) {
    return errorState(err);
  }
  refresh();
  return okState("Binding removed.");
}
