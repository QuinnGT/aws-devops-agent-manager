import { isDeepStrictEqual } from "node:util";
import { diffLines } from "diff";
import { assetContentHash, metadataHash } from "@/server/history/content-hash";
import { lineCount } from "@/server/packages/text";
import type { PlanItemInput } from "@/server/plans/contract";
import { checkPackage, type PackageCheck } from "@/server/packages/check";
import type { PackageLayout } from "@/server/packages/layout";
import { sortPaths } from "@/server/packages/paths";
import { assetKeyOf, type DesiredAsset, type DesiredFile, type LiveAssetRef, type PackageContents } from "@/server/packages/types";
import type { Policy } from "@/server/policy";
import { canonicalize, isUtf8Text, sha256Hex } from "@/server/sync/content";
import { computeIdentity, type IdentityLookup } from "@/server/validation/identity";
import type { ValidationResult } from "@/server/validation/types";
import { joinAnd } from "./format";
import { FILE_ROLES, type ImportFileEntry, type ImportItem, type ImportItemFile, type ImportResults, type ImportSummary, type LeftOutItem, type UntouchedAsset } from "./types";

/**
 * The mapping of a package against a space's current index. Pure: the
 * caller loads the index and the committed states (live-index.ts).
 *
 * Each package asset is matched to a live asset by identity (asset-types.yaml
 * `identity`: skill and store names, the agents_md agent type, "<store>/<memory
 * name>"). No match: create. A match whose content hash and metadata hash
 * equal the committed state: unchanged. Otherwise: update. Live assets the
 * package doesn't mention are listed and left alone; import never deletes.
 */

/** asset.json of an asset at the history repository's HEAD. */
export interface CommittedState {
  metadata: Record<string, unknown>;
  files: readonly { path: string; sha256: string }[];
}

/** One live asset from asset_index, with its committed state. */
export interface LiveIndexEntry {
  assetId: string;
  assetType: string;
  name: string;
  /** Live metadata from the asset index */
  metadata: Record<string, unknown>;
  liveVersion: number | null;
  /** Null when the history repository has no asset.json for it */
  committed: CommittedState | null;
  /** The asset's folder in the history repository, when it has one */
  gitPath?: string | null;
}

export interface AnalyzeInput {
  contents: PackageContents;
  layout: PackageLayout;
  policy: Policy;
  live: readonly LiveIndexEntry[];
  historyCommit?: string | null;
  now?: Date;
  /** Asset types to plan; null or undefined: every type the package maps */
  includeTypes?: readonly string[] | null;
}

export interface Analysis {
  check: PackageCheck;
  /** The desired asset of each item, same order as results.items; assetId set for updates */
  desired: DesiredAsset[];
  results: ImportResults;
  summary: ImportSummary;
}

export function analyzeImport(input: AnalyzeInput): Analysis {
  const { policy, layout, contents } = input;
  const live = input.live.filter((a) => policy.assetTypes.assetTypes[a.assetType]);
  const liveRefs: LiveAssetRef[] = input.live.map((a) => ({ assetId: a.assetId, assetType: a.assetType, metadata: a.metadata }));
  const check = checkPackage(contents, { policy, layout, live: liveRefs, includeTypes: input.includeTypes });

  const index = liveIdentityIndex(policy, live);
  const byId = new Map(live.map((a) => [a.assetId, a]));
  const matched = new Set<string>();
  const items: ImportItem[] = [];
  const desired: DesiredAsset[] = [];

  // A source asset ID live in the space (set as assetId by checkPackage) updates that asset; otherwise the identity decides.
  for (const d of check.target.assets) {
    const own = d.assetId ? byId.get(d.assetId) : undefined;
    const match = (own && own.assetType === d.assetType ? own : null) ?? index.get(`${d.assetType}\0${computeIdentity(policy, d) ?? d.key}`) ?? null;
    if (match) matched.add(match.assetId);
    const item = compareAsset(policy, d, match, index, own ? "asset-id" : match ? "identity" : undefined);
    items.push(item);
    desired.push(match ? { ...d, assetId: match.assetId } : withoutAssetId(d));
  }
  countItemResults(items, check.results);
  const leftOut: LeftOutItem[] = check.target.leftOut.map((l) => ({
    assetKey: assetKeyOf(l.asset),
    assetType: l.asset.assetType,
    key: l.asset.key,
    source: l.asset.source ?? null,
    sourceAssetId: l.asset.sourceAssetId ?? null,
    reason: l.reason,
    message: l.message,
    keptKey: l.keptKey ?? null,
  }));

  const files = fileEntries(check);
  const untouched: UntouchedAsset[] = input.live
    .filter((a) => !matched.has(a.assetId))
    .map((a) => ({ assetId: a.assetId, assetType: a.assetType, name: a.name }));
  const typeOrder = Object.keys(policy.assetTypes.assetTypes);
  const rank = (t: string) => (typeOrder.includes(t) ? typeOrder.indexOf(t) : typeOrder.length);
  untouched.sort((a, b) => rank(a.assetType) - rank(b.assetType) || a.name.localeCompare(b.name) || a.assetId.localeCompare(b.assetId));

  const results: ImportResults = {
    items,
    files,
    untouched,
    leftOut,
    validation: check.results,
    historyCommit: input.historyCommit ?? null,
    analyzedAt: (input.now ?? new Date()).toISOString(),
  };
  return { check, desired, results, summary: summarize(check, results, contents.name) };
}

