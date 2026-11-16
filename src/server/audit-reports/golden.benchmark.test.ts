import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BENCHMARK_AUDIT_DIR, benchmarkExpected } from "../../../test/helpers/fixtures";
import { renderReportHtml } from "./html";
import { countTable } from "./sections";
import { auditRecord, benchmarkProfile, benchmarkSchema } from "./test-support";
import type { ReportItem } from "./types";
import { buildReportView, reportInputs, type FindingRecord } from "./view";

/**
 * Golden check of the benchmark audit (sample-data/audit): with the reviews in
 * reviews/INCIDENT-*.json taken as accepted findings, the computed count tables
 * give the numbers in sample-data/expected/benchmark.json (`totals.reportCounts`).
 *
 * Always runs. DAM_BENCHMARK_AUDIT_DIR (see test/helpers/fixtures.ts) points it at another
 * audit folder in the same layout; its counts are checked against its own review files, because
 * the expected numbers belong to the sample set.
 */

const dir = BENCHMARK_AUDIT_DIR;
const expected = benchmarkExpected();

type Review = Record<string, unknown>;

describe("benchmark audit counts", () => {
  const profile = benchmarkProfile();
  const diagnosisFields = profile.findings.find((f) => f.kind === "diagnosis")!.fields;
  const reviews: Review[] = [];
  const items: ReportItem[] = [];
  const findings: FindingRecord[] = [];
  const files = readdirSync(path.join(dir, "reviews")).filter((f) => /^INCIDENT-\d+\.json$/.test(f)).sort();
  files.forEach((file, n) => {
    const review = JSON.parse(readFileSync(path.join(dir, "reviews", file), "utf8")) as Review;
    reviews.push(review);
    const incidentId = file.replace(/\.json$/, "");
    const id = `00000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`;
    const reviewId = `00000000-0000-4000-9000-${String(n + 1).padStart(12, "0")}`;
    items.push({ id, taskId: `task-${n + 1}`, incidentId, cohort: null, state: "reviewed", stateReason: null, journalSha256: null, currentReviewId: reviewId });
    const base = { auditItemId: id, reviewId, incidentId, citations: [], state: "accepted", edited: false, reviewedBy: null, reviewedAt: null };
    findings.push({ ...base, id: `${id}-d`, kind: "diagnosis", ordinal: 0, title: `${incidentId}: ${String(review.one_line)}`, current: Object.fromEntries(diagnosisFields.map((f) => [f, review[f]])) });
    ((review.fixes as Record<string, unknown>[]) ?? []).forEach((fx, i) => findings.push({ ...base, id: `${id}-f${i}`, kind: "fix", ordinal: i, title: String(fx.fix), current: fx }));
  });
  const input = { audit: auditRecord(), profile, items, findings, evidence: {}, analyzerRuns: {}, outputSchema: benchmarkSchema(), inputsChangedAt: null };
  const table = (id: string) => countTable(profile.report.sections.find((s) => s.id === id)!, reportInputs(input));
  /** Rows with a count, by the label a reader sees. */
  const byLabel = (id: string) => Object.fromEntries(table(id).rows.filter((r) => r.count > 0).map((r) => [r.label, r.count]));
  /** Rows with a count, by the stored value (a failure mode ID, an owner ID, ...). */
  const byValue = (id: string) => Object.fromEntries(table(id).rows.filter((r) => r.count > 0).map((r) => [String(r.value), r.count]));
  const tally = (values: unknown[]) => {
    const out: Record<string, number> = {};
    for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
    return out;
  };

  it("reads every review file", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(items).toHaveLength(files.length);
    if (expected) expect(items.map((i) => i.incidentId)).toEqual(expected.incidentIds);
  });

  it("counts the primary failure modes of the reviews", () => {
    expect(byValue("failure-modes")).toEqual(tally(reviews.map((r) => r.primary_failure_mode)));
    if (expected) expect(byLabel("failure-modes")).toEqual(expected.totals.reportCounts["failure-modes"]);
  });

  it("counts reachability and the scorecard check", () => {
    expect(byValue("reachability")).toEqual(tally(reviews.map((r) => r.reachability)));
    expect(byValue("scorecard-fairness")).toEqual(tally(reviews.map((r) => r.scorecard_fair)));
    if (expected) {
      expect(byLabel("reachability")).toEqual(expected.totals.reportCounts.reachability);
      expect(byLabel("scorecard-fairness")).toEqual(expected.totals.reportCounts["scorecard-fairness"]);
    }
  });

  it("counts the fixes by owner", () => {
    expect(byValue("fixes-by-owner")).toEqual(tally(reviews.flatMap((r) => ((r.fixes as { owner: unknown }[]) ?? []).map((f) => f.owner))));
    if (expected) expect(byValue("fixes-by-owner")).toEqual(expected.totals.reportCounts["fixes-by-owner-id"]);
  });

  it("renders both exports from the review text", () => {
    const view = buildReportView(input);
    for (const audience of ["internal", "shareable"] as const) {
      const { html } = renderReportHtml(view, audience, new Date("2026-11-13T00:00:00.000Z"));
      expect(html).not.toMatch(/<script|<[a-z][^>]*\s(?:src|href|on\w+)=/i);
      expect(html.match(/<article class="incident">/g)).toHaveLength(items.length);
    }
  });
});
