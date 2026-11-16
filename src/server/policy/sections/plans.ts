import { z } from "zod";
import { defineSection } from "./define";

/**
 * Drafts, plans, approval and apply. policy/plans.yaml documents each key.
 */

/** How apply creates an asset: one inline file, a zip of every file, or auto (file for one file, zip otherwise). */
export const createModeSchema = z.enum(["file", "zip", "auto"]);
/**
 * How apply writes a content change to an existing asset:
 * - file: one UpdateAsset with the one added or changed file (other files stay)
 * - zip: one UpdateAsset with a zip of every file (replaces all files)
 * - files: UpdateAssetFile, CreateAssetFile and DeleteAssetFile per file, then UpdateAsset for metadata
 * - auto: file when it applies, otherwise zip for multi-file types and files for the others
 */
export const contentModeSchema = z.enum(["file", "zip", "files", "auto"]);
export type CreateMode = z.output<typeof createModeSchema>;
export type ContentMode = z.output<typeof contentModeSchema>;

const writeModes = z.object({ create: createModeSchema.default("auto"), content: contentModeSchema.default("auto") });
export type WriteModes = z.output<typeof writeModes>;

// Tested on a test space (2026-11-13): the API writes a managed memory's content and metadata.
const managedDefault = { allowStatusSwitch: true, allowContentEdit: true, allowMetadataEdit: true };
const applyDefault = { readBackAttempts: 3, readBackDelayMs: 1500 };
const approvalDefault = { rejectNoteRequired: true, recheckClearsApproval: true };
const limitsDefault = { maxItemsPerPlan: 500, titleMaxChars: 200, reasonMaxChars: 2000, noteMaxChars: 2000 };
const checkDefault = { concurrency: 4 };

export const plansSection = defineSection(
  "plans.yaml",
  z.object({
    /**
     * Managed memory stores (asset-types.yaml memory_store.managedNames) and
     * their memories. The API writes their content and
     * metadata; each switch can still turn one off.
     */
    managed: z
      .object({
        /** The Active switch (metadata.status) on a managed store or memory */
        allowStatusSwitch: z.boolean().default(managedDefault.allowStatusSwitch),
        /** File content of a managed memory or store */
        allowContentEdit: z.boolean().default(managedDefault.allowContentEdit),
        /** Metadata other than status */
        allowMetadataEdit: z.boolean().default(managedDefault.allowMetadataEdit),
      })
      .default(managedDefault),
    write: z
      .object({
        /** Modes for asset types without an entry in `types` */
        default: writeModes.default({ create: "auto", content: "auto" }),
        /** Per asset type */
        types: z.record(z.string(), writeModes).default({}),
        /**
         * How a metadata key is removed under PATCH semantics:
         * send sends [] for an array key and null for any other key (the API
         * rejects null for an array key); refuse fails the check for that item.
         * send-null is the old name of send.
         */
        metadataRemoval: z
          .enum(["send", "send-null", "refuse"])
          .default("send")
          .transform((v) => (v === "send-null" ? "send" : v)),
      })
      .default({ default: { create: "auto", content: "auto" }, types: {}, metadataRemoval: "send" }),
    /**
     * Apply order of asset types. Types other assets reference must come first
     * (stores and skills before memories and custom agents). Unlisted types go
     * last. Deletes run after every other item, in reverse order.
     */
    applyOrder: z.array(z.string()).default(["memory_store", "skill", "agents_md", "test_profile", "memory", "custom_agent"]),
    apply: z
      .object({
        /** Read-backs after a write before the item is marked Failed (the service may be eventually consistent) */
        readBackAttempts: z.number().int().min(1).max(10).default(applyDefault.readBackAttempts),
        /** Milliseconds between read-backs */
        readBackDelayMs: z.number().int().min(0).max(60_000).default(applyDefault.readBackDelayMs),
      })
      .default(applyDefault),
    check: z
      .object({
        /** Parallel live reads in one plan check */
        concurrency: z.number().int().min(1).max(32).default(checkDefault.concurrency),
      })
      .default(checkDefault),
    approval: z
      .object({
        /** Rejecting a plan needs a note */
        rejectNoteRequired: z.boolean().default(approvalDefault.rejectNoteRequired),
        /** A re-check after approval needs a new approval when the space requires one */
        recheckClearsApproval: z.boolean().default(approvalDefault.recheckClearsApproval),
      })
      .default(approvalDefault),
    limits: z
      .object({
        maxItemsPerPlan: z.number().int().min(1).default(limitsDefault.maxItemsPerPlan),
        titleMaxChars: z.number().int().min(1).default(limitsDefault.titleMaxChars),
        reasonMaxChars: z.number().int().min(1).default(limitsDefault.reasonMaxChars),
        noteMaxChars: z.number().int().min(1).default(limitsDefault.noteMaxChars),
      })
      .default(limitsDefault),
  }),
);

export type PlansPolicy = z.output<typeof plansSection.schema>;

/** Write modes for one asset type. */
export function writeModesFor(policy: Pick<PlansPolicy, "write">, assetType: string): WriteModes {
  return policy.write.types[assetType] ?? policy.write.default;
}
