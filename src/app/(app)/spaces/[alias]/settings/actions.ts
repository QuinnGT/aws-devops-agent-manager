"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import type { FormState } from "@/components/spaces/form-state";
import { AuthError, requirePermission } from "@/server/auth/dal";
import { errorState, formValues, okState } from "@/server/spaces/action-result";
import { actorOf } from "@/server/spaces/actor";
import { SpaceServiceError } from "@/server/spaces/errors";
import { getSpaceById, type Space } from "@/server/spaces/queries";
import { requestConnectionTest, updateSpace, updateSpaceSettings } from "@/server/spaces/service";
import { parseSettingsSectionForm, type SettingsSection, settingsSectionSchema } from "@/server/spaces/settings-form";
import { displayNameSchema, updateSpaceSchema } from "@/server/spaces/validators";

function spaceIdOrThrow(spaceId: unknown): string {
  const r = z.uuid().safeParse(spaceId);
  if (!r.success) throw new AuthError(403, "Unknown space");
  return r.data;
}

/** Check spaces.manage on the space, then read it fresh. */
async function manageSpace(spaceId: unknown): Promise<{ space: Space; actor: ReturnType<typeof actorOf> }> {
  const id = spaceIdOrThrow(spaceId);
  const user = await requirePermission("spaces.manage", id);
  const space = await getSpaceById(id);
  if (!space) throw new SpaceServiceError("That space no longer exists.");
  return { space, actor: actorOf(user) };
}

const SAVED: Record<SettingsSection, string> = {
  environment: "Environment saved.",
  capture: "Change capture saved.",
  incident: "Incident ID rule saved.",
  plans: "Plan rules saved.",
  inference: "Model review settings saved.",
  replays: "Replay settings saved.",
};

const access = (s: Space) => ({ displayName: s.displayName, readRoleArn: s.readRoleArn, writeRoleArn: s.writeRoleArn, awsProfile: s.awsProfile });

/** Display name (space row) and environment (settings), saved together (spaces.manage on the space). */
export async function updateSpaceDetailsAction(spaceId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const v = formValues(form);
  try {
    const { space, actor } = await manageSpace(spaceId);
    const displayName = displayNameSchema.safeParse(v.displayName);
    const settings = parseSettingsSectionForm("environment", form, space.parsedSettings);
    if (!displayName.success || !settings.success) {
      const issues = [
        ...(displayName.success ? [] : displayName.error.issues.map((i) => ({ ...i, path: ["displayName"] }))),
        ...(settings.success ? [] : settings.error.issues),
      ];
      throw new z.ZodError(issues);
    }
    const nameChanged = displayName.data !== space.displayName;
    const envChanged = settings.data.environment !== space.parsedSettings.environment;
    if (!nameChanged && !envChanged) return okState("No changes to save.");
    if (nameChanged) await updateSpace(space.id, { ...access(space), displayName: displayName.data }, actor);
    if (envChanged) await updateSpaceSettings(space.id, settings.data, actor);
  } catch (err) {
    return errorState(err, v);
  }
  refresh();
  return okState("Space details saved.");
}

/** Role ARNs and AWS profile (spaces.manage on the space). The display name is kept. */
export async function updateConnectionAction(spaceId: string, _prev: FormState, form: FormData): Promise<FormState> {
  const v = formValues(form);
  let changed = false;
  try {
    const { space, actor } = await manageSpace(spaceId);
    const input = updateSpaceSchema.parse({ displayName: space.displayName, readRoleArn: v.readRoleArn, writeRoleArn: v.writeRoleArn, awsProfile: v.awsProfile });
    changed = input.readRoleArn !== space.readRoleArn || input.writeRoleArn !== space.writeRoleArn || input.awsProfile !== space.awsProfile;
    await updateSpace(space.id, input, actor);
  } catch (err) {
    return errorState(err, v);
  }
  refresh();
  return okState(changed ? "Connection saved. Test the connection to check the new access." : "Connection saved.");
}

/** One settings section: the form's keys replace the stored ones (spaces.manage on the space). */
export async function updateSettingsSectionAction(spaceId: string, section: string, _prev: FormState, form: FormData): Promise<FormState> {
  const v = formValues(form);
  let which: SettingsSection;
  try {
    which = settingsSectionSchema.parse(section);
    const { space, actor } = await manageSpace(spaceId);
    const parsed = parseSettingsSectionForm(which, form, space.parsedSettings);
    if (!parsed.success) throw parsed.error;
    await updateSpaceSettings(space.id, parsed.data, actor);
  } catch (err) {
    return errorState(err, v);
  }
  refresh();
  return okState(SAVED[which]);
}

/** Start a connection test (spaces.manage on the space). Returns the job run for JobProgress. */
export async function testConnectionAction(spaceId: string, _prev: FormState): Promise<FormState> {
  try {
    const { space, actor } = await manageSpace(spaceId);
    const runId = await requestConnectionTest(space.id, actor, "manual");
    return okState("Connection test started.", { runId });
  } catch (err) {
    return errorState(err);
  }
}
