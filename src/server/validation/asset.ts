import { isDeepStrictEqual } from "node:util";
import { parseFrontmatter } from "@/server/packages/frontmatter";
import { describePathProblem, pathProblem } from "@/server/packages/paths";
import { decodeText, lineCount } from "@/server/packages/text";
import { assetKeyOf, type DesiredAsset, type DesiredFile } from "@/server/packages/types";
import { writeZip } from "@/server/packages/zip";
import type { Policy } from "@/server/policy";
import type { AssetTypePolicy } from "@/server/policy/sections/asset-types";
import { describeSchemaErrors, metadataValidator, resolvedSchema, type SchemaKind } from "./schemas";
import { error, warning, type ValidationResult } from "./types";

/**
 * Validate one draft asset (type, metadata, files) against asset-types.yaml
 * and limits.yaml. Pure; no AWS calls. Set-level rules (unique names,
 * references, counts) are in validateAssetSet.
 */

export type ValidationPolicy = Pick<Policy, "assetTypes" | "agentTypes" | "limits">;

export interface DraftContext {
  policy: ValidationPolicy;
  /** The live asset's current metadata, for immutable-key checks on updates */
  previous?: { metadata: Record<string, unknown> };
}

/**
 * The name a message gives a file: the package file it came from
 * ("incident-rca.md" for instructions/incident-rca.md), else its path in the
 * asset ("AGENTS.md" for a draft). The result's `path` stays the asset path.
 */
export function fileLabel(f: Pick<DesiredFile, "path" | "sourcePath">): string {
  if (!f.sourcePath) return f.path;
  const i = f.sourcePath.lastIndexOf("/");
  return i >= 0 ? f.sourcePath.slice(i + 1) : f.sourcePath;
}

export function validateDraftAsset(asset: DesiredAsset, ctx: DraftContext): ValidationResult[] {
  const { policy } = ctx;
  const assetKey = assetKeyOf(asset);
  const out: ValidationResult[] = [];
  const entry = policy.assetTypes.assetTypes[asset.assetType];
  if (!entry) {
    out.push(error("type.unknown", `Asset type ${asset.assetType} has no entry in asset-types.yaml, so it can't be validated.`, { assetKey }));
    return out;
  }
  if (!entry.editable) out.push(error("type.not-editable", `${entry.label} assets can't be edited in this app.`, { assetKey }));

  out.push(...schemaResults(policy, asset, "metadataSchema", "error", "metadata.schema", assetKey));
  out.push(...schemaResults(policy, asset, "metadataWarningSchema", "warning", "metadata.recommendation", assetKey));
  if (!asset.assetId) out.push(...schemaResults(policy, asset, "createSchema", "error", "metadata.create", assetKey));
  out.push(...unknownKeyResults(entry, asset, assetKey));

  if (ctx.previous) {
    for (const key of entry.immutableKeys) {
      const before = ctx.previous.metadata[key];
      if (before !== undefined && !isDeepStrictEqual(before, asset.metadata[key])) {
        out.push(error("metadata.immutable", `${key} can't change after the asset is created.`, { assetKey, path: `metadata.${key}` }));
      }
    }
  }

  const extraPattern = policy.limits.namePatterns[asset.assetType];
  const name = asset.metadata.name;
  if (extraPattern && typeof name === "string" && !new RegExp(extraPattern, "u").test(name)) {
    out.push(error("name.policy-pattern", `metadata.name must match this space's naming rule ${extraPattern}.`, { assetKey, path: "metadata.name" }));
  }

  out.push(...fileResults(policy, entry, asset, assetKey));
  return out;
}

/**
 * Metadata keys the type's schema doesn't list. The service drops them without
 * an error (tested on a test space on 2026-11-13: probe_note sent with
 * CreateAsset on a skill was not stored), so apply's read-back would fail.
 * Types whose schema lists no properties are not checked.
 */
