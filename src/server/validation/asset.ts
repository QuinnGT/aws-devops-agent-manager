import { isDeepStrictEqual } from "node:util";
import { frontmatterKeyFix, frontmatterKeyLine, parseFrontmatter, yamlSentence } from "@/server/packages/frontmatter";
import { describePathProblem, pathProblem } from "@/server/packages/paths";
import { decodeText, lineCount } from "@/server/packages/text";
import { assetKeyOf, type DesiredAsset, type DesiredFile } from "@/server/packages/types";
import { writeZip } from "@/server/packages/zip";
import type { Policy } from "@/server/policy";
import type { AssetTypePolicy } from "@/server/policy/sections/asset-types";
import { describeSchemaErrors, metadataValidator, resolvedSchema, type SchemaKind } from "./schemas";
import { error, warning, type QuickFix, type ValidationResult } from "./types";

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

  out.push(...schemaResults(policy, asset, "metadataSchema", "error", "metadata.schema", assetKey).map((r) => (r.path === "metadata.name" ? nameResultExtras(policy, asset, r) : r)));
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

/** "roles/payment_gw" -> "roles/payment-gw": each segment in lowercase kebab case. */
export function kebabName(name: string): string {
  return name
    .split("/")
    .map((seg) =>
      seg
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean)
    .join("/");
}

/**
 * The line of a metadata.name result in the main file's frontmatter, and for
 * a memory (named by its path) the fix: the kebab-case name in the
 * frontmatter and the file renamed to match. Memory only, since only its
 * name and file path move together.
 */
function nameResultExtras(policy: ValidationPolicy, asset: DesiredAsset, r: ValidationResult): ValidationResult {
  const main = asset.files.length === 1 ? asset.files[0] : undefined;
  if (!main || main.encoding !== "utf8") return r;
  const line = frontmatterKeyLine(main.content, "name");
  const name = asset.metadata.name;
  if (asset.assetType !== "memory" || typeof name !== "string") return line ? { ...r, line } : r;
  const suggested = kebabName(name);
  const pattern = (policy.assetTypes.assetTypes.memory?.metadataSchema as { properties?: { name?: { pattern?: string } } } | undefined)?.properties?.name?.pattern;
  if (!suggested || suggested === name || (pattern && !new RegExp(pattern, "u").test(suggested))) return line ? { ...r, line } : r;
  const edits: QuickFix["edits"] = [...(frontmatterKeyFix(main.content, "name", suggested, "")?.edits ?? [])];
  const source = main.sourcePath;
  if (source?.endsWith(`${name}.md`)) edits.push({ kind: "rename", to: `${source.slice(0, -(name.length + 3))}${suggested}.md` });
  if (!edits.length) return line ? { ...r, line } : r;
  return { ...r, ...(line ? { line } : {}), fix: { label: `Rename to ${suggested}`, ...(source ? { from: source } : {}), edits } };
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
    // The service parses the frontmatter only where it reads metadata from it (a zip skill); elsewhere it is text the agent reads.
    const at = { assetKey, path, ...(fm.errorAt ? { line: fm.errorAt.line, column: fm.errorAt.column } : {}), ...(fm.fix ? { fix: fm.fix } : {}) };
    out.push(
      required
        ? error("frontmatter.invalid", `${yamlSentence(path, fm)} The service reads it for this upload.`, at)
        : warning("frontmatter.invalid", `${yamlSentence(path, fm)} The service doesn't read it for a single file, but a zip upload and other tools do.`, at),
    );
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
    if (!same) {
      const line = frontmatterKeyLine(text, fmKey);
      // Only where the metadata is what the service uses (not a zip skill, whose frontmatter it reads).
      const fix = required ? null : frontmatterKeyFix(text, fmKey, metaValue, `Use metadata.${metaKey} in the frontmatter`);
      const at = { assetKey, path, ...(line ? { line } : {}), ...(fix ? { fix } : {}) };
      out.push(rule.mirrorLevel === "error" ? error("frontmatter.mismatch", `${path} frontmatter ${fmKey} differs from metadata.${metaKey}.`, at) : warning("frontmatter.mismatch", `${path} frontmatter ${fmKey} differs from metadata.${metaKey}.`, at));
    }
  }
  return out;
}
