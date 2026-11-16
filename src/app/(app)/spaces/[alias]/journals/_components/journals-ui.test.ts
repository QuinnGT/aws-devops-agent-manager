import { describe, expect, it } from "vitest";
import {
  createdLabel,
  createdRange,
  EMPTY_FILTERS,
  filterHref,
  filterQuery,
  formatDay,
  isFiltered,
  nextDay,
  parseInvestigationFilters,
  validDay,
  zonedDayStart,
} from "./filters";
import { enumLabel, exportFileState, importOutcome, importSummary, jobStatus, taskStatus } from "./words";
import { fmtMetric, toAnalysisRow } from "../../analysis/rows";

describe("investigation filters in the URL", () => {
  it("parses comma lists, drops unknown values and keeps old single-value links working", () => {
    const f = parseInvestigationFilters({
      q: "  INCIDENT-31744 ",
      status: "COMPLETED,FAILED,completed,COMPLETED",
      taskType: "SYSTEM_LEARNING",
      source: "import,bogus",
      from: "2026-10-01",
      to: "2026-02-30",
      page: "3",
    });
    expect(f).toEqual({ q: "INCIDENT-31744", statuses: ["COMPLETED", "FAILED"], taskTypes: ["SYSTEM_LEARNING"], sources: ["import"], from: "2026-10-01", to: null, page: 3 });
    expect(parseInvestigationFilters({ status: "COMPLETED", source: "api" })).toMatchObject({ statuses: ["COMPLETED"], sources: ["api"], page: 1 });
  });

  it("takes the first value of a repeated param and bounds the page", () => {
    expect(parseInvestigationFilters({ status: ["FAILED", "COMPLETED"], page: ["0"] })).toMatchObject({ statuses: ["FAILED"], page: 1 });
    expect(parseInvestigationFilters({ page: "abc" }).page).toBe(1);
    expect(parseInvestigationFilters({ page: "100001" }).page).toBe(1);
    expect(parseInvestigationFilters({ q: "x".repeat(300) }).q).toHaveLength(200);
  });

  it("writes the state back to a query string and resets the page on a filter change", () => {
    const f = { ...EMPTY_FILTERS, statuses: ["COMPLETED", "FAILED"], sources: ["import" as const], q: "a b", page: 2 };
    expect(filterQuery(f)).toBe("q=a+b&status=COMPLETED%2CFAILED&source=import&page=2");
    expect(parseInvestigationFilters(Object.fromEntries(new URLSearchParams(filterQuery(f))))).toEqual(f);
    expect(filterHref("/j", f, { taskTypes: ["SYSTEM_LEARNING"] })).toBe("/j?q=a+b&status=COMPLETED%2CFAILED&taskType=SYSTEM_LEARNING&source=import");
    expect(filterHref("/j", f, { page: 3 })).toContain("page=3");
    expect(filterHref("/j", EMPTY_FILTERS)).toBe("/j");
    expect(isFiltered(EMPTY_FILTERS)).toBe(false);
    expect(isFiltered({ ...EMPTY_FILTERS, page: 4 })).toBe(false);
    expect(isFiltered({ ...EMPTY_FILTERS, to: "2026-10-31" })).toBe(true);
  });

  it("checks calendar days", () => {
    expect(validDay("2026-02-28")).toBe("2026-02-28");
    expect(validDay("2026-02-29")).toBeNull();
    expect(validDay("2028-02-29")).toBe("2028-02-29");
    expect(validDay("2026-1-01")).toBeNull();
    expect(validDay(null)).toBeNull();
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });
});

