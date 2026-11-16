import { createHash } from "node:crypto";
import type { Policy } from "@/server/policy";
import { pySplitLines, type NormBundle, type NormRecord } from "./normalize";
import { pyRegex } from "./py";
import type { Analyzer } from "./types";

/**
 * Memory reads: for each run, the INDEX listings returned to the agent (blocks
 * of "N<TAB>- [name](./target): description" lines), the memory paths the agent
 * requested, the "file not found" results, and whether the failure-pattern
 * memory (when the settings name one) was listed in an index or its content
 * came back. The output keeps the snake_case field names of the reference
 * audit's memory usage file (sample-data/audit/memory_usage.json).
 *
 * Text is scanned line by line through the normalized records. Requested paths
 * also come from the tool calls' input, because an export can keep an input
 * only for messages it wrote as JSON.
 *
 * The patterns, the path marker and the rules that name an index listing are
 * settings (policy `analyzers.memoryReads`, see policy/analyzers.yaml), since
 * they depend on how a space names its memories.
 */

export type MemoryReadsSettings = Policy["analyzers"]["memoryReads"];

export interface MemoryReadsOutput {
  incident: string;
  indexes_read: Record<string, { rec: number; n: number }[]>;
  index_entries: Record<string, string[]>;
  memory_file_paths: [number, string][];
  file_not_found: [number, string][];
  failpat_listed_in_index: boolean;
  failpat_content_records: number[];
}

interface Entry {
  rec: number;
  name: string;
  target: string;
  desc: string | null;
}

export function classifyIndex(block: Entry[], d: MemoryReadsSettings): string {
  const names = block.map((e) => e.name);
  const targets = block.map((e) => e.target);
  const descs = block.map((e) => e.desc ?? "").join(" ").toLowerCase();
  for (const c of d.classes) {
    if (c.anyNamePrefix !== undefined && !names.some((n) => n.startsWith(c.anyNamePrefix!))) continue;
    if (c.anyNameIn && !c.anyNameIn.some((n) => names.includes(n))) continue;
    if (c.anyTargetSuffix !== undefined && !targets.some((t) => t.endsWith(c.anyTargetSuffix!))) continue;
    if (c.descriptionsInclude !== undefined && !descs.includes(c.descriptionsInclude.toLowerCase())) continue;
    if (c.minEntries !== undefined && block.length < c.minEntries) continue;
    return c.appendNames ? `${c.kind}:${names.slice(0, c.appendNames).join(",")}` : c.kind;
  }
  return `${d.fallbackKind}:${names.slice(0, d.fallbackNames).join(",")}`;
}

type Segment = { kind: "text"; text: string } | { kind: "input"; input: unknown };

/** Record content in reading order: text, then tool calls, then tool results. */
function segments(r: NormRecord): Segment[] {
  if (!(r.isMessage && r.structured)) return [{ kind: "text", text: r.text }];
  return [
    ...r.textBlocks.map((text) => ({ kind: "text" as const, text })),
    ...r.toolUses.map((u) => ({ kind: "input" as const, input: u.input })),
    ...r.toolResults.map((t) => ({ kind: "text" as const, text: t.text })),
  ];
}

function pathsInInput(v: unknown, keys: string[], out: string[]): void {
  if (Array.isArray(v)) for (const x of v) pathsInInput(x, keys, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (keys.includes(k) && typeof x === "string") out.push(x);
      else pathsInInput(x, keys, out);
    }
  }
}

export function memoryReads(b: NormBundle, d: MemoryReadsSettings): MemoryReadsOutput {
  const ENTRY = pyRegex(d.entry);
  const FP = pyRegex(d.filePath, "g");
  const FNF = pyRegex(d.fileNotFound, "g");
  const blocks: Entry[][] = [];
  const fps: [number, string][] = [];
  const fnfs: [number, string][] = [];
  const failpat: number[] = [];

  for (const r of b.records) {
    for (const seg of segments(r)) {
      if (seg.kind === "input") {
        const found: string[] = [];
        pathsInInput(seg.input, d.filePathKeys, found);
        for (const f of found) if (f.includes(d.memoryPathMarker)) fps.push([r.n, f]);
        continue;
      }
      let cur: Entry[] = [];
      for (const ln of pySplitLines(seg.text)) {
        const e = ENTRY.exec(ln);
        if (e) {
          if (Number(e[1]) === 1 && cur.length) {
            blocks.push(cur);
            cur = [];
          }
          cur.push({ rec: r.n, name: e[2]!, target: e[3]!, desc: e[4] ?? null });
          continue;
        }
        if (cur.length) {
          blocks.push(cur);
          cur = [];
        }
        for (const m of ln.matchAll(FP)) if (m[1]!.includes(d.memoryPathMarker)) fps.push([r.n, m[1]!]);
        for (const m of ln.matchAll(FNF)) fnfs.push([r.n, m[1]!]);
        if (d.failpatContent && ln.includes(d.failpatContent)) failpat.push(r.n);
      }
      if (cur.length) blocks.push(cur);
    }
  }

  const idx: Record<string, { rec: number; entries: string[] }[]> = {};
  for (const block of blocks) {
    const kind = classifyIndex(block, d);
    (idx[kind] ??= []).push({ rec: block[0]!.rec, entries: block.map((e) => e.name) });
  }
  const listed = d.failpatName !== "" && Object.values(idx).some((list) => list.some((blk) => blk.entries.some((e) => e.includes(d.failpatName))));
  return {
    incident: b.task.incidentId ?? b.task.taskId,
    indexes_read: Object.fromEntries(Object.entries(idx).map(([k, v]) => [k, v.map((x) => ({ rec: x.rec, n: x.entries.length }))])),
    index_entries: Object.fromEntries(Object.entries(idx).map(([k, v]) => [k, v[v.length - 1]!.entries])),
    memory_file_paths: fps,
    file_not_found: fnfs,
    failpat_listed_in_index: listed,
    failpat_content_records: failpat,
  };
}

function settingsDigest(d: MemoryReadsSettings): string {
  return createHash("sha256").update(JSON.stringify(d)).digest("hex");
}

export const memoryReadsAnalyzer: Analyzer<MemoryReadsOutput> = {
  id: "memory-reads",
  version: "1.0.0",
  label: "Memory reads",
  description: "Index listings read, memory paths requested, files not found",
  requires: [],
  configDigest: (ctx) => settingsDigest(ctx.policy.analyzers.memoryReads),
  run: (b, ctx) => memoryReads(b, ctx.policy.analyzers.memoryReads),
};
