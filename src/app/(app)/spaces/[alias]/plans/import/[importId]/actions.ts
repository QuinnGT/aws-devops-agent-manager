"use server";

import { redirect } from "next/navigation";
import { AuthError, requirePermission } from "@/server/auth/dal";
import { createPlanFromImport, createPlanRequestFromForm, layoutRequestFromForm, PACKAGE_IO_PERMISSIONS, PackageIoError, remapImport } from "@/server/package-io";
import { actorOf } from "@/server/spaces/actor";
import { getSpaceByAlias } from "@/server/spaces/queries";

export interface CreatePlanState {
  error: string | null;
}

/**
 * "Create plan with N changes": checks plans.create in the space, then
 * creates the plan from the import and opens it. The import ID comes from
 * the form and is only ever looked up inside this space.
 */
export async function createImportPlanAction(alias: string, _prev: CreatePlanState, form: FormData): Promise<CreatePlanState> {
  let planId: string;
  try {
    const space = await getSpaceByAlias(alias);
    if (!space) return { error: "There is no such space." };
    const user = await requirePermission(PACKAGE_IO_PERMISSIONS.plan, space.id);
    const { importId, options } = createPlanRequestFromForm(form);
    planId = (await createPlanFromImport(space, importId, actorOf(user), options)).planId;
  } catch (err) {
    if (err instanceof AuthError) return { error: err.status === 401 ? "You are signed out. Sign in and try again." : "You can't create plans in this space." };
    if (err instanceof PackageIoError) return { error: err.message };
    return { error: "The plan could not be created. Try again; if it fails again, check the app log." };
  }
  redirect(`/spaces/${encodeURIComponent(alias)}/plans/${planId}`);
}

export interface LayoutChoiceState {
  error: string | null;
}

/**
 * "Read again with this layout": checks plans.create in the space, then maps
 * the stored upload with the chosen layout and reloads the result page. The
 * import ID comes from the form and is only ever looked up inside this space.
 */
export async function changeImportLayoutAction(alias: string, _prev: LayoutChoiceState, form: FormData): Promise<LayoutChoiceState> {
  let importId: string;
  try {
    const space = await getSpaceByAlias(alias);
    if (!space) return { error: "There is no such space." };
    const user = await requirePermission(PACKAGE_IO_PERMISSIONS.import, space.id);
    const request = layoutRequestFromForm(form);
    importId = (await remapImport(space, request.importId, request.layout, actorOf(user))).importId;
  } catch (err) {
    if (err instanceof AuthError) return { error: err.status === 401 ? "You are signed out. Sign in and try again." : "You can't import packages in this space." };
    if (err instanceof PackageIoError) return { error: err.message };
    return { error: "The package could not be read again. Try again; if it fails again, check the app log." };
  }
  redirect(`/spaces/${encodeURIComponent(alias)}/plans/import/${importId}`);
}