describe("created range in the viewer's time zone", () => {
  it("starts each day at local midnight, across DST changes", () => {
    expect(zonedDayStart("2026-10-23", "UTC").toISOString()).toBe("2026-10-23T00:00:00.000Z");
    expect(zonedDayStart("2026-10-23", "America/Los_Angeles").toISOString()).toBe("2026-10-23T07:00:00.000Z");
    expect(zonedDayStart("2026-11-12", "America/Los_Angeles").toISOString()).toBe("2026-11-12T08:00:00.000Z");
    // DST ends in Los Angeles on 2026-11-01 at 2:00 local; that day still starts at 07:00 UTC.
    expect(zonedDayStart("2026-11-01", "America/Los_Angeles").toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(zonedDayStart("2026-03-08", "America/Los_Angeles").toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(zonedDayStart("2026-10-23", "Asia/Tokyo").toISOString()).toBe("2026-10-22T15:00:00.000Z");
  });

  it("runs from the start of `from` to the end of `to`", () => {
    expect(createdRange({ from: "2026-10-01", to: "2026-10-31" }, "Asia/Tokyo")).toEqual({
      createdFrom: new Date("2026-09-30T15:00:00Z"),
      createdBefore: new Date("2026-10-31T15:00:00Z"),
    });
    expect(createdRange({ from: null, to: null }, "UTC")).toEqual({});
  });

  it("labels the range for the toolbar", () => {
    const now = new Date("2026-11-12T09:00:00Z");
    expect(createdLabel(null, null, now)).toBe("Created: Any time");
    expect(createdLabel("2026-10-01", "2026-10-31", now)).toBe("Created: Oct 1 to Oct 31");
    expect(createdLabel("2026-10-01", "2026-10-01", now)).toBe("Created: Oct 1");
    expect(createdLabel("2025-12-30", null, now)).toBe("Created: from Dec 30, 2025");
    expect(createdLabel(null, "2026-10-31", now)).toBe("Created: until Oct 31");
    expect(formatDay("2027-01-02", now)).toBe("Jan 2, 2027");
  });
});

describe("journal words", () => {
  it("turns API enums and agent types into sentence case", () => {
    expect(enumLabel("SYSTEM_LEARNING")).toBe("System learning");
    expect(enumLabel("PENDING_CUSTOMER_APPROVAL")).toBe("Pending customer approval");
    expect(enumLabel("systemLearning")).toBe("System learning");
    expect(enumLabel("export-zip")).toBe("Export zip");
    expect(enumLabel("")).toBe("");
  });

  it("maps statuses to one tone, icon and word each", () => {
    expect(taskStatus("COMPLETED")).toMatchObject({ tone: "success", label: "Completed" });
    expect(taskStatus("TIMED_OUT")).toMatchObject({ tone: "destructive", label: "Timed out" });
    expect(taskStatus("IN_PROGRESS")).toMatchObject({ tone: "info", label: "In progress" });
    expect(taskStatus("PENDING_TRIAGE")).toMatchObject({ tone: "warning", label: "Pending triage" });
    expect(taskStatus("STOPPED")).toEqual({ tone: "neutral", label: "Stopped" });
    expect(taskStatus(null)).toEqual({ tone: "neutral", label: "Not set" });
    expect(jobStatus("running")).toMatchObject({ tone: "info", label: "Running" });
    expect(jobStatus("duplicate")).toMatchObject({ tone: "neutral", label: "Already imported" });
    expect(jobStatus("partial")).toMatchObject({ tone: "warning", label: "Partly imported" });
    expect(jobStatus("something_new")).toEqual({ tone: "neutral", label: "Something new" });
    expect(importOutcome("ground-truth")).toMatchObject({ tone: "info", label: "Ground truth, not imported" });
    expect(importOutcome("later")).toEqual({ tone: "neutral", label: "Later" });
    // Every status the UI names carries an icon or is neutral text; none relies on color alone.
    for (const s of [taskStatus("FAILED"), jobStatus("failed"), importOutcome("failed")]) expect(s.icon).toBeDefined();
  });

  it("summarizes an import report without zero counts", () => {
    expect(importSummary({ imported: 1, alreadyCached: 0, groundTruth: 0, ignored: 0, failed: 0, records: 62 })).toBe("1 imported. 62 records added.");
    expect(importSummary({ imported: 0, alreadyCached: 10, groundTruth: 1, ignored: 2, failed: 1, records: 1 })).toBe(
      "10 already cached, 1 ground truth file listed, 2 ignored, 1 failed. 1 record added.",
    );
    expect(importSummary({ imported: 0, alreadyCached: 0, groundTruth: 0, ignored: 0, failed: 0, records: 0 })).toBe("No journal files found. 0 records added.");
  });

  it("offers an export zip only while it is kept", () => {
    const now = new Date("2026-11-12T00:00:00Z");
    const ok = { status: "succeeded", fileName: "a.zip", fileDeletedAt: null, expiresAt: new Date("2026-11-26T00:00:00Z") };
    expect(exportFileState(ok, now)).toBe("download");
    expect(exportFileState({ ...ok, expiresAt: new Date("2026-11-11T00:00:00Z") }, now)).toBe("expired");
    expect(exportFileState({ ...ok, fileDeletedAt: now }, now)).toBe("deleted");
    expect(exportFileState({ ...ok, status: "expired" }, now)).toBe("deleted");
    expect(exportFileState({ ...ok, fileName: null }, now)).toBe("none");
    expect(exportFileState({ ...ok, status: "running" }, now)).toBe("none");
  });
});

describe("analysis table rows", () => {
  const base = "/spaces/demo/analysis";
  it("reads the latest run metrics into columns", () => {
    const row = toAnalysisRow(
      {
        taskId: "t/1",
        incidentId: "INCIDENT-1",
        title: "Disk full",
        source: "api",
        records: 113,
        metrics: { span_min: 10.66, first_summary_min: 3, tool_calls_lead: 30, subagents: ["a", "b"], max_ctx_pct: 41.25, err_signal_msgs: { http_401: 2, http_500: 9 } },
        metricsAt: new Date("2026-11-12T00:00:00Z"),
      },
      base,
    );
    expect(row).toMatchObject({ href: "/spaces/demo/analysis/t%2F1", name: "INCIDENT-1", nameIsTaskId: false, spanMin: 10.66, subagents: 2, authErrorSignals: 2, analyzed: true });
    expect(fmtMetric(row.spanMin)).toBe("10.7");
    expect(fmtMetric(row.leadToolCalls)).toBe("30");
    expect(fmtMetric(null)).toBe("");
  });

  it("leaves columns empty for an investigation never analyzed or with odd metrics", () => {
    const row = toAnalysisRow({ taskId: "t2", incidentId: null, title: null, source: "import", records: 0, metrics: null, metricsAt: null }, base);
    expect(row).toMatchObject({ name: "t2", nameIsTaskId: true, title: "", spanMin: null, subagents: null, authErrorSignals: null, analyzed: false });
    const odd = toAnalysisRow(
      { taskId: "t3", incidentId: null, title: null, source: "api", records: 1, metrics: { span_min: "12", err_signal_msgs: "x", subagents: 3 }, metricsAt: new Date() },
      base,
    );
    expect(odd).toMatchObject({ spanMin: null, authErrorSignals: null, subagents: null });
  });
});
