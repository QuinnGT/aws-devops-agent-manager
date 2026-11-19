import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import type { FindingRevisionLink } from "@/server/revisions";
import { fixProgressOf, isActiveLink, natureOf, nextStepFor, type FindingNature, type NextStepInput } from "./next-step";

const benchmark = getAppPolicy().policy.audits.profiles.benchmark!;

const link = (over: Partial<FindingRevisionLink> = {}): FindingRevisionLink => ({
  revisionId: "r1",
  revisionName: "moss-lag-fixes",
  revisionState: "open",
  kind: "to-address",
  planId: null,
  planState: null,
  releaseName: null,
  ...over,
});

const PACKAGE: FindingNature = { kind: "package", ownerId: "customer_memory", ownerLabel: "Customer memory or runbook content" };
const ACTION: FindingNature = { kind: "action", ownerId: "customer_access", ownerLabel: "Customer tool or data access" };
const input = (over: Partial<NextStepInput>): NextStepInput => ({ state: "accepted", nature: PACKAGE, canDecide: true, canBuild: true, links: [], reviewNote: null, ...over });

describe("what kind of finding it is", () => {
  it("is recorded when the finding has no owner (a diagnosis)", () => {
    expect(natureOf(benchmark, { kind: "diagnosis", values: { primary_failure_mode: "D_wrong_component" } })).toEqual({ kind: "recorded" });
    expect(natureOf(benchmark, { kind: "fix", values: { owner: "  " } })).toEqual({ kind: "recorded" });
  });

  it("is a package fix when its owner changes the package and its kind is linkable", () => {
    expect(natureOf(benchmark, { kind: "fix", values: { owner: "customer_memory" } })).toEqual(PACKAGE);
    expect(natureOf(benchmark, { kind: "fix", values: { owner: "instructions" } })).toMatchObject({ kind: "package", ownerLabel: "Instruction and skill package" });
  });

  it("is an action for people when the owner is someone else", () => {
    expect(natureOf(benchmark, { kind: "fix", values: { owner: "customer_access" } })).toEqual(ACTION);
    expect(natureOf(benchmark, { kind: "fix", values: { owner: "aws_service" } })).toMatchObject({ kind: "action" });
  });

  it("is an action when the owner changes the package but the kind can't be linked from a revision", () => {
    const profile = { ...benchmark, findings: benchmark.findings.map((f) => (f.kind === "fix" ? { ...f, linkable: false } : f)) };
    expect(natureOf(profile, { kind: "fix", values: { owner: "customer_memory" } })).toMatchObject({ kind: "action" });
  });

  it("shows an owner the profile doesn't list in words", () => {
    expect(natureOf(benchmark, { kind: "fix", values: { owner: "legal_team" } })).toEqual({ kind: "action", ownerId: "legal_team", ownerLabel: "legal team" });
  });
});

