import { assetLabel } from "@/server/history/display-name";
import type { ImportDetail, ImportItemGroup } from "@/server/package-io";
import type { PlanTypeOption } from "@/server/package-io/loaders";
import type { Policy } from "@/server/policy";
import type { ValidationResult } from "@/server/validation/types";

/**
 * Pure shaping of an import's stored results for the mapping result page
 * (pages/package-import.md, "Mapping result"). Every string here comes from
 * the upload or the engine and is rendered as plain text.
 */

export type RowChange =
  | { word: "create" }
  | { word: "update"; from: number | null; added: number | null; removed: number | null; metadataKeys: string[]; contentChanged: boolean; committed: boolean }
  | { word: "unchanged" }
  | { word: "not-imported" }
  /** A package asset left out of the plan (a duplicate name), with the reason */
  | { word: "left-out"; reason: string };

export interface TypeRow {
  key: string;
  /** Path relative to the type's folder ("global.md", "rds-failover/", "verity/overview.md") */
  file: string;
  /** Identity key in bold (GENERIC, a skill name, "<store>/<memory>"); null for files that aren't imported */
  asset: string | null;
  assetId: string | null;
  change: RowChange;
  /** Bytes of the asset's files, or of the file that isn't imported */
  size: number | null;
  /** Line count, for instructions */
  lines: number | null;
  results: ValidationResult[];
}

const allResults = (d: Pick<ImportDetail, "validation">) => [...d.validation.errors, ...d.validation.warnings];

function under(dir: string | undefined, p: string): boolean {
  return !!dir && p.startsWith(`${dir}/`);
}

/** The path relative to `dir` when it is inside it. */
export function relativeTo(dir: string | undefined, p: string): string {
  return under(dir, p) ? p.slice(dir!.length + 1) : p;
}

/** The asset type whose layout folder holds a package path (first match in type order), or null. */
export function typeForPath(typeDirs: Record<string, string>, p: string): string | null {
  for (const [type, dir] of Object.entries(typeDirs)) if (under(dir, p)) return type;
  return null;
}

/** Files under a type's folder that were not imported (skipped or unmapped). */
function notImportedFiles(d: Pick<ImportDetail, "files" | "layout">, assetType: string) {
  const dirs = d.layout?.typeDirs ?? {};
  return d.files.filter((g) => g.role === "skipped" || g.role === "unmapped").flatMap((g) => g.files.filter((f) => typeForPath(dirs, f.path) === assetType));
}

/** Validation results about a type: its assets' results, plus results about files under its folder that name no asset. */
export function typeResults(d: Pick<ImportDetail, "validation" | "layout">, assetType: string): ValidationResult[] {
  const dirs = d.layout?.typeDirs ?? {};
  return allResults(d).filter((r) => (r.assetKey ? r.assetKey.startsWith(`${assetType}:`) : !!r.path && typeForPath(dirs, r.path) === assetType));
}

/** One row per asset of the type, then one per asset left out, then one per file under its folder that isn't imported. */
export function typeRows(d: Pick<ImportDetail, "validation" | "layout" | "files"> & Partial<Pick<ImportDetail, "leftOut">>, group: ImportItemGroup): TypeRow[] {
  const dir = d.layout?.typeDirs[group.assetType];
  const results = allResults(d);
  const rows: TypeRow[] = group.items.map((item) => {
    const source = item.source ?? item.key;
    const folder = item.files.length > 1 || item.files.some((f) => f.sourcePath && f.sourcePath !== source);
    const file = relativeTo(dir, source) + (folder && !source.endsWith(".zip") ? "/" : "");
    const change: RowChange =
      item.action === "create"
        ? { word: "create" }
        : item.action === "unchanged"
          ? { word: "unchanged" }
          : {
              word: "update",
              from: item.liveVersion,
              added: item.diffStat?.added ?? null,
              removed: item.diffStat?.removed ?? null,
              metadataKeys: item.changes?.metadataKeys ?? [],
              contentChanged: item.changes?.content ?? true,
              committed: item.changes?.committed ?? false,
            };
    return {
      key: item.assetKey,
      file,
      asset: item.key,
      assetId: item.assetId,
      change,
      size: item.files.reduce((n, f) => n + f.size, 0),
      lines: item.assetType === "agents_md" ? (item.files[0]?.lines ?? null) : null,
      results: results.filter((r) => r.assetKey === item.assetKey),
    };
  });
  for (const l of d.leftOut ?? []) {
    if (l.assetType !== group.assetType || l.reason === "type-not-selected") continue;
    const source = l.source ?? l.key;
    rows.push({
      key: `left-out:${l.assetKey}`,
      file: `${relativeTo(dir, source)}/`,
      asset: l.key,
      assetId: null,
      change: { word: "left-out", reason: l.message },
      size: null,
      lines: null,
      results: results.filter((r) => r.assetKey === l.assetKey),
    });
  }
  for (const f of notImportedFiles(d, group.assetType)) {
    rows.push({ key: `file:${f.path}`, file: relativeTo(dir, f.path), asset: null, assetId: null, change: { word: "not-imported" }, size: f.size, lines: null, results: results.filter((r) => r.path === f.path && !r.assetKey) });
  }
  return rows;
}

