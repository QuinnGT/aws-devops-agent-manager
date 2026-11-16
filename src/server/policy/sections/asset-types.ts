import { z } from "zod";
import { assertCompilableSchema } from "@/server/validation/schemas";
import { defineSection } from "./define";
import { NUMERIC_LIMIT_KEYS } from "./limits";

/**
 * One entry per asset type: a JSON Schema for its
 * metadata (drives generated forms and validation), its content shape, UI
 * hints, and the rules the validation engine applies (identity, references,
 * counts, file limits, frontmatter). New asset types need an entry here, not
 * new code. policy/asset-types.yaml documents each key.
 */
const jsonSchema = z.record(z.string(), z.unknown());
const limitKey = z.enum(NUMERIC_LIMIT_KEYS);
const level = z.enum(["error", "warning"]);

const referenceRule = z.object({
  /** Metadata key holding the referenced asset ID (or IDs when `many`) */
  key: z.string(),
  /** Key in DesiredAsset.refs holding the referenced identity key(s), used before the IDs exist */
  ref: z.string(),
  /** Asset type of the referenced asset */
  assetType: z.string(),
  many: z.boolean().default(false),
  /** The asset must reference one (by ID or by name) */
  required: z.boolean().default(false),
});

const countRule = z.object({
  /** limits.yaml key with the maximum */
  limit: limitKey,
  /** Count per referenced asset (a `ref` name from `references`), for example per memory store */
  per: z.string().optional(),
  /** Metadata key -> values that are not counted (for example skill_type LEARNED) */
  exclude: z.record(z.string(), z.array(z.string())).default({}),
});

const frontmatterRule = z.object({
  mode: z.enum(["required", "required-for-zip", "optional", "forbidden"]).default("optional"),
  /** Level for a missing (required) or present (forbidden) frontmatter block */
  level: level.default("error"),
  /** Frontmatter key -> metadata key whose values must match */
  mirror: z.record(z.string(), z.string()).default({}),
  mirrorLevel: level.default("error"),
});

const assetTypeEntry = z.object({
  label: z.string(),
  /** Count noun for the UI ("1 instruction file", "4 skills"); defaults to the label in lower case */
  noun: z.object({ one: z.string().min(1), other: z.string().min(1) }).optional(),
  /** JSON Schema (draft 2020-12) for `metadata`; violations are errors */
  metadataSchema: jsonSchema,
  /** JSON Schema for recommendations; violations are warnings */
  metadataWarningSchema: jsonSchema.optional(),
  /** JSON Schema checked only when the asset is created */
  createSchema: jsonSchema.optional(),
  /** "single-file" | "multi-file" | "binary" */
  content: z.enum(["single-file", "multi-file", "binary"]).default("single-file"),
  /** Default main file path for single-file assets */
  mainFile: z.string().optional(),
  /** The asset must contain mainFile */
  mainFileRequired: z.boolean().default(false),
  /** Whether the Active switch applies (status ACTIVE/INACTIVE) */
  supportsStatus: z.boolean().default(false),
  /** Editable in v1 (false for managed or service-owned types) */
  editable: z.boolean().default(true),
  /** Names of service-managed assets of this type (labeled "Managed" in the UI; plans.yaml `managed` says what plans may change on them) */
  managedNames: z.array(z.string()).default([]),
  /** Identity template: metadata keys and reference names in braces, for example "{memoryStore}/{name}" */
  identity: z.string().optional(),
  /** Metadata keys that can't change after create */
  immutableKeys: z.array(z.string()).default([]),
  frontmatter: frontmatterRule.optional(),
  limits: z
    .object({
      mainFileMaxBytes: limitKey.optional(),
      mainFileRecommendedLines: limitKey.optional(),
    })
    .default({}),
  references: z.array(referenceRule).default([]),
  counts: z.array(countRule).default([]),
});

export type AssetTypePolicy = z.output<typeof assetTypeEntry>;

export const assetTypesSection = defineSection(
  "asset-types.yaml",
  z
    .object({
      assetTypes: z.record(z.string(), assetTypeEntry),
    })
    .superRefine((value, ctx) => {
      for (const [type, entry] of Object.entries(value.assetTypes)) {
        for (const kind of ["metadataSchema", "metadataWarningSchema", "createSchema"] as const) {
          const schema = entry[kind];
          if (!schema) continue;
          try {
            assertCompilableSchema(schema);
          } catch (e) {
            ctx.addIssue({ code: "custom", path: ["assetTypes", type, kind], message: `not a valid JSON Schema: ${(e as Error).message}` });
          }
        }
        const refNames = new Set(entry.references.map((r) => r.ref));
        for (const r of entry.references) {
          if (!value.assetTypes[r.assetType]) {
            ctx.addIssue({ code: "custom", path: ["assetTypes", type, "references"], message: `unknown asset type ${r.assetType}` });
          }
        }
        for (const c of entry.counts) {
          if (c.per && !refNames.has(c.per)) {
            ctx.addIssue({ code: "custom", path: ["assetTypes", type, "counts"], message: `counts.per ${c.per} is not a reference name` });
          }
        }
      }
    }),
);
