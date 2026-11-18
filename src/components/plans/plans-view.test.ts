import { describe, expect, it } from "vitest";
import { diffText } from "@/server/assets/diff";
import { diffRows, diffTotals, wordRows } from "./diff-rows";
import { hasFilters, ORIGIN_OPTIONS, parsePlanListParams, PLAN_PAGE, planListQuery } from "./list-params";
import { formatSize, sizeMeterText } from "./size-meter-line";
import { COLLAPSED_GROUPS, DIFF_CHECK_FAILED, DIFF_NOT_READY, defaultPlanTitle, groupPlanItems, draftChangeWord, itemChangeWord, planStateBadge, reasonEditable, reasonLockedText, skipTileDetail, SYNCED_COMPARISON_NOTE, SYNCED_COUNT_NOTE, SYNCED_VALIDATION_NOTE, validationSpec } from "./words";

describe("plan list URL state", () => {
  it("defaults to open plans from every origin", () => {
    expect(parsePlanListParams({})).toEqual({ status: "open", origin: "all", q: "", show: PLAN_PAGE });
    expect(planListQuery(parsePlanListParams({}))).toBe("");
  });

  it("reads and writes each filter, and ignores unknown values", () => {
    const p = parsePlanListParams({ status: "closed", origin: "rollback", q: "  verity ", show: "120" });
    expect(p).toEqual({ status: "closed", origin: "rollback", q: "verity", show: 150 });
    expect(planListQuery(p)).toBe("?status=closed&origin=rollback&q=verity&show=150");
    expect(parsePlanListParams({ status: "nope", origin: ["x"], show: "-3" })).toEqual({ status: "open", origin: "all", q: "", show: PLAN_PAGE });
    expect(parsePlanListParams({ show: "100000" }).show).toBe(500);
  });

  it("counts origin and title as filters, but not the status", () => {
    expect(hasFilters(parsePlanListParams({ status: "all" }))).toBe(false);
    expect(hasFilters(parsePlanListParams({ q: "x" }))).toBe(true);
    expect(hasFilters(parsePlanListParams({ origin: "package" }))).toBe(true);
  });
});

