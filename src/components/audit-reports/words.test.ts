import { describe, expect, it } from "vitest";
import type { CountRow, ExportViolation, FinalizeIssue } from "@/server/audit-reports";
import {
  acceptedCount,
  approvalNotice,
  audienceHelp,
  builtFromText,
  countHeader,
  finalizeBlock,
  findingsHref,
  goToSection,
  joinNames,
  localRecordText,
  pushPlanText,
  recordFileHolds,
  remoteHelp,
  savedPushText,
  fileStatusText,
  shortCommit,
  MODEL_TEXT_NOTICE,
  pluralLabel,
  ruleErrorsText,
  sectionAnchor,
  shareText,
  shownCountRows,
  unapprovedExportBody,
  unapprovedTitle,
  staleLead,
  undecidedText,
  violationRows,
  whereText,
} from "./words";

const kinds = [
  { kind: "diagnosis", label: "Diagnosis", perInvestigation: true },
  { kind: "fix", label: "Fix", perInvestigation: false },
];

describe("report words", () => {
  it("pluralizes finding kind labels", () => {
    expect(pluralLabel("Diagnosis")).toBe("diagnoses");
    expect(pluralLabel("Fix")).toBe("fixes");
    expect(pluralLabel("Issue")).toBe("issues");
    expect(pluralLabel("Case")).toBe("cases");
    expect(pluralLabel("Policy")).toBe("policies");
    expect(acceptedCount(1, "Diagnosis")).toBe("1 accepted diagnosis");
    expect(acceptedCount(16, "Diagnosis")).toBe("16 accepted diagnoses");
  });

  it("joins names in plain English", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["Run metrics"])).toBe("Run metrics");
    expect(joinNames(["A", "B"])).toBe("A and B");
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
  });

  it("writes the help line above the sections", () => {
    expect(builtFromText({ diagnosis: 16, fix: 36 }, kinds, 23)).toBe(
      "Built from 16 accepted diagnoses and 36 accepted fixes. The 23 proposed findings count once you accept them. Sections appear in the profile's order.",
    );
    expect(builtFromText({ diagnosis: 1 }, kinds, 1)).toBe("Built from 1 accepted diagnosis and 0 accepted fixes. The 1 proposed finding counts once you accept it. Sections appear in the profile's order.");
    expect(builtFromText({}, kinds, 0)).toBe("Built from 0 accepted diagnoses and 0 accepted fixes. Sections appear in the profile's order.");
  });

  it("heads the count column by what is counted", () => {
    expect(countHeader(kinds[0])).toBe("Incidents");
    expect(countHeader(kinds[1])).toBe("Fixes");
    expect(countHeader(undefined)).toBe("Count");
  });

  it("shows count rows with findings, by count then label, with their share", () => {
    const rows: CountRow[] = [
      { value: "a", label: "Wrong component", count: 1, known: true },
      { value: "b", label: "Chronic noise", count: 3, known: true },
      { value: "c", label: "Anchored on a change", count: 1, known: true },
      { value: "d", label: "Never seen", count: 0, known: true },
    ];
    expect(shownCountRows(rows).map((r) => r.label)).toEqual(["Chronic noise", "Anchored on a change", "Wrong component"]);
    expect(shareText(7, 16)).toBe("44%");
    expect(shareText(0, 0)).toBe("0%");
  });

  it("describes each export audience", () => {
    expect(audienceHelp("shareable", { sections: 6, internalLeftOut: ["Run metrics"], emptyLeftOut: [] })).toBe("6 sections. Leaves out Run metrics, which is internal.");
    expect(audienceHelp("shareable", { sections: 5, internalLeftOut: ["Run metrics", "Scorecard fairness"], emptyLeftOut: ["Summary"] })).toBe(
      "5 sections. Leaves out Run metrics and Scorecard fairness, which are internal. Summary has no text yet, so it is left out.",
    );
    expect(audienceHelp("internal", { sections: 7, internalLeftOut: [], emptyLeftOut: [] })).toBe("7 sections, internal ones marked.");
    expect(audienceHelp("internal", { sections: 1, internalLeftOut: [], emptyLeftOut: [] })).toBe("1 section, internal ones marked.");
  });

  it("says where an output-rule match is", () => {
    const v = (over: Partial<ExportViolation>): ExportViolation => ({ ruleId: "r", severity: "error", description: "d", index: 0, excerpt: "x", sectionId: "fixes", sectionTitle: "Fixes", location: "Row 12", incident: null, ...over });
    expect(whereText(v({}))).toBe("Fixes, row 12");
    expect(whereText(v({ sectionId: "summary", sectionTitle: "Summary", location: "Paragraph 2" }))).toBe("Summary, paragraph 2");
    expect(whereText(v({ sectionId: "incidents", sectionTitle: "Incidents", location: "INCIDENT-31808" }))).toBe("Incidents, INCIDENT-31808");
    expect(whereText(v({ sectionId: null, sectionTitle: "Title", location: "Title" }))).toBe("Report title");
    const e = v({ ruleId: "e" });
    const w = v({ ruleId: "w", severity: "warning" });
    expect(violationRows([e], [w]).map((x) => x.ruleId)).toEqual(["e", "w"]);
    expect(ruleErrorsText(1)).toBe("1 output rule error");
    expect(ruleErrorsText(2)).toBe("2 output rule errors");
  });

  it("makes safe anchors and links", () => {
    expect(sectionAnchor("run-metrics")).toBe("report-section-run-metrics");
    expect(sectionAnchor("a b/c")).toBe("report-section-a-b-c");
    expect(findingsHref("customer demo", "id-1", "proposed")).toBe("/spaces/customer%20demo/audits/id-1/findings?state=proposed");
  });

  it("words the stale lead", () => {
    expect(staleLead(6)).toBe("6 findings changed after the report was built on");
    expect(staleLead(1)).toBe("1 finding changed after the report was built on");
    expect(staleLead(0)).toBe("Investigations changed after the report was built on");
  });

  it("blocks Finalize on undecided findings first, then state and repository", () => {
    const proposed: FinalizeIssue = { code: "proposed", message: "", count: 9, incidents: [] };
    const open: FinalizeIssue = { code: "items-open", message: "", count: 2, incidents: ["INCIDENT-1"] };
    expect(finalizeBlock({ state: "reviewing", issues: [open, proposed], hasRepository: false })).toEqual({ reason: undecidedText(9), link: "findings" });
    expect(undecidedText(9)).toBe("9 findings still need a decision.");
    expect(undecidedText(1)).toBe("1 finding still needs a decision.");
    expect(finalizeBlock({ state: "running", issues: [open], hasRepository: true })).toEqual({ reason: "Wait for the reviews to finish.", link: null });
    expect(finalizeBlock({ state: "cancelled", issues: [], hasRepository: true })?.reason).toBe("The audit was cancelled, so its record can't be saved.");
    expect(finalizeBlock({ state: "reviewing", issues: [], hasRepository: false })).toEqual({ reason: "The history repository isn't set up for this space.", link: "settings" });
    // Other issues (an open investigation) are listed in the dialog, so the button opens it.
    expect(finalizeBlock({ state: "reviewing", issues: [open], hasRepository: true })).toBeNull();
    expect(finalizeBlock({ state: "reviewing", issues: [], hasRepository: true })).toBeNull();
  });
});

