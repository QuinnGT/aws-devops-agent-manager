import { describe, expect, it } from "vitest";
import { citationsLine, flowStrip, type FlowInput } from "./flow";

const items = (o: Partial<Record<"pending" | "analyzing" | "reviewing" | "reviewed" | "failed" | "skipped", number>> = {}) => ({ pending: 0, analyzing: 0, reviewing: 0, reviewed: 0, failed: 0, skipped: 0, ...o });
const base = (over: Partial<FlowInput> = {}): FlowInput => ({
  state: "reviewing",
  items: items({ reviewed: 1 }),
  citations: { checked: 85, failed: 0 },
  findings: { proposed: 3, accepted: 1, rejected: 0, total: 4 },
  fix: { total: 2, inRevision: 0 },
  report: { built: false, sections: 7 },
  commit: null,
  ...over,
});
const cell = (i: FlowInput, step: string) => flowStrip(i).cells.find((c) => c.step === step)!;

describe("the flow strip", () => {
  it("has the five steps in order", () => {
    expect(flowStrip(base()).cells.map((c) => c.label)).toEqual(["Reviews", "Decide", "Fix in a revision", "Report", "Record"]);
  });

  it("says how many reviews finished and the citations, as the mockup does", () => {
    const c = cell(base(), "reviews");
    expect(c.value).toEqual({ strong: null, rest: "1 of 1 reviewed" });
    expect(c.detail).toBe("85 citations passed");
    expect(c.done).toBe(true);
    expect(c.tone).toBe("normal");
  });

  it("warns about failed reviews and failed citations", () => {
    const c = cell(base({ items: items({ reviewed: 2, failed: 1 }), citations: { checked: 88, failed: 3 } }), "reviews");
    expect(c.detail).toBe("1 failed · 3 of 88 citations failed the check");
    expect(c.tone).toBe("warning");
    expect(c.done).toBe(false);
  });

  it("counts what is left to decide and what is accepted", () => {
    expect(cell(base(), "decide").value).toEqual({ strong: "3 to decide", rest: " · 1 accepted" });
    const done = cell(base({ findings: { proposed: 0, accepted: 4, rejected: 0, total: 4 } }), "decide");
    expect(done.value).toEqual({ strong: "All decided", rest: " · 4 accepted" });
    expect(done.done).toBe(true);
    expect(cell(base({ findings: { proposed: 0, accepted: 0, rejected: 0, total: 0 } }), "decide").value.rest).toBe("No findings yet");
  });

  it("counts the accepted package fixes that are in a revision", () => {
    expect(cell(base(), "fix").value.rest).toBe("0 of 2 package fixes");
    expect(cell(base({ fix: { total: 1, inRevision: 1 } }), "fix")).toMatchObject({ value: { rest: "1 of 1 package fix" }, done: true });
    expect(cell(base({ fix: { total: 0, inRevision: 0 } }), "fix")).toMatchObject({ value: { rest: "No package fixes" }, done: true });
    expect(cell(base({ fix: { total: 3, inRevision: null } }), "fix")).toMatchObject({ value: { rest: "3 accepted package fixes" }, done: true });
  });

  it("says whether the report is built and how many sections it has", () => {
    expect(cell(base(), "report").value.rest).toBe("Not built");
    expect(cell(base({ report: { built: true, sections: 7 } }), "report")).toMatchObject({ value: { rest: "Built · 7 sections" }, done: true });
  });

  it("says whether the record is saved, with the short commit", () => {
    expect(cell(base(), "record").value.rest).toBe("Not saved");
    expect(cell(base({ commit: "5e1c2a90cafe0000" }), "record")).toMatchObject({ value: { rest: "Saved · 5e1c2a9" }, done: true });
  });

  it("marks the first step that isn't done as the current one", () => {
    expect(flowStrip(base()).current).toBe("decide");
    const decided = { findings: { proposed: 0, accepted: 4, rejected: 0, total: 4 } };
    expect(flowStrip(base(decided)).current).toBe("fix");
    expect(flowStrip(base({ ...decided, fix: { total: 2, inRevision: 2 } })).current).toBe("report");
    expect(flowStrip(base({ ...decided, fix: { total: 0, inRevision: 0 } })).current).toBe("report");
    expect(flowStrip(base({ ...decided, fix: { total: 2, inRevision: 2 }, report: { built: true, sections: 7 } })).current).toBe("record");
    expect(flowStrip(base({ ...decided, fix: { total: 2, inRevision: 2 }, report: { built: true, sections: 7 }, commit: "abc1234" })).current).toBe("record");
  });

  it("is at the record once it is saved, whatever else is left", () => {
    expect(flowStrip(base({ commit: "5e1c2a90cafe0000", fix: { total: 3, inRevision: 2 } })).current).toBe("record");
  });

  it("stays on the reviews while the audit runs, and has no current step once cancelled", () => {
    expect(flowStrip(base({ state: "running", items: items({ reviewing: 1, reviewed: 1 }) })).current).toBe("reviews");
    expect(flowStrip(base({ state: "cancelled" })).current).toBeNull();
  });
});

describe("the citations line", () => {
  it("is empty before any citation was checked", () => {
    expect(citationsLine({ checked: 0, failed: 0 })).toBeNull();
    expect(citationsLine({ checked: 1, failed: 0 })).toBe("1 citation passed");
    expect(citationsLine({ checked: 2, failed: 1 })).toBe("1 of 2 citations failed the check");
  });
});
