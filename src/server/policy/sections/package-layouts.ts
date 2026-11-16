import { z } from "zod";
import { defineSection } from "./define";

/**
 * Package layout mappings: how a package folder or
 * zip maps to assets (type, metadata, files), plus the shared-section copy
 * rules, build steps and checks used by the package tools. Layouts may
 * `extends` another layout; the section output holds fully resolved layouts.
 * policy/package-layouts.yaml documents each key.
 */
const fmMap = z.record(z.string(), z.string());

const sharedSection = z.object({
  name: z.string().min(1),
  /** Source file; {name} is replaced by the section name */
  source: z.string(),
  /** Files that embed the section between the markers */
  targets: z.array(z.string()).min(1),
  /** Begin and end markers; {name} is replaced by the section name */
  begin: z.string().min(1),
  end: z.string().min(1),
});

const textPattern = z.object({
  code: z.string(),
  dirs: z.array(z.string()).min(1),
  glob: z.string().default("**/*.md"),
  pattern: z.string().refine(isRegExp, "must be a valid regular expression"),
  flags: z.string().default(""),
  message: z.string(),
});

const textRule = z
  .object({
    code: z.string(),
    /** Package path of the file to check */
    file: z.string().optional(),
    /**
     * Instead of `file`: the main file of the asset folder (assetFolders)
     * whose descriptor has this type and these metadata values
     */
    asset: z.object({ assetType: z.string(), metadata: z.record(z.string(), z.unknown()).default({}) }).optional(),
    /** A missing file or asset: an error (default), or nothing to check */
    missing: z.enum(["error", "skip"]).default("error"),
    texts: z.array(z.string()).min(1),
    message: z.string(),
  })
  .refine((r) => (r.file === undefined) !== (r.asset === undefined), "give either file or asset");

/** One asset type in an Agent Space folder layout (assetFolders.types). */
const assetFolderType = z.object({
  /** Package folder holding one folder per asset of this type */
  dir: z.string().min(1),
  /** The asset's main file inside its folder; {name} is metadata.name, {folder} the folder name */
  mainFile: z.string().min(1),
  /** Export: the asset folder's name. {name} metadata.name, {agentFolder} from agentFolders, {assetId} */
  folder: z.string().min(1).default("{name}"),
});

const assetFolders = z.object({
  /** Descriptor file in each asset folder: assetId, assetType, metadata */
  descriptor: z.string().min(1).default("_asset.json"),
  /** Package-root file listing the asset folders (checked, never uploaded); null: none */
  index: z.string().nullable().default(null),
  /** Globs, relative to an asset folder, of files that are never uploaded (besides the descriptor) */
  neverUpload: z.array(z.string()).default([]),
  /** Top-level descriptor keys that are service bookkeeping (dropped) */
  dropKeys: z.array(z.string()).default([]),
  /** Asset type -> its type folder and main file */
  types: z.record(z.string(), assetFolderType),
  /** Agent type ID -> export folder name of its instructions ({agentFolder}) */
  agentFolders: z.record(z.string(), z.string()).default({}),
  /** Export folder for a second asset with the same folder name; {folder} {assetId} */
  duplicateFolder: z.string().min(1).default("{folder}__{assetId}"),
});

export type AssetFoldersRule = z.output<typeof assetFolders>;

const fileRule = z.object({
  code: z.string(),
  files: z.array(z.string()).min(1),
  /** {file} is replaced by the missing path */
  message: z.string(),
  /** "warning": the files are optional, so a missing one is reported without failing the package */
  level: z.enum(["error", "warning"]).default("error"),
});