/** Plan items for the create and update items of an analysis. Unchanged items are left out. */
export function planItemsFromAnalysis(a: Pick<Analysis, "desired" | "results"> & { check?: Pick<PackageCheck, "results"> }): PlanItemInput[] {
  const out: PlanItemInput[] = [];
  a.results.items.forEach((item, i) => {
    if (item.action === "unchanged") return;
    const d = a.desired[i]!;
    const from = item.matchedBy === "asset-id" && item.source ? `From the package folder ${item.source}, matched by its asset ID.` : item.source ? `From the package file ${item.source}.` : undefined;
    const note = [from, droppedReferencesNote(a.check?.results ?? [], item.assetKey)].filter(Boolean).join(" ");
    out.push({ desired: d, baseVersion: null, baseUpdatedAt: null, note: note || undefined });
  });
  return out;
}

/** "Leaves out 3 references in memory_stores that aren't in this package or this space.": the optional references targetPackageAssets dropped from this asset. */
export function droppedReferencesNote(results: readonly ValidationResult[], assetKey: string): string | null {
  const byKey = new Map<string, number>();
  for (const r of results) {
    if (r.code !== "reference.not-in-package" || r.level !== "warning" || r.assetKey !== assetKey) continue;
    const key = r.path?.replace(/^metadata\./, "") ?? "references";
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }
  if (!byKey.size) return null;
  const parts = [...byKey].map(([key, n]) => `${n} ${n === 1 ? "reference" : "references"} in ${key}`);
  return `Leaves out ${joinAnd(parts)} that ${byKey.size === 1 && [...byKey.values()][0] === 1 ? "isn't" : "aren't"} in this package or this space.`;
}

export function summarize(check: Pick<PackageCheck, "ok" | "results">, results: Pick<ImportResults, "items" | "files" | "untouched" | "leftOut">, packageName: string | null): ImportSummary {
  const roles = Object.fromEntries(FILE_ROLES.map((r) => [r, 0])) as ImportSummary["roles"];
  for (const f of results.files) roles[f.role] = (roles[f.role] ?? 0) + 1;
  const count = (action: ImportItem["action"]) => results.items.filter((i) => i.action === action).length;
  return {
    ok: check.ok,
    packageName,
    assets: results.items.length,
    counts: {
      create: count("create"),
      update: count("update"),
      unchanged: count("unchanged"),
      untouched: results.untouched.length,
      errors: check.results.filter((r) => r.level === "error").length,
      warnings: check.results.filter((r) => r.level === "warning").length,
      leftOut: results.leftOut?.length ?? 0,
    },
    roles,
  };
}

type IdentityIndex = Map<string, LiveIndexEntry>;

