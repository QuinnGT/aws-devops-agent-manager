import { describe, expect, it } from "vitest";
import { isQueued, linkApplied, linkStageWords, planStateWords, revisionStage } from "./revision-stage";

describe("the state of a plan in words", () => {
  it("words each state and passes an unknown one through", () => {
    expect(planStateWords("waiting")).toBe("waiting for approval");
    expect(planStateWords("applied")).toBe("applied");
    expect(planStateWords("odd")).toBe("odd");
  });
});

describe("where a revision is", () => {
  const r = (state: string, changes: number, plan: { state: string } | null = null) => revisionStage({ state, changes, plan });

  it("starts with no saves, then saved, then planned, then applied", () => {
    expect(r("open", 0)).toEqual({ stage: "no-saves", words: "No saves yet" });
    expect(r("open", 2)).toEqual({ stage: "saved", words: "Saved, no plan yet" });
    expect(r("open", 2, { state: "waiting" })).toEqual({ stage: "planned", words: "Planned: the plan is waiting for approval" });
    expect(r("open", 2, { state: "applied" })).toEqual({ stage: "applied", words: "Applied to the space" });
    expect(r("applied", 2)).toEqual({ stage: "applied", words: "Applied to the space" });
  });

  it("ignores a discarded plan", () => {
    expect(r("open", 1, { state: "discarded" })).toEqual({ stage: "saved", words: "Saved, no plan yet" });
    expect(r("open", 0, { state: "discarded" })).toEqual({ stage: "no-saves", words: "No saves yet" });
  });

  it("says when a revision is being created, failed or abandoned", () => {
    expect(r("creating", 0).words).toBe("Being created");
    expect(r("failed", 0).words).toBe("Couldn't be created");
    expect(r("abandoned", 3, { state: "applied" })).toEqual({ stage: "abandoned", words: "Abandoned" });
  });

  it("is queued until it is applied or out of the running", () => {
    expect(["creating", "no-saves", "saved", "planned"].every((s) => isQueued(s as never))).toBe(true);
    expect(["applied", "abandoned", "failed"].some((s) => isQueued(s as never))).toBe(false);
  });
});

describe("where a finding stands in a revision", () => {
  const link = (over: Partial<Parameters<typeof linkStageWords>[0]> = {}) => ({ revisionState: "open", kind: "to-address" as const, planId: null, planState: null, releaseName: null, ...over });

  it("is not made yet while the revision only lists it", () => {
    expect(linkStageWords(link())).toBe("Not made yet: no save has addressed it");
    expect(linkApplied(link())).toBe(false);
  });

  it("is made in a save once a save links it, and planned when a plan holds the save", () => {
    expect(linkStageWords(link({ kind: "linked" }))).toBe("Made in a save, no plan yet");
    expect(linkStageWords(link({ kind: "linked", planId: "p1", planState: "approved" }))).toBe("Planned: the plan is approved, not applied yet");
  });

  it("is applied when the plan or the revision is", () => {
    expect(linkStageWords(link({ kind: "linked", planId: "p1", planState: "applied" }))).toBe("Applied to the space");
    expect(linkApplied(link({ planState: "applied" }))).toBe(true);
    expect(linkApplied(link({ revisionState: "applied" }))).toBe(true);
  });

  it("says when the revision is being created, abandoned or failed", () => {
    expect(linkStageWords(link({ revisionState: "creating" }))).toBe("The revision is being created");
    expect(linkStageWords(link({ revisionState: "abandoned" }))).toBe("The revision was abandoned");
    expect(linkStageWords(link({ revisionState: "failed" }))).toBe("The revision couldn't be created");
  });
});