describe("plan words", () => {
  it("maps plan states to the plan-review.md badges", () => {
    expect(planStateBadge("waiting")).toMatchObject({ tone: "warning", label: "Waiting for approval" });
    expect(planStateBadge("checking")).toMatchObject({ tone: "info", label: "Checking" });
    expect(planStateBadge("failed")).toMatchObject({ tone: "destructive", label: "Failed" });
    expect(planStateBadge("discarded")).toMatchObject({ tone: "neutral", icon: undefined });
  });

  it("says Check failed instead of Ready on an open plan whose live-space check failed", () => {
    expect(planStateBadge("ready", true)).toMatchObject({ tone: "destructive", label: "Check failed" });
    expect(planStateBadge("waiting", true).label).toBe("Check failed");
    expect(planStateBadge("applied", true).label).toBe("Applied");
    expect(planStateBadge("ready")).toMatchObject({ tone: "success", label: "Ready" });
    expect(SYNCED_COMPARISON_NOTE).toBe("The live space could not be read, so this compares with the last synced version.");
    expect(SYNCED_COUNT_NOTE).toBe("vs last synced version");
    expect(SYNCED_VALIDATION_NOTE).toBe("checked against the last synced version");
  });

  it("says Validation failed on an open plan with a validation error, once the check is done", () => {
    expect(planStateBadge("ready", false, true)).toMatchObject({ tone: "destructive", label: "Validation failed" });
    expect(planStateBadge("waiting", false, true).label).toBe("Validation failed");
    expect(planStateBadge("checking", false, true).label).toBe("Checking");
    expect(planStateBadge("ready", true, true).label).toBe("Check failed");
    expect(planStateBadge("applied", false, true).label).toBe("Applied");
  });

  it("maps item changes to the MASTER plan-item words", () => {
    expect(itemChangeWord("content")).toEqual({ word: "update-content" });
    expect(itemChangeWord("status", { status: "INACTIVE" })).toEqual({ word: "set-inactive" });
    expect(itemChangeWord("status", { status: "ACTIVE" })).toEqual({ word: "set-active" });
    expect(itemChangeWord("content", { skipped: true })).toEqual({ word: "skip-live-changed" });
    expect(itemChangeWord("delete")).toEqual({ word: "delete", label: "Delete (snapshot taken first)" });
    expect(itemChangeWord("metadata").label).toBe("Update metadata");
    expect(itemChangeWord("none")).toEqual({ word: "no-change" });
    expect(draftChangeWord({ kind: "status", status: "INACTIVE" })).toEqual({ word: "set-inactive" });
  });

  it("puts errors before warnings in a validation badge", () => {
    expect(validationSpec({ status: "failed", errors: 2, warnings: 1 }).label).toBe("2 errors");
    expect(validationSpec({ status: "warnings", errors: 0, warnings: 1 }).label).toBe("1 warning");
    expect(validationSpec({ status: "passed", errors: 0, warnings: 0 }).label).toBe("Passed");
    expect(validationSpec({ status: null, errors: 0, warnings: 0 }).label).toBe("Not checked");
  });

  it("lets whoever can apply type the reason before Apply unlocks, and says why it is read only otherwise", () => {
    const apply = (enabled: boolean) => ({ action: "apply" as const, label: "Apply 1 change", enabled, disabledReason: enabled ? null : "x" });
    const request = (enabled: boolean) => ({ action: "request-approval" as const, label: "Request approval", enabled, disabledReason: enabled ? null : "x" });
    const viewer = "Only Publishers and Admins can apply plans. You're a Viewer.";
    expect(reasonLockedText({ canEditReason: true, canApply: true, primary: apply(true) }, "ready")).toBeNull();
    // A publisher types it while the check runs or after it failed; it is sent with Apply.
    expect(reasonLockedText({ canEditReason: true, canApply: true, primary: apply(false) }, "checking")).toBeNull();
    expect(reasonLockedText({ canEditReason: true, canApply: true, primary: apply(false) }, "ready")).toBeNull();
    expect(reasonEditable({ canEditReason: true, canApply: true, primary: apply(false) })).toBe(true);
    // An editor can't apply: read only, with the apply role reason.
    expect(reasonLockedText({ canEditReason: true, canApply: false, primary: apply(false) }, "ready", "Only Publishers and Admins can apply plans. You're an Editor.")).toBe("Only Publishers and Admins can apply plans. You're an Editor.");
    expect(reasonLockedText({ canEditReason: false, canApply: false, primary: apply(false) }, "ready")).toBe("You need the Publisher role to enter the reason.");
    expect(reasonLockedText({ canEditReason: false, canApply: false, primary: apply(false) }, "ready", viewer)).toBe(viewer);
    // The author who requests approval types it with the request.
    expect(reasonLockedText({ canEditReason: true, canApply: false, primary: request(true) }, "ready")).toBeNull();
    expect(reasonLockedText({ canEditReason: true, canApply: false, primary: request(false) }, "ready")).toBe("You can enter the reason once approval can be requested.");
    expect(reasonLockedText({ canEditReason: true, canApply: true, primary: { action: "approve", label: "Approve", enabled: true, disabledReason: null } }, "waiting")).toBe("The author enters the reason when they request approval.");
    expect(reasonLockedText({ canEditReason: false, canApply: true, primary: apply(false) }, "applying")).toBe("The reason can't change while the plan is applying.");
  });

  it("words the skip tile and the unchecked diff plainly", () => {
    expect(skipTileDetail(0, false)).toBe("Known after the live-space check");
    expect(skipTileDetail(0, true)).toBe("No asset changed in the live space since this plan was made");
    expect(skipTileDetail(2, true)).toBe("Changed in the live space after this plan was made");
    expect(DIFF_NOT_READY).toBe("The live-space check hasn't finished, so the diff isn't ready yet.");
    expect(DIFF_CHECK_FAILED).toBe("The live-space check failed, so the diff isn't ready. Re-check the live space to try again.");
    expect(ORIGIN_OPTIONS.find((o) => o.value === "rollback")?.label).toBe("Restore");
  });

  it("builds the default plan title from the selected asset names", () => {
    expect(defaultPlanTitle([])).toBe("");
    expect(defaultPlanTitle(["overview"])).toBe("overview");
    expect(defaultPlanTitle(["overview", "verity"])).toBe("overview and verity");
    expect(defaultPlanTitle(["overview", "verity", "a", "b", "verity"])).toBe("overview, verity and 2 more");
  });
});

