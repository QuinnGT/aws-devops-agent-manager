import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { BENCHMARK_AUDIT_DIR, benchmarkExpected } from "../../../test/helpers/fixtures";
import type { Citation, CitationCheck } from "./contract";
import { citationBelongs, clipTitle, extractFindings, fillTitle, parseFieldPath, TITLE_MAX_CHARS } from "./findings";
import { benchmarkFixture, benchmarkReviews } from "./testing";

const benchmark = getAppPolicy().policy.audits.profiles.benchmark!;
const beforeAfter = getAppPolicy().policy.audits.profiles["before-after"]!;
const diagnosis = benchmark.findings.find((f) => f.kind === "diagnosis")!;
const fix = benchmark.findings.find((f) => f.kind === "fix")!;

const cite = (field: string, record = 1, ok = true): Citation => ({ record, quote: null, field, ok, ...(ok ? {} : { problem: "missing-record" as const }) });
const check = (citations: Citation[]): CitationCheck => ({ ok: citations.every((c) => c.ok), checked: citations.length, failed: citations.filter((c) => !c.ok).length, citations });

describe("field paths", () => {
  it("reads bracket, dot and $ forms", () => {
    expect(parseFieldPath("fixes[0].evidence[1]")).toEqual(["fixes", 0, "evidence", 1]);
    expect(parseFieldPath("fixes.2.fix")).toEqual(["fixes", 2, "fix"]);
    expect(parseFieldPath("$.near_miss")).toEqual(["near_miss"]);
    expect(parseFieldPath("$")).toEqual([]);
    expect(parseFieldPath(" timing.note ")).toEqual(["timing", "note"]);
  });

  it("assigns citations to the finding they point into", () => {
    expect(citationBelongs(diagnosis, 0, "near_miss")).toBe(true);
    expect(citationBelongs(diagnosis, 0, "failure_modes[1]")).toBe(true);
    expect(citationBelongs(diagnosis, 0, "timing.note")).toBe(false);
    expect(citationBelongs(diagnosis, 0, "fixes[0].fix")).toBe(false);
    expect(citationBelongs(fix, 0, "fixes[0].evidence[1]")).toBe(true);
    expect(citationBelongs(fix, 1, "fixes[0].evidence[1]")).toBe(false);
    expect(citationBelongs(fix, 2, "fixes[2]")).toBe(true);
    expect(citationBelongs(fix, 0, "fixes")).toBe(false);
    expect(citationBelongs(fix, 0, "fixes[0].unknown")).toBe(false);
    expect(citationBelongs(fix, 0, "")).toBe(false);
    // Top-level citations[] entries go where their `supports` key points.
    expect(citationBelongs(diagnosis, 0, "citations[3]", "near_miss")).toBe(true);
    expect(citationBelongs(diagnosis, 0, "citations[3]", "timing")).toBe(false);
    expect(citationBelongs(diagnosis, 0, "citations[3]")).toBe(false);
    expect(citationBelongs(fix, 1, "citations[4]", "fixes[1]")).toBe(true);
    expect(citationBelongs(fix, 0, "citations[4]", "fixes[1]")).toBe(false);
    expect(citationBelongs(diagnosis, 0, "citations[4]", "fixes[1]")).toBe(false);
  });
});