function unknownKeyResults(entry: AssetTypePolicy, asset: DesiredAsset, assetKey: string): ValidationResult[] {
  const props = (entry.metadataSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!props || Object.keys(props).length === 0) return [];
  return Object.keys(asset.metadata)
    .filter((k) => asset.metadata[k] !== undefined && !Object.hasOwn(props, k))
    .map((k) =>
      error("metadata.unknown-key", `The service doesn't keep metadata.${k} on this asset type, so it would be dropped when the change is applied. Remove it.`, {
        assetKey,
        path: `metadata.${k}`,
      }),
    );
}

function schemaResults(
  policy: ValidationPolicy,
  asset: DesiredAsset,
  kind: SchemaKind,
  level: "error" | "warning",
  code: string,
  assetKey: string,
): ValidationResult[] {
  const validate = metadataValidator(policy, asset.assetType, kind);
  if (!validate || validate(asset.metadata)) return [];
  const root = resolvedSchema(policy, asset.assetType, kind)!;
  return describeSchemaErrors(validate.errors, root).map((i) => {
    const path = i.path ? `metadata.${i.path}` : "metadata";
    const message = i.message.startsWith(i.path) && i.path ? `metadata.${i.message}` : i.message;
    return level === "error" ? error(code, message, { assetKey, path }) : warning(code, message, { assetKey, path });
  });
}