/** Live assets by `${assetType}\0${identity}`. Memory identities use their store's name. */
export function liveIdentityIndex(policy: Pick<Policy, "assetTypes">, live: readonly LiveIndexEntry[]): IdentityIndex {
  const byId = new Map(live.map((a) => [a.assetId, a]));
  const lookup: IdentityLookup = (assetType, id) => {
    const a = byId.get(id);
    return a && a.assetType === assetType ? (computeIdentity(policy, a) ?? undefined) : undefined;
  };
  const out: IdentityIndex = new Map();
  for (const a of live) {
    const identity = computeIdentity(policy, a, lookup);
    if (identity === null) continue;
    const k = `${a.assetType}\0${identity}`;
    if (!out.has(k)) out.set(k, a);
  }
  return out;
}

function compareAsset(policy: Policy, d: DesiredAsset, match: LiveIndexEntry | null, index: IdentityIndex, matchedBy: ImportItem["matchedBy"]): ImportItem {
  const files = d.files.map(fileEntry);
  const { metadata: resolved, unresolved } = resolveReferences(policy, d, index);
  const assetKey = assetKeyOf(d);
  const base: Omit<ImportItem, "action" | "contentHash" | "metadataHash" | "changes" | "assetId" | "liveVersion"> = {
    assetKey,
    assetType: d.assetType,
    key: d.key,
    source: d.source ?? null,
    metadata: d.metadata,
    ...(d.refs && Object.keys(d.refs).length ? { refs: d.refs } : {}),
    files,
    errors: 0,
    warnings: 0,
    ...(d.sourceAssetId ? { sourceAssetId: d.sourceAssetId } : {}),
    ...(matchedBy ? { matchedBy } : {}),
  };
  if (!match) {
    return { ...base, action: "create", assetId: null, liveVersion: null, contentHash: assetContentHash(files), metadataHash: metadataHash(resolved), changes: null };
  }
  const committed = match.committed;
  const effective = clean({ ...(committed?.metadata ?? match.metadata), ...resolved });
  const compareFiles = committed ? alignSingleFile(policy, d.assetType, files, committed.files) : files;
  const contentHash = assetContentHash(compareFiles);
  const metaHash = metadataHash(effective);
  const common = { ...base, assetId: match.assetId, liveVersion: match.liveVersion, contentHash, metadataHash: metaHash };
  if (!committed) return { ...common, action: "update", changes: { content: true, metadataKeys: [...unresolved].sort(), committed: false } };
  const content = contentHash !== assetContentHash(committed.files);
  const changed = metaHash === metadataHash(committed.metadata) ? [] : changedKeys(effective, committed.metadata);
  const metadataKeys = [...new Set([...changed, ...unresolved])].sort();
  if (!content && metadataKeys.length === 0) return { ...common, action: "unchanged", changes: null };
  return { ...common, action: "update", changes: { content, metadataKeys, committed: true } };
}

/**
 * The package's metadata with name references (refs.memoryStore,
 * refs.skills) replaced by the live asset IDs they name. A reference to an
 * asset the package creates has no ID yet: its key is reported as
 * unresolved, which makes the item an update.
 */
function resolveReferences(policy: Policy, d: DesiredAsset, index: IdentityIndex): { metadata: Record<string, unknown>; unresolved: string[] } {
  const out = clean({ ...d.metadata });
  const unresolved: string[] = [];
  const entry = policy.assetTypes.assetTypes[d.assetType];
  for (const rule of entry?.references ?? []) {
    const named = d.refs?.[rule.ref];
    if (named === undefined) continue;
    const names = Array.isArray(named) ? named : [named];
    const ids = names.map((n) => index.get(`${rule.assetType}\0${n}`)?.assetId);
    if (ids.some((id) => id === undefined)) {
      unresolved.push(rule.key);
      continue;
    }
    out[rule.key] = rule.many ? ids : ids[0];
  }
  return { metadata: out, unresolved };
}

/**
 * For single-file types the service names the file (a memory store's file is
 * "<store>.md" live but README.md in a package), so a lone file is compared
 * under the committed file's path.
 */
function alignSingleFile(policy: Policy, assetType: string, files: ImportItemFile[], committed: readonly { path: string }[]): ImportItemFile[] {
  const content = policy.assetTypes.assetTypes[assetType]?.content;
  if (content !== "single-file" || files.length !== 1 || committed.length !== 1) return files;
  return [{ ...files[0]!, path: committed[0]!.path }];
}

