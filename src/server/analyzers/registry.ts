import { createHash } from "node:crypto";
import type { JournalBundle } from "@/lib/journal/types";
import { condensedTraceAnalyzer } from "./condensed-trace";
import { deployedVsReadAnalyzer } from "./deployed-vs-read";
import { memoryReadsAnalyzer } from "./memory-reads";
import { normalizeBundle, type NormBundle } from "./normalize";
import { outputRulesAnalyzer } from "./output-rules";
import { runMetricsAnalyzer } from "./run-metrics";
import type { Analyzer, AnalyzerContext } from "./types";

/** Every analyzer, in the order the UI shows them. */
export const ANALYZERS: readonly Analyzer[] = [
  runMetricsAnalyzer,
  memoryReadsAnalyzer,
  condensedTraceAnalyzer,
  outputRulesAnalyzer,
  deployedVsReadAnalyzer,
] as Analyzer[];

export const ANALYZER_IDS = ["run-metrics", "memory-reads", "condensed-trace", "output-rules", "deployed-vs-read"] as const;
export type AnalyzerId = (typeof ANALYZER_IDS)[number];

/** Analyzers that need nothing but the journal; the default for "Run analyzers". */
export const JOURNAL_ONLY_ANALYZERS: AnalyzerId[] = ANALYZER_IDS.filter((id) => getAnalyzer(id).requires.length === 0);

export function getAnalyzer(id: string): Analyzer {
  const a = ANALYZERS.find((x) => x.id === id);
  if (!a) throw new Error(`Unknown analyzer: ${id}`);
  return a;
}

/** JSON with object keys sorted, so a value read back from jsonb hashes the same as the original. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
}

/** SHA-256 over what analyzers read: task identity, import header and every record in order. */
export function bundleDigest(b: NormBundle, source: JournalBundle): string {
  const h = createHash("sha256");
  h.update(canonicalJson({ taskId: b.task.taskId, incidentId: b.task.incidentId, title: b.task.title, header: b.importHeader, root: b.rootExecutionId }));
  const byId = new Map(source.records.map((r) => [r.recordId, r]));
  for (const r of b.records) {
    const s = byId.get(r.recordId);
    h.update(`\n${r.recordId}\0${r.executionId}\0${r.seq}\0${r.recordType}\0${r.createdAt.toISOString()}\0`);
    h.update(canonicalJson(s?.content ?? null));
  }
  return h.digest("hex");
}

export function inputDigestFor(a: Analyzer, bundleSha: string, ctx: AnalyzerContext): string {
  return createHash("sha256").update(`${a.id}\0${bundleSha}\0${a.configDigest(ctx)}`).digest("hex");
}

export interface AnalyzerResult {
  analyzer: string;
  analyzerVersion: string;
  inputDigest: string;
  output: unknown;
}

/** Normalize once and run the given analyzers. Pure: no database. */
export function runAnalyzers(bundle: JournalBundle, ids: readonly string[], ctx: AnalyzerContext): AnalyzerResult[] {
  const norm = normalizeBundle(bundle);
  const sha = bundleDigest(norm, bundle);
  return ids.map((id) => {
    const a = getAnalyzer(id);
    return { analyzer: a.id, analyzerVersion: a.version, inputDigest: inputDigestFor(a, sha, ctx), output: a.run(norm, ctx) };
  });
}
