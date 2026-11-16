import { describe, expect, it } from "vitest";
import type { ReportDraft } from "@/server/audits/contract";
import { auditRecord, benchmarkProfile, diagnosis, fix, item, viewInput } from "./test-support";
import type { NarrativeContent, ReportView } from "./types";
import { buildReportView, narrativeCheck, unapprovedNarratives } from "./view";

/**
 * Model text must be checked before it is shared: a narrative the model wrote
 * needs a person's approval after the latest finding decision, or a person's
 * own text. Finalize refuses without it; the shareable export warns. Pure.
 */

const i1 = item(1);
const decidedAt = new Date("2026-11-12T11:00:00.000Z");
const before = "2026-11-12T10:30:00.000Z";
const after = "2026-11-12T11:30:00.000Z";

type Section = ReportDraft["sections"][number];

function view(summary: Partial<Section> | null, over: { inputsChangedAt?: Date | null; state?: string; sections?: Section[] } = {}): ReportView {
  const sections: Section[] = [...(summary ? [{ id: "summary", narrative: "Two incidents, both fixable.", narrativeSource: "model" as const, ...summary }] : []), ...(over.sections ?? [])];
  return buildReportView(
    viewInput({
      items: [i1],
      findings: [diagnosis(i1), fix(i1, 0)],
      inputsChangedAt: over.inputsChangedAt === undefined ? decidedAt : over.inputsChangedAt,
      audit: auditRecord({ state: over.state ?? "reviewing", report: { builtAt: after, sections } }),
    }),
  );
}

const summaryOf = (v: ReportView) => v.sections.find((s) => s.id === "summary")!.content as NarrativeContent;

describe("narrativeCheck", () => {
  it("needs no approval for a person's text or an empty section", () => {
    expect(narrativeCheck("person", { approvedBy: null }, decidedAt)).toEqual({ draftedAt: null, approved: null, needsApproval: false, draftedBeforeDecisions: false });
    expect(narrativeCheck(null, undefined, decidedAt).needsApproval).toBe(false);
  });

  it("needs approval for model text drafted after the latest decision", () => {
    expect(narrativeCheck("model", { draftedAt: after }, decidedAt)).toEqual({ draftedAt: after, approved: null, needsApproval: true, draftedBeforeDecisions: false });
  });

  it("marks model text drafted before the latest decision", () => {
    expect(narrativeCheck("model", { draftedAt: before }, decidedAt)).toMatchObject({ needsApproval: true, draftedBeforeDecisions: true });
    // Drafts saved before draftedAt existed use the section's last change
    expect(narrativeCheck("model", { updatedAt: before }, decidedAt)).toMatchObject({ draftedAt: before, draftedBeforeDecisions: true });
  });

  it("counts an approval made at or after the latest decision, with who and when", () => {
    const c = narrativeCheck("model", { draftedAt: before, approvedBy: "alex@example.com", approvedAt: decidedAt.toISOString() }, decidedAt);
    expect(c).toEqual({ draftedAt: before, approved: { by: "alex@example.com", at: decidedAt.toISOString() }, needsApproval: false, draftedBeforeDecisions: false });
  });

  it("asks again when a finding was decided after the approval", () => {
    const c = narrativeCheck("model", { draftedAt: before, approvedBy: "alex@example.com", approvedAt: "2026-11-12T10:45:00.000Z" }, decidedAt);
    expect(c).toMatchObject({ approved: null, needsApproval: true, draftedBeforeDecisions: true });
  });

  it("accepts any approval before the first decision", () => {
    expect(narrativeCheck("model", { draftedAt: before, approvedBy: "a@example.com", approvedAt: before }, null)).toMatchObject({ needsApproval: false });
  });
});

describe("the report view", () => {
  it("refuses to finalize while the shared summary is model text nobody approved, and names it", () => {
    const v = view({ draftedAt: after });
    expect(summaryOf(v)).toMatchObject({ source: "model", needsApproval: true, draftedBeforeDecisions: false });
    expect(v.finalize.allowed).toBe(false);
    expect(v.finalize.issues).toEqual([
      {
        code: "unapproved-narrative",
        message: "Summary is the model's text, and nobody has approved it since the latest decisions. Approve it or write your own text first.",
        count: 1,
        incidents: [],
        sections: [{ id: "summary", title: "Summary" }],
      },
    ]);
    expect(unapprovedNarratives(v, "shareable")).toEqual([{ id: "summary", title: "Summary" }]);
  });

  it("allows finalize once a person approved the text or wrote their own", () => {
    expect(view({ draftedAt: before, approvedBy: "alex@example.com", approvedAt: after }).finalize).toEqual({ allowed: true, problems: [], issues: [] });
    expect(view({ narrativeSource: "person" }).finalize.allowed).toBe(true);
    expect(view(null).finalize.allowed).toBe(true);
  });

  it("leaves hidden sections out, since no export or shared record carries them", () => {
    const v = view({ draftedAt: after, hidden: true });
    expect(v.finalize.allowed).toBe(true);
    expect(unapprovedNarratives(v, "shareable")).toEqual([]);
  });

  it("only asks for shareable narratives: an internal one may stay model text", () => {
    const profile = benchmarkProfile();
    profile.report.sections.push({ id: "notes", title: "Team notes", kind: "narrative", audience: "internal" });
    const v = buildReportView(
      viewInput({
        profile,
        items: [i1],
        findings: [diagnosis(i1)],
        inputsChangedAt: decidedAt,
        audit: auditRecord({ report: { builtAt: after, sections: [{ id: "notes", narrative: "Model notes.", narrativeSource: "model", draftedAt: after }] } }),
      }),
    );
    expect(v.finalize.allowed).toBe(true);
    expect(unapprovedNarratives(v, "internal")).toEqual([{ id: "notes", title: "Team notes" }]);
    expect(unapprovedNarratives(v, "shareable")).toEqual([]);
  });

  it("says nothing about narratives on a finalized audit", () => {
    expect(view({ draftedAt: after }, { state: "finalized" }).finalize.issues.map((i) => i.code)).toEqual(["finalized"]);
  });
});
