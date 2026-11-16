import type { WriteModes } from "@/server/policy/sections/plans";
import { fileChanges, type HashedFile } from "./content";
import type { WriteStep } from "./types";

/**
 * Which API calls an item needs (policy/plans.yaml `write`). Pure.
 *
 * From the SDK model and the asset guide: CreateAsset needs content (one file
 * or a zip); UpdateAsset takes an optional content (one file adds or
 * replaces that file, a zip replaces all files) and a metadata PATCH;
 * UpdateAssetFile, CreateAssetFile and DeleteAssetFile change one file each.
 */

export interface WritePlanInput {
  kind: "create" | "update" | "delete";
  /** The type's content shape is multi-file (asset-types.yaml `content`) */
  multiFile: boolean;
  modes: WriteModes;
  /** Live files (updates only) */
  live: readonly HashedFile[];
  desired: readonly HashedFile[];
  /** The metadata PATCH is not empty */
  metadataChanged: boolean;
}

export type WritePlan = { ok: true; steps: WriteStep[] } | { ok: false; message: string };

export function planWriteSteps(input: WritePlanInput): WritePlan {
  if (input.kind === "delete") return { ok: true, steps: [{ op: "DeleteAsset" }] };

  if (input.kind === "create") {
    const mode = input.modes.create === "auto" ? (input.desired.length === 1 ? "file" : "zip") : input.modes.create;
    if (mode === "file" && input.desired.length !== 1) {
      return { ok: false, message: `This asset has ${input.desired.length} files, and plans.yaml creates this type with one file. Set write.types.<type>.create to zip or auto.` };
    }
    return { ok: true, steps: [{ op: "CreateAsset", content: mode }] };
  }

  const { added, changed, removed } = fileChanges(input.live, input.desired);
  if (added.length + changed.length + removed.length === 0) {
    return { ok: true, steps: input.metadataChanged ? [{ op: "UpdateAsset", content: null }] : [] };
  }
  const single = added.length + changed.length === 1 && removed.length === 0;
  const mode = input.modes.content === "auto" ? (single ? "file" : input.multiFile ? "zip" : "files") : input.modes.content;

  if (mode === "file") {
    if (!single) {
      return {
        ok: false,
        message: `This change adds or changes ${added.length + changed.length} files and removes ${removed.length}; plans.yaml writes this type one file at a time with UpdateAsset. Set write.types.<type>.content to auto, zip or files.`,
      };
    }
    return { ok: true, steps: [{ op: "UpdateAsset", content: "file", path: (added[0] ?? changed[0])! }] };
  }
  if (mode === "zip") return { ok: true, steps: [{ op: "UpdateAsset", content: "zip" }] };

  const steps: WriteStep[] = [
    ...changed.map((path): WriteStep => ({ op: "UpdateAssetFile", path })),
    ...added.map((path): WriteStep => ({ op: "CreateAssetFile", path })),
    ...removed.map((path): WriteStep => ({ op: "DeleteAssetFile", path })),
  ];
  if (input.metadataChanged) steps.push({ op: "UpdateAsset", content: null });
  return { ok: true, steps };
}

/** What apply will do to the asset, in plain words ("change AGENTS.md, update the details"), or null for no write. */
export function describeStepsPlain(steps: readonly WriteStep[]): string | null {
  if (!steps.length) return null;
  const parts = steps.map((s) => {
    switch (s.op) {
      case "CreateAsset":
        return "create the asset";
      case "UpdateAsset":
        return s.content === "zip" ? "replace all its files" : s.content ? `replace ${s.path ?? "its file"}` : "update its details and status";
      case "DeleteAsset":
        return "delete the asset";
      case "UpdateAssetFile":
        return `change ${s.path}`;
      case "CreateAssetFile":
        return `add ${s.path}`;
      case "DeleteAssetFile":
        return `remove ${s.path}`;
    }
  });
  return `Apply will ${[...new Set(parts)].join(", ")}.`;
}

/** Short description of the calls, for the plan page and logs. */
export function describeSteps(steps: readonly WriteStep[]): string {
  if (!steps.length) return "No write";
  return steps
    .map((s) => {
      switch (s.op) {
        case "CreateAsset":
          return `CreateAsset (${s.content})`;
        case "UpdateAsset":
          return s.content ? `UpdateAsset (${s.content}${s.path ? ` ${s.path}` : ""})` : "UpdateAsset (metadata)";
        case "DeleteAsset":
          return "DeleteAsset";
        default:
          return `${s.op} ${s.path}`;
      }
    })
    .join(", ");
}
