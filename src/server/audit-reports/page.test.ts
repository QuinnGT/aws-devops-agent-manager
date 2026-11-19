import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { permissionsForRole } from "@/server/auth/roles";
import { REPORT_PERMISSIONS } from "./index";
import { NO_REPORT_MODEL_REASON, noReportModelReason, reportModelOf } from "./model";
import { audienceSummaries, sectionDraftInfo, type DraftEvent, type ReportJobRun } from "./page";
import { DRAFT_NARRATIVE_QUEUE, FINALIZE_QUEUE } from "./jobs";
import { auditRecord, benchmarkProfile, diagnosis, fix, item, viewInput } from "./test-support";
import { buildReportView, finalizeIssues, finalizeProblems } from "./view";

const t = (iso: string) => new Date(`2026-11-12T${iso}:00.000Z`);

describe("report permissions", () => {
  const { policy } = getAppPolicy();
  it("lets a Viewer read and export the report but not change it", () => {
    const viewer = permissionsForRole(policy, "viewer");
    expect(REPORT_PERMISSIONS.export).toBe("audits.read");
    expect(viewer.has(REPORT_PERMISSIONS.read)).toBe(true);
    expect(viewer.has(REPORT_PERMISSIONS.export)).toBe(true);
    for (const p of [REPORT_PERMISSIONS.build, REPORT_PERMISSIONS.edit, REPORT_PERMISSIONS.draftNarrative, REPORT_PERMISSIONS.finalize]) expect(viewer.has(p)).toBe(false);
  });
  it("lets an Editor do every report action", () => {
    const editor = permissionsForRole(policy, "editor");
    for (const p of Object.values(REPORT_PERMISSIONS)) expect(editor.has(p)).toBe(true);
  });
});

describe("reportModelOf", () => {
  const snap = (review?: string, report?: string) => ({ review: { ...benchmarkProfile().review, modelId: review }, report: { ...benchmarkProfile().report, modelId: report } });
  const settings = (report: string | null) => ({ inference: { mode: "space" as const, region: null, reviewModelId: "space-review", reportModelId: report } });

  it("names the report model and where it came from", () => {
    expect(reportModelOf(snap("r1"), settings(null), null)).toEqual({ id: "r1", source: "review-model", sourceLabel: "Same as the review model" });
    expect(reportModelOf(snap("r1", "sr"), settings("sr"), null)).toMatchObject({ id: "sr", source: "space", sourceLabel: "Space default" });
    expect(reportModelOf(snap("r1", "pr"), settings(null), { report: { ...benchmarkProfile().report, modelId: "pr" } })).toMatchObject({ id: "pr", source: "policy" });
    expect(reportModelOf(snap("r1", "ar"), settings("sr"), null)).toMatchObject({ id: "ar", source: "audit", sourceLabel: "Chosen for this audit" });
  });

  it("says when no model resolves", () => {
    expect(reportModelOf(snap(), settings(null), null)).toEqual({ id: null, source: null, sourceLabel: null });
    expect(NO_REPORT_MODEL_REASON).toContain("Space settings");
  });
});

describe("the report model of an audit whose reviews use no Bedrock model", () => {
  const snap = (report?: string) => ({ review: { ...benchmarkProfile().review, runner: "handoff" as const, modelId: undefined }, report: { ...benchmarkProfile().report, modelId: report } });
  const settings = { inference: { mode: "space" as const, region: null, reviewModelId: "space-review", reportModelId: null } };

  it("has no report model unless one was chosen on the draft, and says what to do", () => {
    expect(reportModelOf(snap(), settings, null).id).toBeNull();
    expect(reportModelOf(snap("chosen"), settings, null)).toMatchObject({ id: "chosen", source: "audit" });
    expect(noReportModelReason("ai-sdk")).toBe(NO_REPORT_MODEL_REASON);
    for (const runner of ["handoff", "devops-agent-chat"]) {
      const text = noReportModelReason(runner);
      expect(text).toContain("Write each narrative section yourself with Edit");
      expect(text).not.toContain("\u2014");
    }
  });
});