describe("model text that needs a person's check", () => {
  it("opens every notice with the same sentence, and tells a Viewer who approves", () => {
    expect(MODEL_TEXT_NOTICE).toBe("Written by the model. Check it against the tables before you share it.");
    expect(approvalNotice({ draftedBeforeDecisions: false, canApprove: true })).toEqual({ title: MODEL_TEXT_NOTICE, body: "Approve it once you have, or edit it to make it your own text." });
    expect(approvalNotice({ draftedBeforeDecisions: false, canApprove: false }).body).toBe("Someone who can run audits checks it and approves it.");
    const stale = approvalNotice({ draftedBeforeDecisions: true, canApprove: true });
    expect(stale.title).toBe("Drafted before the latest decisions");
    expect(stale.body.startsWith(MODEL_TEXT_NOTICE)).toBe(true);
    expect(stale.body).toContain("decided after this draft");
  });

  it("names the sections in the shareable export's warning", () => {
    expect(unapprovedTitle(["Summary"])).toBe("Summary is the model's text, and nobody has approved it");
    expect(unapprovedTitle(["Summary", "Outlook"])).toBe("Summary and Outlook are the model's text, and nobody has approved them");
    expect(unapprovedExportBody(1)).toBe("Check it against the tables before you share this file. You can export anyway, or approve or edit the text first.");
    expect(goToSection("Summary")).toBe("Go to Summary");
  });

  it("says when the finalize commit stays on this machine, as Home does", () => {
    expect(localRecordText("demo-history", "no-remote")).toBe(
      "demo-history has no remote (a copy of the repository on a server such as GitHub), so this audit record stays on this machine until one is set. Add one so the history is also kept off this machine.",
    );
    expect(localRecordText("demo-history", "push-off")).toBe("Copying to the remote is off for demo-history, so this audit record stays on this machine until it is turned on.");
    expect(localRecordText("demo-history", null)).toBeNull();
  });

  it("uses no em or en dashes", () => {
    const all = [approvalNotice({ draftedBeforeDecisions: true, canApprove: false }).body, unapprovedTitle(["A", "B", "C"]), unapprovedExportBody(2), localRecordText("r", "no-remote"), localRecordText("r", "push-off")].join(" ");
    expect(all).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("where the saved record went", () => {
  it("says where a save will push, before it is saved", () => {
    expect(pushPlanText({ kind: "pushes", remote: "git@github.com:acme/history.git" })).toEqual({ tone: "success", text: "Pushes to git@github.com:acme/history.git" });
    expect(pushPlanText({ kind: "local", reason: "no-remote", remote: null })).toEqual({ tone: "warning", text: "Local only: this repository has no remote" });
    expect(pushPlanText({ kind: "local", reason: "push-off", remote: "https://example.com/h.git" }).text).toBe("Local only: pushing is off for this repository");
  });

  it("says what happened to the commit, after it is saved", () => {
    expect(savedPushText({ pushed: true, error: null, remote: "git@github.com:acme/history.git" }, null)).toEqual({ tone: "success", text: "Pushed to git@github.com:acme/history.git" });
    expect(savedPushText({ pushed: false, error: "remote rejected the push.", remote: "git@example.com:h.git" }, null)).toEqual({
      tone: "destructive",
      text: "Saved here, but the push to git@example.com:h.git failed: remote rejected the push. The next push carries it.",
    });
    expect(savedPushText({ pushed: false, error: null, remote: null }, null)).toEqual({ tone: "warning", text: "Local only: this repository has no remote" });
    expect(savedPushText({ pushed: false, error: null, remote: "git@example.com:h.git" }, null).text).toBe("Not pushed: pushing was off for this repository");
  });

  it("admits when an older save didn't keep the push result", () => {
    expect(savedPushText(null, null).text).toBe("The push result wasn't kept for this save.");
    expect(savedPushText(null, { kind: "local", reason: "no-remote", remote: null }).text).toBe("The push result wasn't kept for this save. Local only: this repository has no remote.");
  });

  it("words a file's status and the short commit", () => {
    expect(fileStatusText("new")).toBe("new");
    expect(fileStatusText("changed")).toBe("replaces the file that is there");
    expect(shortCommit("5e1c2a90cafe0000")).toBe("5e1c2a9");
  });
});

describe("plain words for the saved files", () => {
  it("explains a fingerprint instead of naming a hash", () => {
    const text = recordFileHolds("audit.json", { journalCount: 3, acceptedCount: 4, reportSections: 8 });
    expect(text).toContain("a fingerprint of each of the 3 journals so a later change to a journal can be detected");
    expect(text).not.toMatch(/sha/i);
    expect(recordFileHolds("audit.json", { journalCount: 1, acceptedCount: 0, reportSections: 0 })).toContain("a fingerprint of the 1 journal so");
  });

  it("says what the other files hold, with the counts of this audit", () => {
    expect(recordFileHolds("findings.json", { journalCount: 3, acceptedCount: 1, reportSections: 8 })).toBe("the 1 accepted finding with their citations");
    expect(recordFileHolds("findings.json", { journalCount: 3, acceptedCount: 4, reportSections: 8 })).toBe("the 4 accepted findings with their citations");
    expect(recordFileHolds("report.md", { journalCount: 3, acceptedCount: 4, reportSections: 1 })).toBe("the report as text, 1 section");
  });

  it("says what copying to the remote means for each repository", () => {
    expect(remoteHelp({ kind: "pushes", remote: "git@github.com:acme/history.git" })).toBe("The saved commit is copied to the remote when you save.");
    expect(remoteHelp({ kind: "local", reason: "no-remote", remote: null })).toContain("A remote is a copy of the repository on a server");
    expect(remoteHelp({ kind: "local", reason: "push-off", remote: "x" })).toBe("Copying to the remote is off for this repository, so the record stays on this machine.");
  });

  it("uses no em or en dashes", () => {
    const all = [recordFileHolds("audit.json", { journalCount: 2, acceptedCount: 1, reportSections: 3 }), remoteHelp({ kind: "local", reason: "no-remote", remote: null })].join(" ");
    expect(all).not.toMatch(/[\u2013\u2014]/);
  });
});
