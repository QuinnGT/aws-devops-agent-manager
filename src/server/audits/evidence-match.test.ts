import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { auditProfileSchema } from "@/server/policy/sections/audits";
import { BENCHMARK_JOURNALS_DIR, benchmarkExpected } from "../../../test/helpers/fixtures";
import { decodeText, dedupeMatches, inputForFileName, isSystemFile, matchEvidenceFile, readFields, type MatchedEvidence } from "./evidence-match";
import { AuditRequestError } from "./errors";

const benchmark = getAppPolicy().policy.audits.profiles.benchmark!;
const beforeAfter = getAppPolicy().policy.audits.profiles["before-after"]!;
const scorecardInput = benchmark.inputs.find((i) => i.kind === "scorecard")!;

const SCORECARD = `# INCIDENT-12 scorecard

| Dimension | Value |
|---|---|
| DevOps RCA score (1 to 5 vs human doc) | **2/5** |
| Verdict | **Symptom only (partial)** |
| Comparison agent (Reference-RCA) score | 5/5 |
`;

describe("ground-truth file matching", () => {
  it("matches each input's file name and builds the incident ID from the template", () => {
    const rca = matchEvidenceFile(benchmark, "INCIDENT-12/12_actual_rca.md", "# RCA");
    expect(rca).toMatchObject({ matched: true, incidentId: "INCIDENT-12", kind: "actual_rca", fileName: "12_actual_rca.md", path: "INCIDENT-12/12_actual_rca.md" });
    expect(matchEvidenceFile(benchmark, "INCIDENT-12_actual_rca.md", "x")).toMatchObject({ matched: true, incidentId: "INCIDENT-12" });
    const sc = matchEvidenceFile(benchmark, "INCIDENT-12_scorecard.md", SCORECARD) as MatchedEvidence;
    expect(sc).toMatchObject({ matched: true, kind: "scorecard", fields: { score: "2/5", verdict: "Symptom only (partial)", comparisonScore: "5/5" } });
    expect(sc.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sc.sizeBytes).toBe(Buffer.byteLength(SCORECARD));
  });

  it("explains every file it does not match", () => {
    expect(matchEvidenceFile(benchmark, "INCIDENT-12_full_journal.md", "x")).toMatchObject({ matched: false, reason: expect.stringContaining("matches no document") });
    expect(matchEvidenceFile(benchmark, "__MACOSX/._12_actual_rca.md", "x")).toMatchObject({ matched: false, reason: expect.stringContaining("zip tool") });
    expect(matchEvidenceFile(benchmark, "12_actual_rca.md", null)).toMatchObject({ matched: false, reason: "The file is not UTF-8 text." });
    expect(matchEvidenceFile({ ...beforeAfter, inputs: [] }, "12_actual_rca.md", "x")).toMatchObject({ matched: false, reason: expect.stringContaining("takes no ground-truth") });
  });

  it("reports a pattern that captures no incident number", () => {
    const p = auditProfileSchema.parse({ ...benchmark, inputs: [{ kind: "note", label: "Note", fileNamePattern: "^note\\.md$" }] });
    expect(matchEvidenceFile(p, "note.md", "x")).toMatchObject({ matched: false, reason: expect.stringContaining("captured no incident number") });
  });

  it("gives a clear error for a bad pattern in policy", () => {
    const p = auditProfileSchema.parse({ ...benchmark, inputs: [{ kind: "note", label: "Note", fileNamePattern: "([" }] });
    expect(() => inputForFileName(p, "x.md")).toThrow(AuditRequestError);
  });

  it("reads fields with group `value`, else group 1, trimmed; null when absent", () => {
    expect(readFields({ label: "x", fields: { a: { label: "A", pattern: "A: (\\w+)", column: false }, b: { label: "B", pattern: "B:(?<value> +\\w+ +)", column: false }, c: { label: "C", pattern: "C: (\\w+)", column: false } } }, "A: one\nB:  two  \n")).toEqual({
      a: "one",
      b: "two",
      c: null,
    });
    expect(readFields(scorecardInput, "no table here")).toEqual({ score: null, verdict: null, comparisonScore: null });
  });

  it("strips NUL from bodies and rejects binary or invalid UTF-8", () => {
    expect(decodeText(Buffer.from("plain text"))).toBe("plain text");
    expect(decodeText(Buffer.from("\uFEFFwith bom"))).toBe("with bom");
    expect(decodeText(Buffer.from([0x61, 0x00, 0x62]))).toBeNull();
    expect(decodeText(Buffer.from([0xff, 0xfe, 0x41]))).toBeNull();
  });

  it("keeps the first file per incident and kind in one upload", () => {
    const out = dedupeMatches([matchEvidenceFile(benchmark, "a/12_actual_rca.md", "one"), matchEvidenceFile(benchmark, "b/INCIDENT-12_actual_rca.md", "two"), matchEvidenceFile(benchmark, "13_actual_rca.md", "x")]);
    expect(out.map((m) => m.matched)).toEqual([true, false, true]);
    expect(out[1]).toMatchObject({ reason: expect.stringContaining("a/12_actual_rca.md") });
  });

  it("knows the files zip tools add", () => {
    expect(isSystemFile("__MACOSX/x/._a.md")).toBe(true);
    expect(isSystemFile("x/.DS_Store")).toBe(true);
    expect(isSystemFile("x/a.md")).toBe(false);
  });
});

describe("the benchmark incidents' ground truth", () => {
  const dirs = readdirSync(BENCHMARK_JOURNALS_DIR).filter((d) => /^INCIDENT-\d+$/.test(d)).sort();
  const expected = benchmarkExpected();

  it("has the incident folders", () => {
    expect(dirs.length).toBeGreaterThan(0);
    if (expected) expect(dirs).toEqual(expected.incidentIds);
  });

  it.each(dirs)("%s: both documents match and the scorecard fields parse", (dir) => {
    const files = readdirSync(path.join(BENCHMARK_JOURNALS_DIR, dir));
    const matches = files.map((f) => matchEvidenceFile(benchmark, `${dir}/${f}`, decodeText(readFileSync(path.join(BENCHMARK_JOURNALS_DIR, dir, f)))));
    const matched = matches.filter((m): m is MatchedEvidence => m.matched);
    expect(matched.map((m) => m.kind).sort()).toEqual(["actual_rca", "scorecard"]);
    for (const m of matched) expect(m.incidentId).toBe(dir);
    const sc = matched.find((m) => m.kind === "scorecard")!;
    // The benchmark profile reads these three fields from the scorecard.
    expect(sc.fields.score).toMatch(/^[1-5]\/5$/);
    expect(sc.fields.verdict).toBeTruthy();
    expect(sc.fields.comparisonScore).toMatch(/^[1-5]\/5$/);
    if (expected) expect(sc.fields).toEqual({ score: expected.scorecards[dir]!.score, verdict: expected.scorecards[dir]!.verdict, comparisonScore: expected.scorecards[dir]!.comparisonScore });
    // The journals and the condensed RCA are not ground truth for this profile.
    expect(matches.filter((m) => !m.matched).map((m) => m.fileName).sort()).toEqual([`${dir}_devops_journal.md`, `${dir}_full_journal.md`]);
  });
});
