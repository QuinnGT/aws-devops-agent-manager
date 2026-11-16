import { describe, expect, it } from "vitest";
import { extractIncidentIdLocal, matchIncidentId } from "./incident-id";
import { classifyZipFile, globToRegExp, isExportZip } from "./import";
import { buildExecutionTree } from "./queries";
import { dateRange, exportSelectionSchema, planListCalls, splitIds } from "./selection";
import { getAppPolicy } from "@/server/policy";

describe("export selection", () => {
  it("validates modes and IDs", () => {
    expect(exportSelectionSchema.safeParse({ mode: "taskIds", taskIds: [] }).success).toBe(false);
    expect(exportSelectionSchema.safeParse({ mode: "incidentIds", incidentIds: ["INCIDENT-1"] }).success).toBe(true);
    expect(exportSelectionSchema.safeParse({ statuses: ["completed"] }).success).toBe(false);
    expect(exportSelectionSchema.safeParse({ from: "2026-10-02", to: "2026-10-01" }).success).toBe(false);
    expect(exportSelectionSchema.safeParse({ taskIds: ["a b"] }).success).toBe(false);
  });

  it("treats a plain end date as the end of that day", () => {
    expect(dateRange({ from: "2026-10-01", to: "2026-10-01" })).toEqual({ createdAfter: new Date("2026-10-01T00:00:00Z"), createdBefore: new Date("2026-10-02T00:00:00Z") });
  });

  it("plans one call per combination of single values", () => {
    const p = planListCalls(exportSelectionSchema.parse({ taskTypes: ["INVESTIGATION", "EVALUATION"], statuses: ["COMPLETED"], priorities: ["HIGH", "LOW"] }));
    expect(p.filters).toHaveLength(4);
    expect(p.clientPriorities).toBeNull();
    expect(p.filters[0]).toEqual({ taskType: ["INVESTIGATION"], status: ["COMPLETED"], priority: ["HIGH"] });
    expect(planListCalls(exportSelectionSchema.parse({})).filters).toEqual([{}]);
  });

  it("splits pasted ID lists", () => {
    expect(splitIds("a, b\nc  a\r\n")).toEqual(["a", "b", "c"]);
  });
});

describe("incident IDs", () => {
  it("uses the named group, then the first group, then the match", () => {
    expect(matchIncidentId("x INCIDENT-12 y", "(?<id>INCIDENT-\\d+)")).toBe("INCIDENT-12");
    expect(matchIncidentId("x INCIDENT-12 y", "INCIDENT-(\\d+)")).toBe("12");
    expect(matchIncidentId("x INCIDENT-12 y", "INCIDENT-\\d+")).toBe("INCIDENT-12");
    expect(matchIncidentId("x", "(")).toBeNull();
  });

  it("reads the configured task field", () => {
    const task = { title: "t", description: "INCIDENT-3", reference: { referenceId: "INC-9", title: "INCIDENT-4" } };
    expect(extractIncidentIdLocal(task, { regex: "(INCIDENT-\\d+)", field: "description" })).toBe("INCIDENT-3");
    expect(extractIncidentIdLocal(task, { regex: "(INC-\\d+)", field: "reference.referenceId" })).toBe("INC-9");
    expect(extractIncidentIdLocal(task, { regex: "(INCIDENT-\\d+)", field: "reference.title" })).toBe("INCIDENT-4");
    expect(extractIncidentIdLocal(task, null)).toBeNull();
  });
});

describe("import file classification", () => {
  const pol = getAppPolicy().policy.journals.import;
  it("sorts a benchmark folder layout into journals, ground truth and other files", () => {
    expect(classifyZipFile("benchmark_incidents/INCIDENT-20101/INCIDENT-20101_full_journal.md", pol)).toBe("journal");
    expect(classifyZipFile("benchmark_incidents/INCIDENT-20101/20101_actual_rca.md", pol)).toBe("ground-truth");
    expect(classifyZipFile("benchmark_incidents/INCIDENT-20101/INCIDENT-20101_scorecard.md", pol)).toBe("ground-truth");
    expect(classifyZipFile("benchmark_incidents/INCIDENT-20101/INCIDENT-20101_devops_journal.md", pol)).toBe("ignored");
    expect(classifyZipFile("journal-logs/INCIDENT-20201-journal.md", pol)).toBe("journal");
    expect(classifyZipFile("__MACOSX/x/._INCIDENT-1-journal.md", pol)).toBe("ignored");
  });

  it("matches globs on whole names", () => {
    expect(globToRegExp("*_full_journal.md").test("a_full_journal.md")).toBe(true);
    expect(globToRegExp("*_full_journal.md").test("a_full_journal.md.bak")).toBe(false);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });

  it("recognizes this app's export zips", () => {
    expect(isExportZip(["manifest.csv", "raw/INCIDENT-1.json", "markdown/INCIDENT-1-journal.md"])).toBe(true);
    expect(isExportZip(["INCIDENT-1/INCIDENT-1_full_journal.md"])).toBe(false);
  });
});

describe("execution tree", () => {
  const e = (id: string, parent: string | null) => ({ executionId: id, taskId: "t", parentExecutionId: parent, agentType: null, agentSubTask: null, status: null, createdAt: null, updatedAt: null, raw: null });
  it("nests children and keeps orphans and cycles at the top level", () => {
    const tree = buildExecutionTree([e("root", null), e("child", "root"), e("grand", "child"), e("orphan", "gone"), e("c1", "c2"), e("c2", "c1")]);
    expect(tree.map((n) => n.execution.executionId)).toEqual(["root", "orphan", "c1", "c2"]);
    expect(tree[0]?.children[0]?.children[0]?.execution.executionId).toBe("grand");
  });
});