describe("finalizeIssues", () => {
  it("lists open investigations and undecided findings with their counts", () => {
    const a = item(1);
    const b = item(2, { state: "failed", currentReviewId: null });
    const issues = finalizeIssues({ state: "reviewing" }, [a, b], [diagnosis(a, {}, { state: "proposed" }), fix(a, 0, {}, { state: "proposed" }), fix(a, 1, {}, { state: "rejected" })]);
    expect(issues.map((i) => [i.code, i.count])).toEqual([
      ["items-open", 1],
      ["proposed", 2],
    ]);
    expect(issues[0]!.incidents).toEqual(["INCIDENT-2"]);
    expect(finalizeProblems({ state: "reviewing" }, [a, b], [])).toEqual([issues[0]!.message]);
    expect(finalizeIssues({ state: "finalized" }, [a], [])).toMatchObject([{ code: "finalized" }]);
  });

  it("is in the view next to the plain messages", () => {
    const a = item(1);
    const view = buildReportView(viewInput({ items: [a], findings: [diagnosis(a, {}, { state: "proposed" })] }));
    expect(view.finalize).toMatchObject({ allowed: false, problems: ["1 finding is still proposed. Accept or reject each one first."], issues: [{ code: "proposed", count: 1 }] });
  });
});

describe("audienceSummaries", () => {
  it("counts what each export includes and leaves out", () => {
    const a = item(1);
    const view = buildReportView(
      viewInput({
        audit: auditRecord({ report: { builtAt: t("10:00").toISOString(), sections: [{ id: "scorecard-fairness", hidden: true }] } }),
        items: [a],
        findings: [diagnosis(a), fix(a, 0)],
      }),
    );
    const s = audienceSummaries(view);
    // Summary has no text, so it is left out of both; Run metrics is internal; Scorecard fairness is hidden.
    expect(s.shareable).toEqual({ sections: 5, internalLeftOut: ["Run metrics"], emptyLeftOut: ["Summary"] });
    expect(s.internal).toEqual({ sections: 6, internalLeftOut: [], emptyLeftOut: ["Summary"] });
  });
});

describe("sectionDraftInfo", () => {
  const sections = [
    { id: "summary", kind: "narrative" as const, updatedAt: t("10:00").toISOString() },
    { id: "failure-modes", kind: "count-table" as const, updatedAt: null },
  ];
  const ev = (at: Date, over: Partial<DraftEvent> = {}): DraftEvent => ({ at, result: "ok", drafted: [], failed: [], modelId: "m1", ...over });
  const job = (over: Partial<ReportJobRun>): ReportJobRun => ({ id: "j1", queue: DRAFT_NARRATIVE_QUEUE, status: "succeeded", sectionIds: ["summary"], error: null, createdAt: t("09:00"), finishedAt: t("09:01"), ...over });

  it("finds the latest landed draft and an open job, for narrative sections only", () => {
    const info = sectionDraftInfo(sections, [ev(t("09:30"), { drafted: ["summary"] }), ev(t("08:00"), { drafted: ["summary"], modelId: "old" })], [job({ id: "open", status: "running", createdAt: t("10:05"), finishedAt: null, sectionIds: [] })]);
    expect(Object.keys(info)).toEqual(["summary"]);
    expect(info.summary).toEqual({ drafted: { at: t("09:30").toISOString(), modelId: "m1" }, failed: null, runId: "open" });
  });

  it("shows a failure only when it is newer than the text", () => {
    const failedEvent = ev(t("10:30"), { result: "error", failed: [{ id: "summary", error: "The model timed out." }] });
    expect(sectionDraftInfo(sections, [failedEvent], []).summary!.failed).toEqual({ at: t("10:30").toISOString(), error: "The model timed out." });
    const older = ev(t("09:30"), { result: "error", failed: [{ id: "summary", error: "Old." }] });
    expect(sectionDraftInfo(sections, [older], []).summary!.failed).toBeNull();
  });

  it("counts a job that failed before recording its event", () => {
    const failedJob = job({ status: "failed", createdAt: t("11:00"), finishedAt: t("11:00"), error: "No model is set for this audit's report." });
    expect(sectionDraftInfo(sections, [], [failedJob]).summary!.failed).toEqual({ at: t("11:00").toISOString(), error: "No model is set for this audit's report." });
    // A finalize job never targets a section.
    expect(sectionDraftInfo(sections, [], [{ ...failedJob, queue: FINALIZE_QUEUE }]).summary!.failed).toBeNull();
    // When the handler recorded an event after the job started, the event's per-section result wins.
    expect(sectionDraftInfo(sections, [ev(t("11:00"), { drafted: ["summary"] })], [failedJob]).summary!.failed).toBeNull();
  });
});
