import { describe, expect, it } from "vitest";
import { applyGaveUp, shouldAskBoss } from "./stuck";
import { isBusyState, originLine, PLAN_STATUS_FILTERS } from "./view";

describe("originLine (pages/plans.md)", () => {
  it("names every origin kind", () => {
    expect(originLine({ kind: "drafts", draftIds: ["a", "b", "c", "d"] })).toBe("From 4 drafts");
    expect(originLine({ kind: "drafts", draftIds: ["a"] })).toBe("From 1 draft");
    expect(originLine({ kind: "rollback", target: { kind: "release", releaseId: "r", name: "v1.2" } })).toBe("Restore to release v1.2");
    expect(originLine({ kind: "rollback", target: { kind: "commit", commit: "8e24914abcdef" } })).toBe("Restore to commit 8e24914");
    expect(originLine({ kind: "rollback", target: { kind: "version", assetId: "ki-1", version: 3 } }, { assetName: "overview" })).toBe("Restore overview to v3");
    expect(originLine({ kind: "package", importId: "i", fileName: "x.zip" })).toBe("Package import");
    expect(originLine({ kind: "retry", planId: "p" }, { retryOfTitle: "Shorter verity guidance" })).toBe("Retry of Shorter verity guidance");
  });

  it("falls back when a lookup is missing", () => {
    expect(originLine({ kind: "rollback", target: { kind: "version", assetId: "ki-1", version: 3 } })).toBe("Restore ki-1 to v3");
    expect(originLine({ kind: "retry", planId: "p" })).toBe("Retry of a failed plan");
  });
});

describe("status filters", () => {
  it("split open and closed states as the page file lists them", () => {
    expect(PLAN_STATUS_FILTERS.open).toEqual(["checking", "ready", "waiting", "approved", "applying"]);
    expect(PLAN_STATUS_FILTERS.closed).toEqual(["applied", "failed", "discarded"]);
    expect(isBusyState("checking")).toBe(true);
    expect(isBusyState("applying")).toBe(true);
    expect(isBusyState("waiting")).toBe(false);
  });
});

describe("an apply job that gave up", () => {
  it("is final only when pg-boss is done with the job", () => {
    expect(applyGaveUp("applying", { status: "failed" }, "failed")).toBe(true);
    expect(applyGaveUp("applying", { status: "running" }, "failed")).toBe(true);
    expect(applyGaveUp("applying", { status: "cancelled" }, "cancelled")).toBe(true);
    expect(applyGaveUp("applying", { status: "failed" }, "missing")).toBe(true);
    // pg-boss retries: the plan stays applying.
    expect(applyGaveUp("applying", { status: "failed" }, "retry")).toBe(false);
    expect(applyGaveUp("applying", { status: "failed" }, "active")).toBe(false);
    expect(applyGaveUp("applying", { status: "running" }, "missing")).toBe(false);
    // Unknown boss state, a finished job, or a plan that is not applying.
    expect(applyGaveUp("applying", { status: "failed" }, null)).toBe(false);
    expect(applyGaveUp("applying", { status: "succeeded" }, "failed")).toBe(false);
    expect(applyGaveUp("applied", { status: "failed" }, "failed")).toBe(false);
    expect(applyGaveUp("applying", null, "failed")).toBe(false);
  });

  it("asks pg-boss only for failed rows or runs past the job's expiry", () => {
    const now = new Date("2026-11-12T10:00:00Z");
    expect(shouldAskBoss({ status: "failed", startedAt: null }, now)).toBe(true);
    expect(shouldAskBoss({ status: "running", startedAt: new Date("2026-11-12T09:30:00Z") }, now)).toBe(false);
    expect(shouldAskBoss({ status: "running", startedAt: new Date("2026-11-12T07:00:00Z") }, now)).toBe(true);
    expect(shouldAskBoss({ status: "queued", startedAt: null }, now)).toBe(false);
  });
});