describe("what happens next", () => {
  it("records and counts a diagnosis, before and after it is accepted", () => {
    const proposed = nextStepFor(input({ state: "proposed", nature: { kind: "recorded" } }));
    expect(proposed).toMatchObject({ rule: "recorded", action: null, links: [] });
    expect(proposed.text).toBe("Accepting records it and counts it in the report. Nothing else changes.");
    expect(nextStepFor(input({ nature: { kind: "recorded" } })).text).toBe("Recorded. This finding is counted in the report.");
  });

  it("lists a fix for people in the report as an action for its owner, with nothing to add to a revision", () => {
    const accepted = nextStepFor(input({ nature: ACTION }));
    expect(accepted).toMatchObject({ rule: "action", action: null });
    expect(accepted.text).toBe("Listed in the report as an action for Customer tool or data access. It doesn't change the package, so there is nothing to add to a revision.");
    expect(nextStepFor(input({ state: "proposed", nature: ACTION })).text).toBe("Accepting lists it in the report as an action for Customer tool or data access. It doesn't change the package.");
  });

  it("offers 'Add to revision…' for an accepted package fix that is in none", () => {
    const s = nextStepFor(input({}));
    expect(s).toMatchObject({ rule: "package-open", action: { kind: "add-to-revision", label: "Add to revision…", acceptFirst: false }, note: null });
    expect(s.text).toContain("It is a package fix (Customer memory or runbook content), so it is made in a revision");
    expect(s.text).toContain("It isn't in one yet. Accepting it didn't change the agent.");
  });

  it("offers 'Accept and add to revision…' for a proposed package fix, to someone who can decide and build", () => {
    const s = nextStepFor(input({ state: "proposed" }));
    expect(s.action).toEqual({ kind: "add-to-revision", label: "Accept and add to revision…", acceptFirst: true });
    expect(s.text.startsWith("Accepting only queues it with the package fixes. It doesn't change the agent.")).toBe(true);
  });

  it("says a fix in a revision is only queued, and names how far it got", () => {
    const links = [link(), link({ revisionId: "r2", revisionName: "v2.4", kind: "linked", planId: "p1", planState: "waiting" })];
    const s = nextStepFor(input({ links }));
    expect(s).toMatchObject({ rule: "package-sent", action: null });
    expect(s.links).toEqual(links);
    expect(s.text).toBe(
      "Queued in 2 revisions, not applied yet. A fix in a revision is only queued: it reaches the agent after someone edits the files in the revision, saves, and applies its plan.",
    );
    expect(nextStepFor(input({ links: [link()] })).text).toMatch(/^Queued in a revision, not applied yet\./);
  });

  it("says applied only when every revision it is in was applied", () => {
    const applied = link({ revisionId: "r2", revisionName: "v2.4", kind: "linked", planId: "p1", planState: "applied" });
    expect(nextStepFor(input({ links: [applied] })).text).toBe("Applied. The plan of its revision was applied to the space.");
    expect(nextStepFor(input({ links: [applied, applied] })).text).toBe("Applied. The plan of its revisions was applied to the space.");
    expect(nextStepFor(input({ links: [applied, link()] })).text).toMatch(/^Queued in 2 revisions, not applied yet\./);
  });

  it("treats an abandoned or failed revision as no revision", () => {
    expect(isActiveLink(link({ revisionState: "abandoned" }))).toBe(false);
    expect(isActiveLink(link({ revisionState: "failed" }))).toBe(false);
    expect(isActiveLink(link({ revisionState: "creating" }))).toBe(true);
    const s = nextStepFor(input({ links: [link({ revisionState: "abandoned" })] }));
    expect(s.rule).toBe("package-open");
    expect(s.action?.label).toBe("Add to revision…");
    expect(s.text).toContain("Its earlier revision was abandoned or failed.");
    expect(s.links).toHaveLength(1);
  });

  it("hides the button from someone who can't build revisions, and says who can", () => {
    const accepted = nextStepFor(input({ canBuild: false }));
    expect(accepted.action).toBeNull();
    expect(accepted.note).toBe("Someone who can build revisions adds it to one.");
    const proposed = nextStepFor(input({ state: "proposed", canBuild: false }));
    expect(proposed.action).toBeNull();
    expect(proposed.note).toBe("You can accept it here. Someone who can build revisions adds it to one afterwards.");
  });

  it("offers no 'Accept and add' to someone who can't decide", () => {
    const s = nextStepFor(input({ state: "proposed", canDecide: false }));
    expect(s.action).toBeNull();
    expect(s.note).toBeNull();
  });

  it("says when the revisions couldn't be read, and offers nothing", () => {
    const s = nextStepFor(input({ links: null }));
    expect(s).toMatchObject({ rule: "unknown", action: null, links: [] });
    expect(s.text).toContain("The revisions couldn't be read right now");
  });

  it("shows a rejected finding's note, and the revisions it was sent to before", () => {
    const s = nextStepFor(input({ state: "rejected", reviewNote: "Not the cause", links: [] }));
    expect(s).toMatchObject({ rule: "rejected", action: null, reviewNote: "Not the cause" });
    expect(s.text).toBe("Rejected. It is left out of the report, and no revision takes it.");
    const sent = nextStepFor(input({ state: "rejected", links: [link()] }));
    expect(sent.links).toHaveLength(1);
    expect(sent.text).toContain("sent to a revision before it was rejected");
  });
});

describe("how far the package fixes got", () => {
  const f = (id: string, state: "proposed" | "accepted" | "rejected", nature: FindingNature) => ({ id, state, nature });
  const fixes = [f("a", "accepted", PACKAGE), f("b", "accepted", PACKAGE), f("c", "accepted", ACTION), f("d", "proposed", PACKAGE), f("e", "rejected", PACKAGE)];

  it("counts the accepted package fixes that are in a revision, and lists the others", () => {
    const links = new Map([["a", [link()]], ["b", [link({ revisionState: "abandoned" })]]]);
    expect(fixProgressOf(fixes, links)).toEqual({ total: 2, inRevision: 1, applied: 0, open: ["b"] });
  });

  it("counts the fixes whose revision was applied", () => {
    const links = new Map([["a", [link({ planId: "p1", planState: "applied" })]], ["b", [link()]]]);
    expect(fixProgressOf(fixes, links)).toEqual({ total: 2, inRevision: 2, applied: 1, open: [] });
  });

  it("is zero of zero without package fixes", () => {
    expect(fixProgressOf([f("c", "accepted", ACTION)], new Map())).toEqual({ total: 0, inRevision: 0, applied: 0, open: [] });
  });

  it("doesn't claim anything when the revisions couldn't be read", () => {
    expect(fixProgressOf(fixes, null)).toEqual({ total: 2, inRevision: null, applied: null, open: [] });
  });
});
