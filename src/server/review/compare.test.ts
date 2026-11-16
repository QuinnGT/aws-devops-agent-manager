import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { benchmarkExpected } from "../../../test/helpers/fixtures";
import { checkCitations } from "./citations";
import { compareReviews, convertReferenceReview, formatComparisons, jaccard, loadReferenceReview, reviewFields, totalComparisons } from "./compare";
import { benchmarkBundle, benchmarkDirs, validBenchmarkOutput } from "./test-support";

const reference = {
  incident: "INCIDENT-1",
  summaries: [{ record: "R140", utc: "x", conclusion: "c", prompted_by: "initial run" }],
  scored_summary_record: "R167 (devops_journal findings = R167; its Root Cause Summary paragraph = R169)",
  timing: { incident_created_kst: "2026-10-19 00:48 PT (R2)", decisive_evidence_existed_at_run_time: "not determinable", note: "" },
  reachability: "partially_reachable",
  failure_modes: ["D_wrong_component", "F_premature_ruleout"],
  primary_failure_mode: "D_wrong_component",
  blocking_errors: [{ record: "R48, R55", error: "e", blocked: "b" }],
  scorecard_fair: "yes",
  fixes: [{ owner: "customer_memory", fix: "Add a memory entry (R59, R139)." }, { owner: "instructions", fix: "No records." }],
};

describe("convertReferenceReview", () => {
  it("turns record strings into numbers and fills the benchmark schema's new fields", () => {
    const c = convertReferenceReview(reference);
    expect(c.summaries).toEqual([{ record: 140, utc: "x", conclusion: "c", prompted_by: "initial run" }]);
    expect(c.scored_summary_record).toBe(167);
    expect(c.blocking_errors).toEqual([{ record: 48, error: "e", blocked: "b" }]);
    expect(c.timing).toEqual({ incident_created: "2026-10-19 00:48 PT (R2)", decisive_evidence_existed_at_run_time: "not_determinable", note: "" });
    expect(c.fixes).toEqual([
      { owner: "customer_memory", fix: "Add a memory entry (R59, R139).", evidence: [{ record: 59, quote: null }, { record: 139, quote: null }] },
      { owner: "instructions", fix: "No records.", evidence: [] },
    ]);
    expect(c.citations).toEqual([]);
    // The input is not changed
    expect(reference.summaries[0]!.record).toBe("R140");
  });

  it("maps 'not determinable' scored summaries to null", () => {
    expect(convertReferenceReview({ scored_summary_record: "not determinable" }).scored_summary_record).toBeNull();
  });
});

describe("compareReviews", () => {
  it("compares the named fields", () => {
    const app = { ...validBenchmarkOutput(), failure_modes: ["D_wrong_component", "E_symptom_stop"], reachability: "reachable" };
    const ref = convertReferenceReview(reference);
    const c = compareReviews("INCIDENT-1", app, ref, { app: { ok: true, checked: 4, failed: 0, citations: [] }, reference: null });
    expect(c.primaryFailureMode).toEqual({ app: "D_wrong_component", reference: "D_wrong_component", equal: true });
    expect(c.failureModes.jaccard).toBeCloseTo(1 / 3);
    expect(c.failureModes.shared).toEqual(["D_wrong_component"]);
    expect(c.reachability.equal).toBe(false);
    expect(c.scorecardFair.equal).toBe(true);
    expect(c.fixOwners).toEqual({ app: ["customer_memory"], reference: ["customer_memory", "instructions"], shared: ["customer_memory"], jaccard: 0.5 });
    expect(c.citations).toEqual({ app: { checked: 4, failed: 0, ok: true }, reference: null });

    const none = compareReviews("INCIDENT-2", null, ref);
    expect(none.comparable).toBe(false);
    expect(none.primaryFailureMode.equal).toBe(false);

    const t = totalComparisons([c, none]);
    expect(t).toMatchObject({ incidents: 2, comparable: 1, primaryFailureModeEqual: 1, reachabilityEqual: 0, scorecardFairEqual: 1, appCitationsChecked: 4 });
    expect(t.meanFixOwnerJaccard).toBe(0.5);
    const text = formatComparisons([c, none]);
    expect(text).toContain("INCIDENT-1\n  primary failure mode  same: app D_wrong_component, reference D_wrong_component");
    expect(text).toContain("INCIDENT-2 (no app output)");
    expect(text).toContain("primary failure mode equal  1/1 (100%)");
  });

  it("computes Jaccard overlap", () => {
    expect(jaccard([], [])).toBe(1);
    expect(jaccard(["a"], [])).toBe(0);
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
  });
});

describe("loadReferenceReview", () => {
  it("reads <incident>.json and refuses path-like incident IDs", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ref-"));
    writeFileSync(path.join(dir, "INCIDENT-1.json"), JSON.stringify(reference));
    expect(loadReferenceReview(dir, "INCIDENT-1")?.converted.scored_summary_record).toBe(167);
    expect(loadReferenceReview(dir, "INCIDENT-2")).toBeNull();
    expect(loadReferenceReview(dir, "../INCIDENT-1")).toBeNull();
    expect(loadReferenceReview(dir, "a/b")).toBeNull();
  });
});

const dirs = benchmarkDirs();

describe("the benchmark reviews as the reference set", () => {
  const incidents = readdirSync(dirs.reviews).filter((f) => /^INCIDENT-\d+\.json$/.test(f)).map((f) => f.replace(/\.json$/, "")).sort();

  it("has the reviews", () => {
    expect(incidents.length).toBeGreaterThan(0);
    const expected = benchmarkExpected();
    if (expected) expect(incidents).toEqual(expected.incidentIds);
  });

  it.each(incidents)("%s: converts, and compares equal with itself", (incident) => {
    const ref = loadReferenceReview(dirs.reviews, incident)!;
    const f = reviewFields(ref.converted);
    expect(f.primaryFailureMode).toMatch(/^[A-L]_/);
    expect(f.failureModes).toContain(f.primaryFailureMode);
    expect(f.reachability).toMatch(/^(reachable|partially_reachable|out_of_reach)$/);
    expect(f.scorecardFair).toMatch(/^(yes|mostly|no|not_applicable)$/);
    expect(f.fixOwners.length).toBeGreaterThan(0);
    const c = ref.converted as { summaries: { record: unknown }[]; scored_summary_record: unknown };
    for (const s of c.summaries) expect(Number.isInteger(s.record)).toBe(true);
    expect(c.scored_summary_record === null || Number.isInteger(c.scored_summary_record)).toBe(true);

    const check = checkCitations(ref.raw, benchmarkBundle(dirs.incidents, incident));
    const self = compareReviews(incident, ref.converted, ref.converted, { app: check, reference: check });
    expect(self.primaryFailureMode.equal && self.reachability.equal && self.scorecardFair.equal).toBe(true);
    expect(self.failureModes.jaccard).toBe(1);
    expect(self.fixOwners.jaccard).toBe(1);
    expect(self.citations.reference).toMatchObject({ ok: true, failed: 0 });
  });
});