function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => !isDeepStrictEqual(canonicalize(a[k]), canonicalize(b[k]))).sort();
}

function clean(m: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined));
}

function fileBytes(f: DesiredFile): Buffer {
  return f.encoding === "utf8" ? Buffer.from(f.content, "utf8") : Buffer.from(f.content, "base64");
}

function fileEntry(f: DesiredFile): ImportItemFile {
  const bytes = fileBytes(f);
  return {
    path: f.path,
    size: bytes.length,
    sha256: sha256Hex(bytes),
    ...(f.sourcePath ? { sourcePath: f.sourcePath } : {}),
    ...(f.encoding === "utf8" ? { lines: lineCount(f.content) } : {}),
  };
}

/** Lines added and removed from `before` to `after`, as a unified diff counts them. */
export function lineDiffStat(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const c of diffLines(before, after)) {
    if (c.added) added += c.count;
    else if (c.removed) removed += c.count;
  }
  return { added, removed };
}

/**
 * Add `diffStat` to the update items whose content changed. `readCommitted`
 * returns a committed file of the live asset (null when it isn't committed).
 * Text files are compared by path; for single-file types the lone file is
 * compared with the lone committed file, as in the mapping. Mutates the items.
 */
export async function addDiffStats(
  a: Pick<Analysis, "desired" | "results">,
  live: readonly LiveIndexEntry[],
  policy: Pick<Policy, "assetTypes">,
  readCommitted: (entry: LiveIndexEntry, path: string) => Promise<Buffer | null>,
): Promise<void> {
  const byId = new Map(live.map((l) => [l.assetId, l]));
  for (const [i, item] of a.results.items.entries()) {
    const entry = item.assetId ? byId.get(item.assetId) : undefined;
    if (item.action !== "update" || !item.changes?.content || !entry?.committed) continue;
    const desired = a.desired[i]!;
    const single = policy.assetTypes.assetTypes[item.assetType]?.content === "single-file" && desired.files.length === 1 && entry.committed.files.length === 1;
    const pairs = new Map<string, { after: string | null; before: string | null }>();
    for (const f of desired.files) pairs.set(single ? entry.committed.files[0]!.path : f.path, { after: f.encoding === "utf8" ? f.content : null, before: "" });
    for (const f of entry.committed.files) {
      const p = pairs.get(f.path) ?? { after: "", before: "" };
      const bytes = await readCommitted(entry, f.path);
      p.before = bytes && isUtf8Text(bytes) ? bytes.toString("utf8") : null;
      pairs.set(f.path, p);
    }
    let added = 0;
    let removed = 0;
    let comparable = true;
    for (const { before, after } of pairs.values()) {
      if (before === null || after === null) {
        comparable = false;
        break;
      }
      const s = lineDiffStat(before, after);
      added += s.added;
      removed += s.removed;
    }
    if (comparable) item.diffStat = { added, removed };
  }
}

function withoutAssetId(d: DesiredAsset): DesiredAsset {
  const { assetId: _assetId, ...rest } = d;
  return rest;
}

function fileEntries(check: PackageCheck): ImportFileEntry[] {
  const changes = new Map(check.build.changes.map((c) => [c.path, c.change]));
  const files = check.build.contents.files;
  return sortPaths(check.mapped.roles.keys()).map((p) => {
    const r = check.mapped.roles.get(p)!;
    return { path: p, role: r.role, assetKey: r.assetKey ?? null, size: files.get(p)?.length ?? 0, build: changes.get(p) ?? null };
  });
}

/** Count validation results per item. Mutates and returns the items. */
function countItemResults(items: ImportItem[], results: ImportResults["validation"]): ImportItem[] {
  const byKey = new Map(items.map((i) => [i.assetKey, i]));
  for (const r of results) {
    const item = r.assetKey ? byKey.get(r.assetKey) : undefined;
    if (!item) continue;
    if (r.level === "error") item.errors++;
    else item.warnings++;
  }
  return items;
}