function fileBytes(f: DesiredFile): Buffer | null {
  if (f.encoding === "utf8") return Buffer.from(f.content, "utf8");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(f.content) || f.content.length % 4 !== 0) return null;
  return Buffer.from(f.content, "base64");
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n % (1024 * 1024) ? 1 : 0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(n % 1024 ? 1 : 0)} KB`;
  return `${n} bytes`;
}

/** The asset's main file: mainFile when present, else its only file. */
export function mainFileOf(entry: Pick<AssetTypePolicy, "mainFile">, files: readonly DesiredFile[]): DesiredFile | undefined {
  return (entry.mainFile ? files.find((f) => f.path === entry.mainFile) : undefined) ?? (files.length === 1 ? files[0] : undefined);
}

function fileResults(policy: ValidationPolicy, entry: AssetTypePolicy, asset: DesiredAsset, assetKey: string): ValidationResult[] {
  const out: ValidationResult[] = [];
  const { limits } = policy;
  const files = asset.files;
  if (!files.length) {
    out.push(error("content.missing", "The asset needs content: add at least one file.", { assetKey }));
    return out;
  }
  const seen = new Set<string>();
  const bytes = new Map<string, Buffer>();
  for (const f of files) {
    const problem = pathProblem(f.path);
    if (problem) {
      out.push(error("file.unsafe-path", `File path ${JSON.stringify(f.path)} ${describePathProblem(problem)}.`, { assetKey, path: f.path }));
      continue;
    }
    if (seen.has(f.path)) out.push(error("file.duplicate-path", `${f.path} appears more than once.`, { assetKey, path: f.path }));
    seen.add(f.path);
    const b = fileBytes(f);
    if (!b) out.push(error("file.encoding", `${f.path} is not valid base64.`, { assetKey, path: f.path }));
    else bytes.set(f.path, b);
  }

  if (entry.content !== "multi-file" && files.length > 1) {
    out.push(error("content.too-many-files", `${entry.label} assets hold one file; this one has ${files.length}.`, { assetKey }));
  }
  if (entry.mainFileRequired && entry.mainFile && !files.some((f) => f.path === entry.mainFile)) {
    out.push(error("file.main-missing", `${entry.label} assets need a ${entry.mainFile} file.`, { assetKey, path: entry.mainFile }));
  }

  const main = mainFileOf(entry, files);
  const mainBytes = main ? bytes.get(main.path) : undefined;
  const mainText = main && mainBytes ? (main.encoding === "utf8" ? main.content : decodeText(mainBytes)) : null;
  const mainName = main ? fileLabel(main) : "";
  if (main && mainBytes && entry.content !== "binary" && mainText === null) {
    out.push(error("file.not-text", `${mainName} must be UTF-8 text.`, { assetKey, path: main.path }));
  }

  // Upload size: one file goes inline (text or bytes); several go as a zip.
  if (files.length === 1 && main && mainBytes) {
    const isText = main.encoding === "utf8" && entry.content !== "binary";
    const max = isText ? limits.singleTextFileMaxBytes : limits.binaryFileMaxBytes;
    if (mainBytes.length > max) {
      out.push(error("file.too-large", `${mainName} is ${formatBytes(mainBytes.length)}; a single ${isText ? "text" : "binary"} file can be at most ${formatBytes(max)}.`, { assetKey, path: main.path }));
    }
  } else if (files.length > 1 && bytes.size === files.length) {
    const zipBytes = writeZip(files.map((f) => ({ name: f.path, data: bytes.get(f.path)! }))).length;
    if (zipBytes > limits.zipMaxBytes) {
      out.push(error("zip.too-large", `The files zip to ${formatBytes(zipBytes)}; a zip upload can be at most ${formatBytes(limits.zipMaxBytes)}.`, { assetKey }));
    }
  }

  if (main && mainBytes) {
    const maxKey = entry.limits.mainFileMaxBytes;
    if (maxKey && mainBytes.length > limits[maxKey]) {
      out.push(error("file.too-large", `${mainName} is ${formatBytes(mainBytes.length)} (${mainBytes.length} bytes); the limit is ${formatBytes(limits[maxKey])} (${limits[maxKey]} bytes).`, { assetKey, path: main.path }));
    }
    const linesKey = entry.limits.mainFileRecommendedLines;
    if (linesKey && mainText !== null) {
      const n = lineCount(mainText);
      if (n > limits[linesKey]) {
        out.push(warning("file.long", `${mainName} has ${n} lines; about ${limits[linesKey]} lines is recommended.`, { assetKey, path: main.path }));
      }
    }
  }

  if (entry.frontmatter && main && mainText !== null) out.push(...frontmatterResults(entry, asset, main.path, mainText, assetKey));
  return out;
}

function frontmatterResults(entry: AssetTypePolicy, asset: DesiredAsset, path: string, text: string, assetKey: string): ValidationResult[] {
  const rule = entry.frontmatter!;
  const out: ValidationResult[] = [];
  const push = (level: "error" | "warning", code: string, message: string) =>
    out.push(level === "error" ? error(code, message, { assetKey, path }) : warning(code, message, { assetKey, path }));
  const fm = parseFrontmatter(text);
  const present = fm.data !== null || fm.error !== undefined;
  const required = rule.mode === "required" || (rule.mode === "required-for-zip" && asset.files.length > 1);

  if (rule.mode === "forbidden") {
    if (present) push(rule.level, "frontmatter.present", `${path} starts with a frontmatter block; ${entry.label} files are plain markdown, so the agent reads it as text.`);
    return out;
  }
  if (fm.error) {
    push("error", "frontmatter.invalid", `${path} has frontmatter that is not valid YAML: ${fm.error}`);
    return out;
  }
  if (!fm.data) {
    if (required) push(rule.level, "frontmatter.missing", `${path} needs a frontmatter block with ${Object.keys(rule.mirror).join(" and ") || "metadata"}.`);
    return out;
  }
  for (const [fmKey, metaKey] of Object.entries(rule.mirror)) {
    const fmValue = fm.data[fmKey];
    const metaValue = asset.metadata[metaKey];
    if (fmValue === undefined || fmValue === null || fmValue === "") {
      if (required) push("error", "frontmatter.missing-key", `${path} frontmatter needs ${fmKey}${asset.files.length > 1 ? "; zip uploads read it from there" : ""}.`);
      continue;
    }
    if (metaValue === undefined) continue;
    const same = typeof fmValue === "string" && typeof metaValue === "string" ? fmValue.trim() === metaValue.trim() : isDeepStrictEqual(fmValue, metaValue);
    if (!same) push(rule.mirrorLevel, "frontmatter.mismatch", `${path} frontmatter ${fmKey} differs from metadata.${metaKey}.`);
  }
  return out;
}