describe("titles", () => {
  it("fills {field} and {incidentId}, with unknown placeholders empty", () => {
    expect(fillTitle("{incidentId}: {one_line}", { one_line: "Missed  the\nconsumer" }, "INCIDENT-1")).toBe("INCIDENT-1: Missed the consumer");
    expect(fillTitle("{a} / {b} / {nope}", { a: ["x", "y"], b: 3 }, null)).toBe("x, y / 3 /");
  });

  it("clips long titles at a word boundary", () => {
    const long = "word ".repeat(200);
    const t = clipTitle(long);
    expect(t.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(t.endsWith("...")).toBe(true);
    expect(t).not.toMatch(/wor\.\.\.$/);
  });
});

describe("extractFindings", () => {
  const output = {
    incident: "INCIDENT-7",
    one_line: "Picked a chronic error",
    primary_failure_mode: "K_chronic_noise",
    failure_modes: ["K_chronic_noise", "E_symptom_stop"],
    near_miss: null,
    secret_extra: "not copied",
    fixes: [
      { owner: "instructions", fix: "Check the baseline rate first", evidence: [{ record: 4, quote: "rate" }], extra: 1 },
      "not an object",
      { owner: "customer_memory", fix: "", evidence: [] },
    ],
  };

  it("gives one finding per $ extractor and per array element, with only the extractor's fields", () => {
    const got = extractFindings(benchmark, output, { incidentId: "INCIDENT-7", citationCheck: null });
    expect(got.map((f) => [f.kind, f.ordinal])).toEqual([
      ["diagnosis", 0],
      ["fix", 0],
      ["fix", 2],
    ]);
    expect(got[0]!.title).toBe("INCIDENT-7: Picked a chronic error");
    expect(Object.keys(got[0]!.values).sort()).toEqual(["failure_modes", "near_miss", "one_line", "primary_failure_mode"]);
    expect(got[0]!.values).not.toHaveProperty("secret_extra");
    expect(got[1]!.values).toEqual({ owner: "instructions", fix: "Check the baseline rate first", evidence: [{ record: 4, quote: "rate" }] });
    // An empty title falls back to the extractor label and position.
    expect(got[2]!.title).toBe("Fix 3");
  });

  it("copies values, so later edits to the output do not leak into findings", () => {
    const o = structuredClone(output);
    const got = extractFindings(benchmark, o, { incidentId: null, citationCheck: null });
    (o.failure_modes as string[]).push("X");
    expect(got[0]!.values.failure_modes).toEqual(["K_chronic_noise", "E_symptom_stop"]);
  });

  it("gives each finding its citations, failed ones included", () => {
    const c = check([cite("near_miss", 3), cite("fixes[0].evidence[0]", 4), cite("fixes[2]", 9, false), cite("timing.note", 5), cite("fixes[1].fix", 6)]);
    const got = extractFindings(benchmark, output, { incidentId: "INCIDENT-7", citationCheck: c });
    expect(got[0]!.citations.map((x) => x.record)).toEqual([3]);
    expect(got[1]!.citations.map((x) => x.record)).toEqual([4]);
    expect(got[2]!.citations).toEqual([{ record: 9, quote: null, field: "fixes[2]", ok: false, problem: "missing-record" }]);
  });

  it("returns nothing for output that is not an object", () => {
    expect(extractFindings(benchmark, null, { incidentId: null, citationCheck: null })).toEqual([]);
    expect(extractFindings(benchmark, [1, 2], { incidentId: null, citationCheck: null })).toEqual([]);
    expect(extractFindings(benchmark, { fixes: "nope" }, { incidentId: null, citationCheck: null }).map((f) => f.kind)).toEqual(["diagnosis"]);
  });

  it("uses the before-after profile's extractors and title template", () => {
    const got = extractFindings(
      beforeAfter,
      { cohort: "after", verdict: "Partly supported", conclusion_support: "partly_supported", issues: [{ area: "final_output", priority: "P1", issue: "Stale summary", owner: "aws_service", evidence: [] }] },
      { incidentId: "INCIDENT-31495", citationCheck: check([cite("issues[0].evidence[0]", 12), cite("concerns", 2)]) },
    );
    expect(got.map((f) => f.title)).toEqual(["INCIDENT-31495 (after): Partly supported", "Stale summary"]);
    expect(got[0]!.citations.map((c) => c.record)).toEqual([2]);
    expect(got[1]!.citations.map((c) => c.record)).toEqual([12]);
  });
});

const reviews = benchmarkReviews(BENCHMARK_AUDIT_DIR);
const expected = benchmarkExpected();

describe("extractFindings on the benchmark reference reviews", () => {
  it("has the reviews", () => {
    expect(reviews.length).toBeGreaterThan(0);
    if (expected) expect(reviews.map((r) => r.file)).toEqual(expected.incidentIds.map((i) => `${i}.json`));
  });

  it.each(reviews.map((r) => [r.file, r.raw] as const))("%s", (_file, raw) => {
    const fx = benchmarkFixture(raw, diagnosis.fields);
    const got = extractFindings(benchmark, fx.output, { incidentId: fx.incident, citationCheck: fx.citationCheck });
    const fixes = fx.output.fixes as { owner: string; fix: string }[];

    expect(got.filter((f) => f.kind === "diagnosis")).toHaveLength(1);
    expect(got.filter((f) => f.kind === "fix")).toHaveLength(fixes.length);
    const wanted = expected?.reviews[fx.incident]?.findings;
    if (wanted) {
      expect(got.filter((f) => f.kind === "diagnosis")).toHaveLength(wanted.diagnosis);
      expect(got.filter((f) => f.kind === "fix")).toHaveLength(wanted.fix);
    }
    const d = got[0]!;
    expect(d.title).toBe(clipTitle(`${fx.incident}: ${String(fx.output.one_line)}`));
    expect(Object.keys(d.values).sort()).toEqual(diagnosis.fields.filter((f) => f in fx.output).sort());
    expect(benchmark.failureModes.map((m) => m.id)).toContain(d.values.primary_failure_mode);
    expect(d.citations).toHaveLength(fx.expectedDiagnosisCitations);
    for (const c of d.citations) expect(diagnosis.fields).toContain(parseFieldPath(c.field)[0]);

    got
      .filter((f) => f.kind === "fix")
      .forEach((f, i) => {
        expect(f.ordinal).toBe(i);
        expect(f.title).toBe(clipTitle(fixes[i]!.fix));
        expect(Object.keys(f.values).sort()).toEqual(["evidence", "fix", "owner"]);
        expect(benchmark.fixOwners.map((o) => o.id)).toContain(f.values.owner);
        expect(f.citations).toHaveLength(fx.expectedFixCitations[i]!);
        for (const c of f.citations) expect(c.field.startsWith(`fixes[${i}].evidence[`)).toBe(true);
      });

    // Every citation lands on at most one finding; the rest point outside every extractor's fields.
    const total = fx.expectedDiagnosisCitations + fx.expectedFixCitations.reduce((a, b) => a + b, 0);
    expect(got.reduce((n, f) => n + f.citations.length, 0)).toBe(total);
    const leftover = fx.citationCheck.citations.filter((c) => !got.some((f) => citationBelongs(f.kind === "fix" ? fix : diagnosis, f.ordinal, c.field)));
    expect(leftover).toHaveLength(fx.citationCheck.citations.length - total);
    for (const c of leftover) expect(diagnosis.fields).not.toContain(parseFieldPath(c.field)[0]);
  });
});
