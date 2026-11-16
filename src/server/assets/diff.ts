import { structuredPatch } from "diff";
import type { AssetJson } from "@/lib/assets/types";
import { ASSET_BROWSER } from "./config";
import { stableStringify } from "./sync-status";

/**
 * Diff between two recorded versions of an asset: asset.json fields and
 * metadata, then each file line by line. Pure; unit-tested. Rendering is plain
 * text in <pre>, so no diff output is ever interpreted as HTML.
 */

export interface VersionFile {
  path: string;
  sha256: string | null;
  size: number | null;
  /** False when the file was above the commit threshold */
  committed: boolean;
  /** Committed content, or null when it was not committed or could not be read */
  content: string | null;
}

export interface VersionContent {
  assetJson: AssetJson | null;
  files: VersionFile[];
}

export interface ValueChange {
  key: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}

export type DiffLine = { kind: "add" | "del" | "ctx" | "meta"; text: string };

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  status: "added" | "removed" | "modified" | "unchanged" | "not-comparable";
  /** Why a modified file has no line diff */
  reason?: string;
  beforeSha: string | null;
  afterSha: string | null;
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

export interface AssetDiff {
  /** asset.json fields other than metadata and files (serviceVersion, timestamps, assetType) */
  fields: ValueChange[];
  metadata: ValueChange[];
  files: FileDiff[];
  /** True when nothing differs */
  identical: boolean;
}

export interface DiffOptions {
  maxFileBytes?: number;
  timeoutMs?: number;
  context?: number;
}

/** Key-level difference of two flat records; nested values compare as stable JSON. */
export function diffRecords(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined): ValueChange[] {
  const a = before ?? {};
  const b = after ?? {};
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out: ValueChange[] = [];
  for (const key of keys) {
    const inA = key in a && a[key] !== undefined;
    const inB = key in b && b[key] !== undefined;
    if (inA && !inB) out.push({ key, kind: "removed", before: a[key] });
    else if (!inA && inB) out.push({ key, kind: "added", after: b[key] });
    else if (inA && inB && stableStringify(a[key]) !== stableStringify(b[key])) out.push({ key, kind: "changed", before: a[key], after: b[key] });
  }
  return out;
}

const FIELD_KEYS = ["assetType", "serviceVersion", "serviceCreatedAt", "serviceUpdatedAt"] as const;

function assetFields(j: AssetJson | null): Record<string, unknown> {
  if (!j) return {};
  return Object.fromEntries(FIELD_KEYS.map((k) => [k, j[k]]));
}

function looksBinary(s: string): boolean {
  return s.includes("\u0000");
}

/** Line diff of two texts as hunks. Returns null when the diff took longer than the timeout. */
export function diffText(before: string, after: string, opts: DiffOptions = {}): DiffHunk[] | null {
  const patch = structuredPatch("before", "after", before, after, undefined, undefined, {
    context: opts.context ?? ASSET_BROWSER.diffContextLines,
    timeout: opts.timeoutMs ?? ASSET_BROWSER.diffTimeoutMs,
  });
  if (!patch) return null;
  return patch.hunks.map((h) => ({
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines.map((l): DiffLine => {
      const c = l.charAt(0);
      const text = l.slice(1);
      if (c === "+") return { kind: "add", text };
      if (c === "-") return { kind: "del", text };
      if (c === "\\") return { kind: "meta", text: l.slice(2) };
      return { kind: "ctx", text };
    }),
  }));
}

function fileDiff(path: string, a: VersionFile | undefined, b: VersionFile | undefined, opts: DiffOptions): FileDiff {
  const base = { path, beforeSha: a?.sha256 ?? null, afterSha: b?.sha256 ?? null, hunks: [] as DiffHunk[], added: 0, removed: 0 };
  const maxBytes = opts.maxFileBytes ?? ASSET_BROWSER.maxDiffFileBytes;
  const status: FileDiff["status"] = !a ? "added" : !b ? "removed" : "modified";
  if (a && b) {
    const sameSha = a.sha256 && b.sha256 && a.sha256 === b.sha256;
    const sameText = a.content !== null && b.content !== null && a.content === b.content;
    if (sameSha || (!a.sha256 && !b.sha256 && sameText)) return { ...base, status: "unchanged" };
  }
  const sides = [a, b].filter((x): x is VersionFile => Boolean(x));
  if (sides.some((s) => !s.committed)) return { ...base, status: a && b ? "not-comparable" : status, reason: "Above the commit size threshold, so git holds only its hash" };
  if (sides.some((s) => s.content === null)) return { ...base, status: a && b ? "not-comparable" : status, reason: "Content could not be read from git" };
  const before = a?.content ?? "";
  const after = b?.content ?? "";
  if (looksBinary(before) || looksBinary(after)) return { ...base, status: a && b ? "not-comparable" : status, reason: "Binary content" };
  if (Buffer.byteLength(before) > maxBytes || Buffer.byteLength(after) > maxBytes) {
    return { ...base, status: a && b ? "not-comparable" : status, reason: "Too large to compare line by line" };
  }
  const hunks = diffText(before, after, opts);
  if (!hunks) return { ...base, status: a && b ? "not-comparable" : status, reason: "Too many changes to show" };
  const added = hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === "add").length, 0);
  const removed = hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === "del").length, 0);
  if (a && b && hunks.length === 0) return { ...base, status: "unchanged" };
  return { ...base, status, hunks, added, removed };
}

export function diffAssetVersions(from: VersionContent, to: VersionContent, opts: DiffOptions = {}): AssetDiff {
  const fields = diffRecords(assetFields(from.assetJson), assetFields(to.assetJson));
  const metadata = diffRecords(from.assetJson?.metadata, to.assetJson?.metadata);
  const aFiles = new Map(from.files.map((f) => [f.path, f]));
  const bFiles = new Map(to.files.map((f) => [f.path, f]));
  const paths = [...new Set([...aFiles.keys(), ...bFiles.keys()])].sort();
  const files = paths.map((p) => fileDiff(p, aFiles.get(p), bFiles.get(p), opts));
  const identical = fields.length === 0 && metadata.length === 0 && files.every((f) => f.status === "unchanged");
  return { fields, metadata, files, identical };
}

/** JSON for showing a metadata value in <pre>. */
export function showValue(v: unknown): string {
  if (v === undefined) return "";
  return typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v, null, 2);
}