/** Package files behind a type's rows: its assets' source files plus the files that aren't imported. */
export function typeFileCount(d: Pick<ImportDetail, "files" | "layout">, group: ImportItemGroup): number {
  const keys = new Set(group.items.map((i) => i.assetKey));
  const assetFiles = d.files.filter((g) => g.role === "asset").flatMap((g) => g.files).filter((f) => f.assetKey && keys.has(f.assetKey)).length;
  return assetFiles + notImportedFiles(d, group.assetType).length;
}

/**
 * The non-asset files as the layout names them: "README.md", "evaluation/",
 * and the folder of anything no pattern names ("instructions/shared/").
 */
export function nonAssetSummary(paths: readonly string[], patterns: readonly string[]): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  for (const p of paths) {
    const pattern = patterns.find((pat) => (pat.endsWith("/**") ? p.startsWith(pat.slice(0, -2)) : pat === p));
    if (pattern) add(pattern.endsWith("/**") ? pattern.slice(0, -2) : pattern);
    else add(p.includes("/") ? `${p.slice(0, p.lastIndexOf("/"))}/` : p);
  }
  return out;
}

/** "5 instruction files, 16 skills, 5 memory stores, 22 memories". */
export function breakdown(counts: readonly { assetType: string; count: number }[], noun: (assetType: string, n: number) => string): string {
  return counts
    .filter((c) => c.count > 0)
    .map((c) => `${c.count} ${noun(c.assetType, c.count)}`)
    .join(", ");
}

/** A validation result's message with the asset key in front ("INCIDENT_RCA: AGENTS.md has 193 lines; ..."). */
export function withAssetKey(r: ValidationResult): ValidationResult {
  if (!r.assetKey) return r;
  const key = r.assetKey.slice(r.assetKey.indexOf(":") + 1);
  return key && !r.message.startsWith(`${key}:`) ? { ...r, message: `${key}: ${r.message}` } : r;
}

type MessagePolicy = Pick<Policy, "agentTypes" | "assetTypes"> & Partial<Pick<Policy, "historyLayout">>;

const ASSET_ID = /\bki-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g;

/** "pr-change-analyzer", "Chat instructions": the asset a result is about, as the page names it; the package's "@<asset ID>" suffix dropped. */
export function resultAssetName(policy: MessagePolicy, assetKey: string): string {
  const i = assetKey.indexOf(":");
  const assetType = assetKey.slice(0, i);
  const key = assetKey.slice(i + 1).replace(/@ki-[0-9a-f-]+$/, "");
  return assetLabel(policy, { assetType, name: key });
}

/** One validation result of an import, in plain words, with the original message, code and path for a "Details" disclosure. */
export interface PlainResult {
  level: ValidationResult["level"];
  text: string;
  /** The engine's own message (with IDs), the rule code and the path, for support */
  details: string;
}

/**
 * A result as a reader of the import page needs it:
 * a reference to an asset that isn't anywhere ("pr-change-analyzer uses a
 * memory store that isn't in this package or this space"), the asset named
 * by its label (Chat instructions, not CHAT), and asset IDs out of the
 * sentence. The engine's message, the ID and the code go in Details. Pure.
 */
export function plainResult(policy: MessagePolicy, r: ValidationResult): PlainResult {
  const details = [r.message, [r.code, r.path].filter(Boolean).join(" · ")].join(" ");
  const assetType = r.assetKey ? r.assetKey.slice(0, r.assetKey.indexOf(":")) : null;
  const name = r.assetKey ? resultAssetName(policy, r.assetKey) : null;
  if (r.code === "reference.not-in-package" && name && assetType) {
    const refKey = r.path?.startsWith("metadata.") ? r.path.slice("metadata.".length) : null;
    const rule = policy.assetTypes.assetTypes[assetType]?.references.find((x) => x.key === refKey);
    const target = rule ? (policy.assetTypes.assetTypes[rule.assetType]?.noun?.one ?? policy.assetTypes.assetTypes[rule.assetType]?.label.toLowerCase() ?? rule.assetType) : "an asset";
    const article = rule ? (/^[aeiou]/i.test(target) ? "an " : "a ") : "";
    const after = r.level === "error" ? "" : " The plan leaves this reference out.";
    return { level: r.level, text: `${name} uses ${article}${target} that isn't in this package or this space.${after}`, details };
  }
  // The key in front of the message, as a label; the package's own key prefix ("CHAT: ") and asset IDs left out.
  const key = r.assetKey ? r.assetKey.slice(r.assetKey.indexOf(":") + 1) : null;
  let body = r.message;
  if (key && body.startsWith(`${key}:`)) body = body.slice(key.length + 1).trimStart();
  body = body.replace(/@ki-[0-9a-f-]{36}/g, "").replace(ASSET_ID, "an asset ID (see Details)");
  const text = name ? `${name}: ${body}` : body;
  return { level: r.level, text, details };
}

/**
 * Why "Create plan" is off for this selection of asset types, or null:
 * nothing selected, validation errors about the whole package or about a
 * selected type (while the policy blocks on errors), or no changes in the
 * selected types.
 */
