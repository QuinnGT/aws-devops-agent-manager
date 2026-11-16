"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AuthError, requirePermission } from "@/server/auth/dal";
import { ExportRequestError, requestExport } from "@/server/journals/export";
import { ImportRequestError, saveUpload } from "@/server/journals/import";
import { policyForSpace } from "@/server/journals/policy";
import { splitIds } from "@/server/journals/selection";
import { getSpaceByAlias } from "@/server/spaces/queries";
import type { ActionState } from "./_components/action-state";

/**
 * Thin Server Actions: find the space, check the permission for that space
 * with the DAL, then hand off to the journals services, which validate the
 * input with Zod and enqueue the worker job.
 */

const aliasSchema = z.string().trim().min(1).max(200);

async function spaceFor(alias: unknown) {
  const parsed = aliasSchema.safeParse(alias);
  return parsed.success ? getSpaceByAlias(parsed.data) : null;
}

function text(v: FormDataEntryValue | null): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function texts(fd: FormData, name: string): string[] {
  return fd
    .getAll(name)
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map((v) => v.trim());
}

function failure(err: unknown, fallback: string): ActionState {
  if (err instanceof AuthError) {
    return { status: "error", message: err.status === 401 ? "Sign in again to continue." : "You do not have permission to do this in this space." };
  }
  if (err instanceof ExportRequestError || err instanceof ImportRequestError) return { status: "error", message: err.message };
  console.error(fallback, err);
  return { status: "error", message: `${fallback} Check the server log for details.` };
}

export async function requestExportAction(alias: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const space = await spaceFor(alias);
    if (!space) return { status: "error", message: "This space does not exist." };
    const user = await requirePermission("journals.export", space.id);
    const mode = text(formData.get("mode")) ?? "filter";
    const selection = {
      mode,
      from: text(formData.get("from")),
      to: text(formData.get("to")),
      taskTypes: texts(formData, "taskTypes"),
      statuses: texts(formData, "statuses"),
      priorities: texts(formData, "priorities"),
      taskIds: mode === "taskIds" ? splitIds(text(formData.get("taskIds"))) : [],
      incidentIds: mode === "incidentIds" ? splitIds(text(formData.get("incidentIds"))) : [],
    };
    const { exportJobId } = await requestExport(space, selection, { email: user.email });
    revalidatePath(`/spaces/${encodeURIComponent(space.alias)}/journals/exports`);
    return { status: "ok", message: "Export queued. Its progress is shown in the list below.", id: exportJobId };
  } catch (err) {
    return failure(err, "The export could not be queued.");
  }
}

export async function uploadImportAction(alias: string, _prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const space = await spaceFor(alias);
    if (!space) return { status: "error", message: "This space does not exist." };
    const user = await requirePermission("journals.import", space.id);
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { status: "error", message: "Choose a .md or .zip file to upload." };
    const max = (await policyForSpace(space)).policy.journals.import.maxUploadBytes;
    if (file.size > max) return { status: "error", message: `The file is larger than the ${Math.floor(max / 1048576)} MB limit.` };
    const bytes = Buffer.from(await file.arrayBuffer());
    const { importId } = await saveUpload(space, { fileName: file.name, bytes }, { email: user.email });
    revalidatePath(`/spaces/${encodeURIComponent(space.alias)}/journals/imports`);
    return { status: "ok", message: "Upload saved and queued for import. The report is shown in the list below.", id: importId };
  } catch (err) {
    return failure(err, "The upload could not be imported.");
  }
}
