import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { importedRecordRawOf } from "@/server/journals/markdown-import";
import { getAppPolicy } from "@/server/policy";
import { BENCHMARK_AUDIT_DIR, BENCHMARK_JOURNALS_DIR, benchmarkExpected } from "../../../test/helpers/fixtures";
import { memoryReads } from "./memory-reads";
import { cpLength, cpSlice, normalizeBundle } from "./normalize";
import { runMetrics } from "./run-metrics";
import { markdownBundle } from "./testing";

/**
 * Golden test: parsing the benchmark full journals
 * (sample-data/journals/benchmark) and running the run-metrics and memory-reads analyzers
 * reproduces the reference audit's metrics.json and memory_usage.json (sample-data/audit).
 * Those two files were produced by an independent Python implementation of the analyzers.
 *
 * Every field is compared. Four metrics fields differ by design, and each is
 * checked against the exact rule that explains it:
 *   start_utc, end_utc   Python printed a naive isoformat ("2026-10-26T17:43:06.020000");
 *                        the analyzer prints ISO 8601 UTC ("2026-10-26T17:43:06.020Z").
 *                        Same instant.
 *   prompt_chars         the Python parser measured the markdown block (a newline, the
 *                        "**role: user**" marker, blank lines, the text, trailing blank
 *                        lines). The analyzer measures the prompt text.
 *   auth_err_examples    each snippet started with "**role: user** " in Python. The analyzer's
 *                        snippet starts at the text, so it holds 15 more characters at the end.
 * memory_usage.json is reproduced exactly.
 *
 * Always runs. DAM_BENCHMARK_JOURNALS_DIR and DAM_BENCHMARK_AUDIT_DIR (see test/helpers/fixtures.ts)
 * point it at another dataset in the same layout.
 */

const METRICS = path.join(BENCHMARK_AUDIT_DIR, "metrics.json");
const MEMORY = path.join(BENCHMARK_AUDIT_DIR, "memory_usage.json");

const DIFFERS_BY_DESIGN = new Set(["start_utc", "end_utc", "prompt_chars", "auth_err_examples"]);
const ROLE_PREFIX = "**role: user** ";

type Row = Record<string, unknown> & { incident: string };

describe("benchmark audit golden outputs", () => {
  const metrics = JSON.parse(readFileSync(METRICS, "utf8")) as Row[];
  const memory = JSON.parse(readFileSync(MEMORY, "utf8")) as Row[];
  const incidents = readdirSync(BENCHMARK_JOURNALS_DIR).filter((d) => d.startsWith("INCIDENT-")).sort();

  const load = (inc: string) => {
    const buf = readFileSync(path.join(BENCHMARK_JOURNALS_DIR, inc, `${inc}_full_journal.md`));
    const text = buf.toString("utf8");
    const bundle = markdownBundle(text, getAppPolicy().policy, createHash("sha256").update(buf).digest("hex"));
    return { text, bundle, norm: normalizeBundle(bundle) };
  };

  it("covers the same incidents", () => {
    expect(incidents.length).toBeGreaterThan(0);
    expect(metrics.map((r) => r.incident).sort()).toEqual(incidents);
    expect(memory.map((r) => r.incident).sort()).toEqual(incidents);
    // The sample set has eight; a dataset given by DAM_BENCHMARK_* has its own count.
    const expected = benchmarkExpected();
    if (expected) expect(incidents).toEqual(expected.incidentIds);
  });

  it.each(incidents)("%s: run metrics match metrics.json", (inc) => {
    const { text, bundle, norm } = load(inc);
    const py = metrics.find((r) => r.incident === inc)!;
    const ts = runMetrics(norm) as unknown as Record<string, unknown>;

    // Every field metrics.json has, except the four below, is identical.
    for (const k of Object.keys(py)) {
      if (DIFFERS_BY_DESIGN.has(k)) continue;
      expect(ts[k], `${inc} ${k}`).toEqual(py[k]);
    }
    // Key order of the tool table is the same too (sorted by count, first seen first on ties).
    expect(Object.keys(ts.tools as object)).toEqual(Object.keys(py.tools as object));

    // start_utc / end_utc: the same instant, printed differently.
    for (const k of ["start_utc", "end_utc"]) {
      expect(Date.parse(`${py[k] as string}Z`), `${inc} ${k}`).toBe(Date.parse(ts[k] as string));
    }

    // prompt_chars: Python's body is the source text between the prompt's heading line (plus the
    // newline its regex consumed) and the next heading. It holds the role marker and the text.
    const promptRec = norm.records.find((r) => r.isMessage && r.role === "user" && r.hasText)!;
    const raw = importedRecordRawOf(bundle.records.find((r) => r.recordId === promptRec.recordId)!.raw)!;
    const start = text.indexOf(raw.heading) + raw.heading.length + 1;
    const next = text.indexOf("\n## Record ", start);
    const pyBody = text.slice(start, next + 1);
    expect(cpLength(pyBody), `${inc} prompt body`).toBe(py.prompt_chars);
    expect(pyBody.replace("**role: user**", "").trim()).toBe(promptRec.text);
    expect(ts.prompt_chars).toBe(cpLength(promptRec.text));

    // auth_err_examples: same records; each Python snippet is the role marker plus the start of ours.
    const pyEx = py.auth_err_examples as { rec: number; snip: string }[];
    const tsEx = ts.auth_err_examples as { rec: number; snip: string }[];
    expect(tsEx.map((e) => e.rec)).toEqual(pyEx.map((e) => e.rec));
    tsEx.forEach((e, i) => {
      const p = pyEx[i]!.snip;
      expect(p.startsWith(ROLE_PREFIX)).toBe(true);
      expect(cpSlice(e.snip, cpLength(p) - ROLE_PREFIX.length)).toBe(p.slice(ROLE_PREFIX.length));
    });
  });

  it.each(incidents)("%s: memory reads match memory_usage.json exactly", (inc) => {
    const { norm } = load(inc);
    const py = memory.find((r) => r.incident === inc)!;
    const ts = memoryReads(norm, getAppPolicy().policy.analyzers.memoryReads) as unknown as Record<string, unknown>;
    expect(Object.keys(ts).sort()).toEqual(Object.keys(py).sort());
    for (const k of Object.keys(py)) expect(ts[k], `${inc} ${k}`).toEqual(py[k]);
    expect(Object.keys(ts.indexes_read as object)).toEqual(Object.keys(py.indexes_read as object));
  });
});