describe("diff rows", () => {
  it("numbers old and new lines through each hunk", () => {
    const hunks = diffText("a\nb\nc\n", "a\nB\nc\nd\n")!;
    const rows = diffRows(hunks);
    expect(rows[0]).toEqual({ kind: "hunk", text: "@@ -1,3 +1,4 @@" });
    expect(rows.slice(1)).toEqual([
      { kind: "ctx", old: 1, new: 1, text: "a" },
      { kind: "del", old: 2, new: null, text: "b" },
      { kind: "add", old: null, new: 2, text: "B" },
      { kind: "ctx", old: 3, new: 3, text: "c" },
      { kind: "add", old: null, new: 4, text: "d" },
    ]);
    expect(diffTotals([{ added: 2, removed: 1 }, { added: 1, removed: 0 }])).toEqual({ added: 3, removed: 1 });
  });
});

describe("size meter text", () => {
  it("reads like the page file", () => {
    expect(formatSize(25 * 1024)).toBe("25 KB");
    expect(formatSize(4710)).toBe("4.6 KB");
    expect(formatSize(812)).toBe("812 B");
    expect(sizeMeterText({ bytes: 4710, maxBytes: 25600, lines: 95, recommendedLines: 120 })).toBe("4.6 KB of 25 KB · 95 lines (about 120 recommended)");
  });
});

describe("Words view of a diff", () => {
  const words = (before: string, after: string) => wordRows(diffRows(diffText(before, after)!));

  it("shows a reworded line as one row with the changed words marked", () => {
    const rows = words("# Rules - candidate v2.3\nkeep\n", "# Rules - candidate v2.4.2\nkeep\n");
    const change = rows.find((r) => r.kind === "change");
    expect(change).toMatchObject({ kind: "change", old: 1, new: 1 });
    expect(change && "parts" in change ? change.parts : []).toEqual([
      { kind: "same", text: "# Rules - candidate v2." },
      { kind: "del", text: "3" },
      { kind: "add", text: "4.2" },
    ]);
    expect(rows.filter((r) => r.kind === "add" || r.kind === "del")).toEqual([]);
  });

  it("keeps unrelated lines as a removed and an added line, in file order", () => {
    const rows = words("a\nThe agent reads every log first.\nz\n", "a\nNever deploy to production on Fridays.\nz\n");
    expect(rows.map((r) => r.kind)).toEqual(["hunk", "ctx", "del", "add", "ctx"]);
  });

  it("pairs each line with its own replacement when lines are added and removed around it", () => {
    const before = "1. Read-only. Never execute anything here.\nOld paragraph about something else entirely.\n";
    const after = "## New heading\n1. Read-only. Never execute or deploy anything here.\n";
    const kinds = words(before, after).filter((r) => r.kind !== "hunk").map((r) => (r.kind === "change" ? `change ${r.old}->${r.new}` : r.kind));
    expect(kinds).toEqual(["add", "change 1->2", "del"]);
  });
});

describe("changes list groups", () => {
  it("groups items by change in the list order and leaves out empty groups", () => {
    const items = [
      { id: "1", change: "create" as const },
      { id: "2", change: "content" as const },
      { id: "3", change: null },
      { id: "4", change: "content" as const },
      { id: "5", change: "status" as const },
    ];
    expect(groupPlanItems(items).map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Content updates", ["2", "4"]],
      ["Status changes", ["5"]],
      ["Creates", ["1"]],
      ["Not compared yet", ["3"]],
    ]);
    expect(COLLAPSED_GROUPS.has("create")).toBe(true);
    expect(COLLAPSED_GROUPS.has("content")).toBe(false);
  });
});