export const packageLayout = z.object({
  label: z.string(),
  description: z.string().optional(),
  /** Read a zip from inside its only top-level folder */
  stripSingleTopDir: z.boolean().default(true),
  /** Globs skipped when reading (still checked for path safety) */
  ignore: z.array(z.string()).default([]),
  /** Globs of package files that are not assets */
  nonAssets: z.array(z.string()).default([]),
  /** Agent type ID -> the name this layout writes for it */
  agentTypeNames: z.record(z.string(), z.string()).default({}),
  /** JSON file with metadata the files can't carry; null: none */
  manifest: z.string().nullable().default(null),
  /** Metadata values the manifest leaves out because they are the service default */
  manifestDefaults: z.record(z.string(), z.unknown()).default({}),
  instructions: z
    .object({
      dir: z.string(),
      /** File name -> agent_type, or null for files with no documented agent_type */
      files: z.record(z.string(), z.string().nullable()),
    })
    .nullable()
    .default(null),
  skills: z
    .object({
      dir: z.string(),
      mainFile: z.string().default("SKILL.md"),
      /** Built zip next to the folder, {name} = folder name; null: none */
      archive: z.string().nullable().default(null),
      frontmatter: fmMap.default({ name: "name", description: "description" }),
      agentTypes: z
        .object({
          default: z.array(z.string()).default([]),
          bySkill: z.record(z.string(), z.array(z.string())).default({}),
        })
        .default({ default: [], bySkill: {} }),
    })
    .nullable()
    .default(null),
  memory: z
    .object({
      dir: z.string(),
      storeFile: z.string(),
      indexFile: z.string().nullable().default(null),
      storeFrontmatter: fmMap,
      memoryFrontmatter: fmMap,
      storeContentFile: z.string(),
      memoryFile: z.string().default("{basename}.md"),
      index: z
        .object({
          header: z.array(z.string()),
          line: z.string(),
          descriptionKey: z.string().default("description"),
        })
        .nullable()
        .default(null),
    })
    .nullable()
    .default(null),
  customAgents: z
    .object({
      dir: z.string(),
      mainFile: z.string().default("AGENT.md"),
      frontmatter: fmMap.default({ name: "name", tools: "tools" }),
      /** Reference name (asset-types.yaml `ref`) -> frontmatter key holding names */
      refs: fmMap.default({ skills: "skills", memoryStores: "memory_stores" }),
    })
    .nullable()
    .default(null),
  sharedSections: z.array(sharedSection).default([]),
  /** One folder per asset with a descriptor (the Agent Space export); null: not this kind of layout */
  assetFolders: assetFolders.nullable().default(null),
  /**
   * Several package assets with one identity. In the space they came from
   * (every source asset ID is live there) each updates its own asset; in any
   * other space the one whose metadata matches `keep` is planned (`defaults`
   * fill keys the asset leaves out) and the others are left out.
   */
  duplicates: z
    .object({
      keep: z.record(z.string(), z.unknown()).default({ status: "ACTIVE" }),
      defaults: z.record(z.string(), z.unknown()).default({ status: "ACTIVE" }),
    })
    .default({ keep: { status: "ACTIVE" }, defaults: { status: "ACTIVE" } }),
  build: z
    .object({
      skillArchives: z.boolean().default(true),
      memoryIndexes: z.boolean().default(true),
      /** Where the build writes the validation summary; null: not written */
      validationResult: z.string().nullable().default(null),
      /** Name of the whole-package zip; {package} = package name; null: none */
      packageZip: z.string().nullable().default("{package}.zip"),
    })
    .default({ skillArchives: true, memoryIndexes: true, validationResult: null, packageZip: "{package}.zip" }),
  checks: z
    .object({
      requireArchives: z.boolean().default(false),
      skillNamePattern: z.string().refine(isRegExp, "must be a valid regular expression").default("^[a-z0-9-]{1,64}$"),
      memoryMaxBytes: z.number().int().positive().nullable().default(null),
      indexMaxBytes: z.number().int().positive().nullable().default(null),
      requireMemory: z.boolean().default(false),
      textPatterns: z.array(textPattern).default([]),
      requiredText: z.array(textRule).default([]),
      forbiddenText: z.array(textRule).default([]),
      requiredFiles: z.array(fileRule).default([]),
      scope: z.string().default("Offline package checks only."),
    })
    .default({
      requireArchives: false,
      skillNamePattern: "^[a-z0-9-]{1,64}$",
      memoryMaxBytes: null,
      indexMaxBytes: null,
      requireMemory: false,
      textPatterns: [],
      requiredText: [],
      forbiddenText: [],
      requiredFiles: [],
      scope: "Offline package checks only.",
    }),
});

export type PackageLayout = z.output<typeof packageLayout> & { name: string };

const rawLayout = z.record(z.string(), z.unknown());

export const packageLayoutsSection = defineSection(
  "package-layouts.yaml",
  z
    .object({
      layouts: z.record(z.string(), rawLayout).default({}),
      defaultLayout: z.string().optional(),
    })
    .transform((value, ctx) => {
      const resolved: Record<string, PackageLayout> = {};
      for (const name of Object.keys(value.layouts)) {
        const chain: string[] = [];
        let merged: unknown = {};
        let current: string | undefined = name;
        const stack: Record<string, unknown>[] = [];
        while (current) {
          if (chain.includes(current)) {
            ctx.addIssue({ code: "custom", path: ["layouts", name, "extends"], message: `extends cycle: ${[...chain, current].join(" -> ")}` });
            return z.NEVER;
          }
          chain.push(current);
          const raw: Record<string, unknown> | undefined = value.layouts[current];
          if (!raw) {
            ctx.addIssue({ code: "custom", path: ["layouts", name, "extends"], message: `unknown layout ${current}` });
            return z.NEVER;
          }
          stack.unshift(raw);
          current = typeof raw.extends === "string" ? raw.extends : undefined;
        }
        for (const layer of stack) {
          const { extends: _extends, ...rest } = layer;
          merged = deepMerge(merged, rest);
        }
        const parsed = packageLayout.safeParse(merged);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            ctx.addIssue({ code: "custom", path: ["layouts", name, ...issue.path.map(String)], message: issue.message });
          }
          continue;
        }
        resolved[name] = { ...parsed.data, name };
      }
      if (value.defaultLayout && !value.layouts[value.defaultLayout]) {
        ctx.addIssue({ code: "custom", path: ["defaultLayout"], message: `unknown layout ${value.defaultLayout}` });
      }
      return { layouts: resolved, defaultLayout: value.defaultLayout };
    }),
);

function isRegExp(s: string): boolean {
  try {
    new RegExp(s, "u");
    return true;
  } catch {
    return false;
  }
}

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);

/** Same rule as the policy loader's overlay merge: objects merge, arrays and scalars replace. */
function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (isPlain(base) && isPlain(over)) {
    const out: Plain = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
    return out;
  }
  return over;
}
