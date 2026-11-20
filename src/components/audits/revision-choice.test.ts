import { describe, expect, it } from "vitest";
import type { FixContext, RevisionInfo } from "@/server/audits/fixes";
import type { RevisionStage } from "@/server/audits/revision-stage";
import { defaultChoice, NEW_REVISION, queuedRevisions, revisionChoices } from "./revision-choice";

const WORDS: Record<RevisionStage, string> = {
  creating: "Being created",
  "no-saves": "No saves yet",
  saved: "Saved, no plan yet",
  planned: "Planned: the plan is waiting for approval",
  applied: "Applied to the space",
  abandoned: "Abandoned",
  failed: "Couldn't be created",
};

const info = (id: string, stage: RevisionStage, over: Partial<RevisionInfo> = {}): RevisionInfo => ({
  id,
  name: `rev-${id}`,
  state: "open",
  stage: { stage, words: WORDS[stage] },
  saves: 0,
  base: "Live space",
  createdBy: "sam@example.com",
  createdAt: new Date("2026-07-02T10:00:00Z"),
  toAddress: 0,
  linked: 0,
  audits: [],
  fromThisAudit: 0,
  ...over,
});

const option = (id: string, over: Partial<FixContext["options"][number]> = {}): FixContext["options"][number] => ({
  id,
  name: `rev-${id}`,
  state: "open",
  packageName: "pkg",
  toAddress: 0,
  linked: 0,
  updatedAt: new Date("2026-07-03T10:00:00Z"),
  ...over,
});

describe("which revision the dialog starts on", () => {
  it("starts a new revision when none holds a finding of this audit", () => {
    expect(defaultChoice([])).toBe(NEW_REVISION);
    expect(defaultChoice([{ id: "a", fromThisAudit: 0 }, { id: "b", fromThisAudit: 0 }])).toBe(NEW_REVISION);
  });

  it("starts on the revision that holds the most findings of this audit, never an unrelated one", () => {
    expect(defaultChoice([{ id: "a", fromThisAudit: 0 }, { id: "b", fromThisAudit: 1 }, { id: "c", fromThisAudit: 3 }])).toBe("c");
    expect(defaultChoice([{ id: "a", fromThisAudit: 2 }, { id: "b", fromThisAudit: 2 }])).toBe("a");
  });
});

describe("the revisions the dialog offers", () => {
  it("shows what each is: base, who started it, when, its audits and its state", () => {
    const ctx: Pick<FixContext, "options" | "revisions"> = {
      options: [option("a", { toAddress: 2, linked: 1 }), option("b")],
      revisions: new Map([
        ["a", info("a", "saved", { base: "v2.4", audits: [{ auditId: "au1", auditName: "July audit", findings: 2 }, { auditId: "au2", auditName: "June audit", findings: 1 }], fromThisAudit: 2 })],
      ]),
    };
    const [a, b] = revisionChoices(ctx, "au1", (email) => (email === "sam@example.com" ? "Sam Lee" : email));
    expect(a).toMatchObject({
      id: "a",
      stage: "Saved, no plan yet",
      base: "v2.4",
      by: "Sam Lee",
      at: "2026-07-02T10:00:00.000Z",
      toAddress: 2,
      linked: 1,
      fromThisAudit: 2,
      audits: [
        { id: "au1", name: "July audit", findings: 2, here: true },
        { id: "au2", name: "June audit", findings: 1, here: false },
      ],
    });
    // Details that couldn't be read leave the name and counts, and no invented words.
    expect(b).toMatchObject({ id: "b", stage: "", base: "", by: "", at: "2026-07-03T10:00:00.000Z", audits: [], fromThisAudit: 0 });
  });

  it("says a revision being created is being created even without details", () => {
    const [c] = revisionChoices({ options: [option("c", { state: "creating" })], revisions: new Map() }, "au1", (e) => e);
    expect(c!.stage).toBe("Being created");
  });
});

describe("the revisions still waiting on this audit's fixes", () => {
  it("lists the revisions with fixes of this audit that are not applied, most fixes first", () => {
    const revisions = new Map<string, RevisionInfo>([
      ["a", info("a", "no-saves", { fromThisAudit: 1 })],
      ["b", info("b", "planned", { fromThisAudit: 3 })],
      ["c", info("c", "applied", { fromThisAudit: 2 })],
      ["d", info("d", "saved", { fromThisAudit: 0 })],
      ["e", info("e", "abandoned", { fromThisAudit: 4 })],
      ["f", info("f", "saved", { fromThisAudit: 1 })],
    ]);
    expect(queuedRevisions({ revisions })).toEqual([
      { id: "b", name: "rev-b", stage: "Planned: the plan is waiting for approval", fixes: 3 },
      { id: "a", name: "rev-a", stage: "No saves yet", fixes: 1 },
      { id: "f", name: "rev-f", stage: "Saved, no plan yet", fixes: 1 },
    ]);
  });

  it("is empty when every revision was applied or none holds a fix", () => {
    expect(queuedRevisions({ revisions: new Map() })).toEqual([]);
    expect(queuedRevisions({ revisions: new Map([["c", info("c", "applied", { fromThisAudit: 2 })]]) })).toEqual([]);
  });
});
