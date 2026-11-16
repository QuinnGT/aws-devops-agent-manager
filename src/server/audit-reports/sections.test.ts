import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { compareIncidents, countKeys, countTable, displayMetric, displayValue, findingsTable, getPath, incidentList, median, metricsTable, schemaEnum } from "./sections";
import { benchmarkProfile, benchmarkSchema, diagnosis, finding, fix, item } from "./test-support";
import type { ReportInputs, ReportSectionConfig } from "./types";
import { acceptedFindings } from "./view";
import type { FindingRecord } from "./view";

const profile = benchmarkProfile();
const section = (id: string) => profile.report.sections.find((s) => s.id === id)!;
const i1 = item(1);
const i2 = item(2);
const i10 = item(10);
const i3 = item(3, { state: "skipped" });

function inputs(findings: FindingRecord[], over: Partial<ReportInputs> = {}): ReportInputs {
  const items = [i1, i2, i10, i3];
  return { profile, items, findings: acceptedFindings(items, findings), evidence: {}, analyzerRuns: {}, outputSchema: benchmarkSchema(), ...over };
}

describe("helpers", () => {
  it("sorts incidents naturally and reads dotted paths", () => {
    expect(["INCIDENT-10", "INCIDENT-9", "INCIDENT-100"].sort(compareIncidents)).toEqual(["INCIDENT-9", "INCIDENT-10", "INCIDENT-100"]);
    expect(getPath({ a: { b: [{ c: 3 }] } }, "a.b.0.c")).toBe(3);
    expect(getPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(getPath({ __proto__: { x: 1 } }, "x")).toBeUndefined();
  });

  it("formats values: labels, arrays, record citations, metrics", () => {
    const labels = new Map([["instructions", "Instruction and skill package"]]);
    expect(displayValue("instructions", labels)).toBe("Instruction and skill package");
    expect(displayValue(["a", "b"])).toBe("a, b");
    expect(displayValue([{ record: 12, quote: "x" }, { record: 40 }])).toBe("R12, R40");
    expect(displayValue({ other: 1 })).toBe('{"other":1}');
    expect(displayValue(null)).toBe("");
    expect(displayMetric(25.4567)).toBe("25.46");
    expect(displayMetric(null)).toBeNull();
    expect(displayMetric(Number.NaN)).toBeNull();
    expect(countKeys(["A", "A", "B"])).toEqual(["A", "B"]);
    expect(countKeys("  ")).toEqual([]);
  });

  it("reads enum values from the review output schema", () => {
    const schema = benchmarkSchema();
    expect(schemaEnum(schema, profile.findings[0]!, "reachability")).toEqual(["reachable", "partially_reachable", "out_of_reach"]);
    expect(schemaEnum(schema, profile.findings[1]!, "owner")).toEqual(["customer_access", "customer_trigger", "customer_memory", "instructions", "aws_service", "none_feasible"]);
    expect(schemaEnum(schema, profile.findings[0]!, "failure_modes")).toHaveLength(12);
    expect(schemaEnum(null, profile.findings[0]!, "reachability")).toBeNull();
  });
});

describe("count tables", () => {
  const all = [
    diagnosis(i1, { primary_failure_mode: "D_wrong_component", reachability: "reachable" }),
    diagnosis(i2, { primary_failure_mode: "F_premature_ruleout", reachability: "out_of_reach" }),
    diagnosis(i10, { primary_failure_mode: "D_wrong_component", reachability: "sideways" }),
    // never counted: proposed, rejected, a skipped item, a review that is not current
    diagnosis(i1, { primary_failure_mode: "A_out_of_reach" }, { state: "proposed", ordinal: 1 }),
    diagnosis(i2, { primary_failure_mode: "A_out_of_reach" }, { state: "rejected", ordinal: 1 }),
    diagnosis(i3, { primary_failure_mode: "A_out_of_reach" }),
    diagnosis(i10, { primary_failure_mode: "A_out_of_reach" }, { reviewId: "99999999-0000-4000-8000-000000000000", ordinal: 2 }),
  ];

  it("lists every failure mode with its readable label, zeros included, in profile order", () => {
    const t = countTable(section("failure-modes"), inputs(all));
    expect(t.total).toBe(3);
    expect(t.header).toBe("Primary failure mode");
    expect(t.rows).toHaveLength(12);
    expect(t.rows.map((r) => r.value)).toEqual(profile.failureModes.map((m) => m.id));
    expect(t.rows.find((r) => r.value === "D_wrong_component")).toEqual({ value: "D_wrong_component", label: "Wrong component", count: 2, known: true });
    expect(t.rows.find((r) => r.value === "F_premature_ruleout")).toMatchObject({ label: "Ruled out too early", count: 1 });
    expect(t.rows.find((r) => r.value === "A_out_of_reach")).toMatchObject({ label: "Evidence out of reach", count: 0 });
  });

  it("puts unknown values after the known ones, and findings without a value last", () => {
    const withMissing = [...all, diagnosis(item(4), { reachability: null })];
    const t = countTable(section("reachability"), inputs(withMissing, { items: [i1, i2, i10, i3, item(4)], findings: acceptedFindings([i1, i2, i10, i3, item(4)], withMissing) }));
    expect(t.rows).toEqual([
      { value: "reachable", label: "Within reach", count: 1, known: true },
      { value: "partially_reachable", label: "Partly within reach", count: 0, known: true },
      { value: "out_of_reach", label: "Out of reach", count: 1, known: true },
      { value: "sideways", label: "sideways", count: 1, known: false },
      { value: null, label: "Not set", count: 1, known: false },
    ]);
    expect(t.total).toBe(4);
  });

  it("takes known values from the output schema, and labels from the profile's findings, when the section has no labels", () => {
    const bare: ReportSectionConfig = { id: "r", title: "R", kind: "count-table", audience: "internal", findingKind: "diagnosis", field: "reachability" };
    const t = countTable(bare, inputs(all));
    expect(t.rows.map((r) => [r.value, r.label, r.count])).toEqual([
      ["reachable", "Reachable", 1],
      ["partially_reachable", "Partly reachable", 0],
      ["out_of_reach", "Out of reach", 1],
      ["sideways", "sideways", 1],
    ]);
    // The diagnosis extractor's fieldLabels name the field
    expect(t.header).toBe("Within reach");
  });

  it("counts fixes by owner, one per fix, with fix owner labels", () => {
    const fixes = [fix(i1, 0, { owner: "instructions" }), fix(i1, 1, { owner: "customer_access" }), fix(i2, 0, { owner: "instructions" }), fix(i2, 1, { owner: "instructions" }, { state: "rejected" })];
    const t = countTable(section("fixes-by-owner"), inputs(fixes));
    expect(t.total).toBe(3);
    expect(t.rows.map((r) => [r.label, r.count])).toEqual([
      ["Customer tool or data access", 1],
      ["Customer trigger context", 0],
      ["Customer memory or runbook content", 0],
      ["Instruction and skill package", 2],
      ["DevOps Agent service behavior", 0],
      ["No feasible fix", 0],
    ]);
  });

  it("counts each element of an array field once per finding", () => {
    const s: ReportSectionConfig = { id: "m", title: "M", kind: "count-table", audience: "internal", findingKind: "diagnosis", field: "failure_modes", labels: "failureModes" };
    const t = countTable(s, inputs([diagnosis(i1, { failure_modes: ["D_wrong_component", "E_symptom_stop", "D_wrong_component"] }), diagnosis(i2, { failure_modes: ["E_symptom_stop"] })]));
    expect(t.rows.find((r) => r.value === "E_symptom_stop")!.count).toBe(2);
    expect(t.rows.find((r) => r.value === "D_wrong_component")!.count).toBe(1);
  });

  it("shows every known value at zero when nothing is accepted", () => {
    const t = countTable(section("scorecard-fairness"), inputs([diagnosis(i1, {}, { state: "proposed" })]));
    expect(t.total).toBe(0);
    expect(t.rows.map((r) => [r.label, r.count])).toEqual([
      ["Fair", 0],
      ["Mostly fair", 0],
      ["Not fair", 0],
      ["Not applicable", 0],
    ]);
  });
});

describe("findings tables and incident lists", () => {
  it("has one row per accepted fix, sorted by incident, with readable owners", () => {
    const fixes = [fix(i10, 0, { owner: "aws_service", fix: "Ten" }), fix(i2, 1, { fix: "Two b" }), fix(i2, 0, { fix: "Two a", owner: "customer_memory" }), fix(i1, 0, { fix: "Proposed" }, { state: "proposed" })];
    const t = findingsTable(section("fixes"), inputs(fixes));
    expect(t.columns).toEqual([
      { id: "owner", header: "Owner" },
      { id: "fix", header: "Fix" },
    ]);
    expect(t.rows.map((r) => [r.incident, ...r.cells])).toEqual([
      ["INCIDENT-2", "Customer memory or runbook content", "Two a"],
      ["INCIDENT-2", "Instruction and skill package", "Two b"],
      ["INCIDENT-10", "DevOps Agent service behavior", "Ten"],
    ]);
  });

  it("defaults to the extractor's fields and labels, and formats record citations", () => {
    const s: ReportSectionConfig = { id: "f", title: "F", kind: "findings-table", audience: "internal", findingKind: "fix" };
    const t = findingsTable(s, inputs([fix(i1, 0)]));
    expect(t.columns).toEqual([
      { id: "owner", header: "Owner" },
      { id: "fix", header: "Fix" },
      { id: "evidence", header: "Evidence" },
    ]);
    // An owner reads as the profile's fix owner label, never its ID
    expect(t.rows[0]!.cells).toEqual(["Instruction and skill package", "Check the cache tier before the gateway.", "R12"]);
  });

  it("labels the before-after profile's issues, which name no headers or column labels", () => {
    const p = getAppPolicy().policy.audits.profiles["before-after"]!;
    const issues = p.report.sections.find((x) => x.id === "issues")!;
    const it1 = item(1, { cohort: "after" });
    const issue = finding(it1, "issue", { area: "final_output", priority: "P1", issue: "Kept a refuted cause.", action: "Rewrite the summary.", owner: "memory", detail: "", evidence: [] });
    const t = findingsTable(issues, { ...inputs([issue]), profile: p });
    expect(t.columns.map((c) => c.header)).toEqual(["Priority", "Area", "Issue", "Action", "Owner"]);
    expect(t.rows[0]!.cells).toEqual(["P1: fix before relying on it", "Final output consistency", "Kept a refuted cause.", "Rewrite the summary.", "Memory or runbook content"]);
  });

  it("lists each incident with its score from the scorecard and its diagnosis", () => {
    const t = incidentList(section("incidents"), inputs([diagnosis(i10, { near_miss: "Named Redis at R40." }), diagnosis(i1), diagnosis(i2, {}, { state: "rejected" })], { evidence: { "INCIDENT-1": { score: "2/5", verdict: "Miss" }, "INCIDENT-10": { score: null } } }));
    expect(t.incidents.map((b) => b.incident)).toEqual(["INCIDENT-1", "INCIDENT-10"]);
    const [one, ten] = t.incidents;
    expect(one!.title).toBe("INCIDENT-1: Investigated the gateway instead of the cache.");
    expect(one!.evidence).toEqual([{ id: "score", label: "Score", value: "2/5" }]);
    expect(one!.fields.map((f) => [f.label, f.value])).toEqual([
      ["Primary failure mode", "Wrong component"],
      ["Decisive evidence", "Within reach"],
      ["Confirmed root cause", "Redis timeouts in the cache tier."],
      ["Agent's answer", "Blamed the gateway."],
    ]);
    expect(ten!.evidence).toEqual([]);
    expect(ten!.fields.at(-1)).toEqual({ id: "near_miss", label: "Near miss", value: "Named Redis at R40." });
  });
});

describe("metrics tables", () => {
  it("reads the latest run per item by dotted path, leaves skipped items out and marks missing runs", () => {
    const s: ReportSectionConfig = { ...section("run-metrics"), columns: ["span_min", "tools.search", "missing"] };
    const t = metricsTable(s, {
      ...inputs([]),
      analyzerRuns: {
        "task-1": { "run-metrics": { analyzer: "run-metrics", version: "1.2.0", output: { span_min: 25.44, tools: { search: 7 } }, createdAt: "2026-11-11T00:00:00.000Z" } },
        "task-3": { "run-metrics": { analyzer: "run-metrics", version: "1.2.0", output: { span_min: 1 }, createdAt: "2026-11-11T00:00:00.000Z" } },
        "task-10": { "condensed-trace": { analyzer: "condensed-trace", version: "1.0.0", output: {}, createdAt: "2026-11-11T00:00:00.000Z" } },
      },
    });
    expect(t.columns.map((c) => c.header)).toEqual(["Run span (min)", "tools.search", "missing"]);
    expect(t.rows).toEqual([
      { incident: "INCIDENT-1", taskId: "task-1", analyzerVersion: "1.2.0", cells: ["25.44", "7", null], missing: false },
      { incident: "INCIDENT-2", taskId: "task-2", analyzerVersion: null, cells: [null, null, null], missing: true },
      { incident: "INCIDENT-10", taskId: "task-10", analyzerVersion: null, cells: [null, null, null], missing: true },
    ]);
    expect(t.medians).toEqual(["25.44", "7", null]);
  });

  it("takes the median of the numbers in a column", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([null, "x", Number.NaN])).toBeNull();
  });
});