export function selectionBlocker(args: { types: readonly PlanTypeOption[]; selected: readonly string[]; unattributedErrors: number; blockOnErrors: boolean }): string | null {
  const chosen = args.types.filter((t) => args.selected.includes(t.assetType));
  if (chosen.length === 0) return "Choose at least one asset type.";
  if (args.blockOnErrors) {
    if (args.unattributedErrors > 0) return `The package has ${args.unattributedErrors} validation ${args.unattributedErrors === 1 ? "error" : "errors"} that no asset type explains. Fix the package and upload it again.`;
    const failing = chosen.filter((t) => t.errors > 0);
    if (failing.length) {
      const names = failing.map((t) => t.label.toLowerCase());
      const list = names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
      return `Validation failed for ${list}. Leave ${failing.length === 1 ? "that type" : "those types"} out, or fix the package and upload it again.`;
    }
  }
  if (chosen.every((t) => t.changes === 0)) return "Nothing to import: every selected asset matches live.";
  return null;
}

/** One problem shown under an asset's row: the plain sentence once, how many results say it, and each engine message for Details. */
export interface RowNote {
  level: ValidationResult["level"];
  text: string;
  count: number;
  details: string[];
  /** The file line, when the check knows it and the sentence doesn't say it */
  line?: number;
  /** A one-click fix waits in a revision (the result carries a fix) */
  fixable?: boolean;
}

/** Results a left-out row already explains in its Change cell. */
const LEFT_OUT_CODES = new Set(["import.duplicate-left-out", "import.cannot-create-left-out"]);

/**
 * The problems of a row of the type table, errors first, identical sentences
 * once with a count. `underRow` leaves out what a left-out row's Change cell
 * already says, and the asset's name the row already shows. Pure.
 */
export function rowNotes(policy: MessagePolicy, row: Pick<TypeRow, "results" | "change">, opts: { underRow?: boolean } = {}): RowNote[] {
  const notes = new Map<string, RowNote>();
  for (const r of row.results) {
    if (opts.underRow && row.change.word === "left-out" && LEFT_OUT_CODES.has(r.code)) continue;
    const p = plainResult(policy, r);
    if (opts.underRow && r.assetKey) p.text = withoutName(p.text, resultAssetName(policy, r.assetKey));
    const k = `${p.level}\0${p.text}`;
    const n = notes.get(k);
    const line = r.line && !p.text.includes(`line ${r.line}`) ? r.line : undefined;
    if (n) {
      n.count++;
      n.details.push(p.details);
      if (r.fix) n.fixable = true;
    } else notes.set(k, { level: p.level, text: p.text, count: 1, details: [p.details], ...(line ? { line } : {}), ...(r.fix ? { fixable: true } : {}) });
  }
  const all = [...notes.values()];
  return [...all.filter((n) => n.level === "error"), ...all.filter((n) => n.level !== "error")];
}

/** "Chat instructions: AGENTS.md has 325 lines" -> "AGENTS.md has 325 lines"; "x uses a store" -> "Uses a store". */
function withoutName(text: string, name: string): string {
  if (text.startsWith(`${name}: `)) return text.slice(name.length + 2);
  if (!text.startsWith(`${name} `)) return text;
  const rest = text.slice(name.length + 1);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** The page's anchor for a row of the type table. */
export function rowAnchor(key: string): string {
  return `row-${key.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}

/** An asset (a row of the type table) with problems, for the side list: where its row is and how many errors and warnings it has. */
export interface AssetProblems {
  assetType: string;
  rowKey: string;
  /** The row's place in its type's table, to show enough rows */
  index: number;
  name: string;
  errors: number;
  warnings: number;
}

/**
 * The import's problems by asset, for the side list: every row of every type
 * table with results (assets with errors first, then by type order as the
 * groups come), and the results no row holds (about the whole package). Pure.
 */
export function problemsByAsset(
  policy: MessagePolicy,
  d: Pick<ImportDetail, "validation" | "layout" | "files" | "groups"> & Partial<Pick<ImportDetail, "leftOut">>,
): { assets: AssetProblems[]; other: ValidationResult[] } {
  const placed = new Set<ValidationResult>();
  const assets: AssetProblems[] = [];
  for (const g of d.groups) {
    typeRows(d, g).forEach((row, index) => {
      const notes = rowNotes(policy, row);
      for (const r of row.results) placed.add(r);
      if (!notes.length) return;
      const count = (level: ValidationResult["level"]) => notes.filter((n) => n.level === level).reduce((s, n) => s + n.count, 0);
      // A left-out row is named by its package folder, which tells it apart from the asset that shares its name.
      const name = row.change.word === "left-out" || row.asset === null ? row.file.replace(/\/$/, "") : assetLabel(policy, { assetType: g.assetType, name: row.asset });
      assets.push({ assetType: g.assetType, rowKey: row.key, index, name, errors: count("error"), warnings: count("warning") });
    });
  }
  const other = allResults(d).filter((r) => !placed.has(r));
  return { assets: [...assets.filter((a) => a.errors > 0), ...assets.filter((a) => a.errors === 0)], other };
}
