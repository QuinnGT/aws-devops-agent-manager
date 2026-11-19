import { describe, expect, it } from "vitest";
import { NO_REVIEW_MODEL_REASON } from "@/server/ai/models";
import { assignByTime, cohortCounts, cohortSelections } from "./cohorts";
import { cardRows, changedValues, citationField, citationsByField, evidenceRows, firstCitation, quotesFor, type CardField } from "./finding-view";
import { auditListQuery, defaultFindingState, filterQuery, findingListQuery, itemListQuery, parseAuditListParams, parseFindingListParams, parseItemListParams } from "./list-params";
import { readinessRows, startBlockedReason, startLabel, CONNECTION_FAILED_REASON, type BedrockReadiness, type ReadinessInput } from "./readiness-view";
import { failureGroups, failureNextStep, incidentList } from "./failure-view";
import { nextIncidentToReview } from "./next-incident";
import { hasMarks, markQuotes } from "./record-marks";
import { isTextTarget, moveFocus, shortcutFor, SHORTCUT_KEYS, type KeyInput } from "./shortcuts";
import {
  AUDIT_STATE_BADGE,
  auditStateBadge,
  reviewProgressText,
  analyzerWords,
  citationCell,
  citationChipReason,
  citationProblemSentence,
  citationResult,
  confirmRevisionLabel,
  evidenceSummary,
  planStateWords,
  showClosedText,
  compactNumber,
  failedReviewSentence,
  failedShortReason,
  fieldText,
  findingCitationText,
  findingCountsText,
  formatAccount,
  itemReviewBadge,
  kindPosition,
  parseIncidentIds,
  profileNeeds,
  reviewedBy,
  reviewerFacts,
  startHelp,
  uniqueProblems,
  unmatchedText,
} from "./words";

describe("audit words", () => {
  it("uses the page file's state words and tones", () => {
    expect(Object.fromEntries(Object.entries(AUDIT_STATE_BADGE).map(([k, v]) => [k, [v.tone, v.label]]))).toEqual({
      draft: ["neutral", "Draft"],
      running: ["info", "Running"],
      reviewing: ["warning", "In review"],
      finalized: ["success", "Record saved"],
      cancelled: ["neutral", "Cancelled"],
    });
    expect(itemReviewBadge("pending").label).toBe("Waiting");
    expect(itemReviewBadge("analyzing").label).toBe("Waiting");
    expect(itemReviewBadge("reviewing")).toMatchObject({ tone: "info", label: "Reviewing" });
    expect(itemReviewBadge("failed")).toMatchObject({ tone: "destructive", label: "Failed" });
    expect(itemReviewBadge("skipped")).toMatchObject({ tone: "neutral", label: "Skipped" });
  });

  it("counts findings, leaving out zeros and marking proposed", () => {
    expect(findingCountsText({ accepted: 1, proposed: 3, rejected: 0 })).toEqual({
      parts: [
        { n: 1, word: "accepted", strong: false },
        { n: 3, word: "proposed", strong: true },
      ],
      none: false,
    });
    expect(findingCountsText({ accepted: 0, proposed: 0, rejected: 0 }).none).toBe(true);
  });

  it("words the citation check", () => {
    expect(citationCell(null)).toEqual({ tone: "muted", label: "Not checked", detail: null });
    expect(citationCell({ checked: 22, failed: 0 })).toEqual({ tone: "success", label: "Passed", detail: "22 citations" });
    expect(citationCell({ checked: 26, failed: 2 })).toEqual({ tone: "warning", label: "2 failed", detail: "of 26 citations" });
    expect(findingCitationText({ checked: 6, failed: 1 })).toEqual({ tone: "warning", label: "1 of 6 failed" });
    expect(findingCitationText({ checked: 6, failed: 1, open: 0 })).toEqual({ tone: "success", label: "1 failed citation checked by a reviewer" });
    expect(findingCitationText({ checked: 0, failed: 0 })).toEqual({ tone: "muted", label: "No records cited" });
    expect(findingCitationText({ checked: 3, failed: 0 })).toEqual({ tone: "success", label: "3 passed" });
    expect(citationProblemSentence({ record: 171, ok: false, problem: "missing-record" }, 169)).toBe("R171 doesn't exist: this journal has 169 records.");
    expect(citationProblemSentence({ record: 121, ok: false, problem: "quote-not-found" }, 169)).toBe("The text quoted from R121 isn't in that record.");
    expect(citationChipReason({ record: 171, ok: false, problem: "missing-record" }, 169)).toBe("Not in this journal (169 records)");
    expect(citationChipReason({ record: 121, ok: false, problem: "quote-not-found" }, 169)).toBe("Quoted text not found in R121");
    expect(citationChipReason({ record: 1, ok: true }, 169)).toBeNull();
    expect(uniqueProblems([{ record: 9, ok: false, problem: "missing-record" as const }, { record: 2, ok: true }, { record: 9, ok: false, problem: "missing-record" as const }, { record: 3, ok: false, problem: "quote-not-found" as const }]).map((c) => c.record)).toEqual([3, 9]);
  });

  it("words failed reviews by cause, never with the stored error as the text", () => {
    expect(failedReviewSentence("INCIDENT-32430", "The step limit (40) was reached without output.", 40)).toBe("INCIDENT-32430: The review stopped at the step limit (40 steps) before it returned a result.");
    expect(failedReviewSentence("I-1", "The output does not match the schema (2 errors).", 40)).toBe("I-1: The model's answer didn't match the profile's output schema.");
    const noCreds = "The model call failed: CredentialsProviderError: Could not resolve credentials using profile: [dam-demo-no-aws] in configuration/credentials file(s).";
    expect(failedReviewSentence("I-1", noCreds, 40, true)).toBe("I-1: This app has no AWS credentials for this space, so it can't reach AWS. An Admin sets the connection in Space settings.");
    expect(failedReviewSentence("I-1", noCreds, 40, false)).toBe("I-1: This app has no AWS credentials for this space, so it can't reach AWS. Ask an Admin to check the connection in Space settings.");
    expect(failedShortReason("The step limit (40) was reached without output.")).toBe("Stopped at the step limit");
    expect(failedShortReason(noCreds)).toBe("No AWS credentials for the space");
    expect(failedShortReason("The model call failed: ThrottlingException: Rate exceeded")).toBe("Bedrock was limiting requests");
    expect(failedShortReason(null)).toBe("Review failed");
  });

  it("parses incident IDs with the space's template", () => {
    expect(parseIncidentIds("31744 31801,\n31808  INCIDENT-31865; 31744", "INCIDENT-{id}")).toEqual(["INCIDENT-31744", "INCIDENT-31801", "INCIDENT-31808", "INCIDENT-31865"]);
    expect(parseIncidentIds("", "INCIDENT-{id}")).toEqual([]);
    expect(parseIncidentIds("12", "{id}")).toEqual(["12"]);
  });

  it("formats small things", () => {
    expect(kindPosition("Fix", 1, 3)).toBe("Fix 2 of 3");
    expect(kindPosition("Diagnosis", 0, 1)).toBe("Diagnosis");
    expect(profileNeeds({ inputs: [{ label: "Confirmed root cause", required: true }, { label: "Benchmark scorecard", required: true }], cohorts: [] })).toBe("Needs per incident: Confirmed root cause, Benchmark scorecard");
    expect(profileNeeds({ inputs: [{ label: "Confirmed root cause", required: false }], cohorts: [{ label: "a" }, { label: "b" }] })).toBe("Needs: two cohorts");
    expect(formatAccount("111122223333")).toBe("1111-2222-3333");
    expect(compactNumber(1_900_000)).toBe("1.9 M");
    expect(compactNumber(276_000)).toBe("276 k");
    expect(compactNumber(830)).toBe("830");
    expect(analyzerWords(["run-metrics", "condensed-trace", "memory-reads", "output-rules"])).toBe("run metrics, condensed trace, memory reads and output rules");
    expect(fieldText("Score", "2/5")).toBe("Score 2/5");
    expect(fieldText("Verdict", "Miss")).toBe("Verdict: Miss");
    expect(unmatchedText({ fileName: "notes.md", reason: "x", code: "evidence.name-unmatched" }, "INCIDENT-31808_actual_rca.md")).toBe(
      "notes.md: the name matches neither input. Rename it, for example to INCIDENT-31808_actual_rca.md, and upload it again.",
    );
    expect(unmatchedText({ fileName: "a.bin", reason: "x", code: "evidence.not-text" }, null)).toBe("a.bin isn't a text or markdown file.");
  });
});

describe("shortcuts", () => {
  const key = (k: string, over: Partial<KeyInput> = {}): KeyInput => ({ key: k, altKey: false, ctrlKey: false, metaKey: false, inTextField: false, inReviewArea: true, ...over });

  it("maps A, E, R, J, K and O, in either case", () => {
    expect(SHORTCUT_KEYS.map((s) => s.key).join("")).toBe("AERJKO");
    expect(["a", "e", "r", "j", "k", "o"].map((k) => shortcutFor(key(k), true))).toEqual(["accept", "edit", "reject", "next", "prev", "open"]);
    expect(shortcutFor(key("A"), true)).toBe("accept");
    expect(shortcutFor(key("x"), true)).toBeNull();
    expect(shortcutFor(key("Enter"), true)).toBeNull();
  });

  it("stays off when switched off, outside the review area, in a text field or with a modifier", () => {
    expect(shortcutFor(key("a"), false)).toBeNull();
    expect(shortcutFor(key("a", { inReviewArea: false }), true)).toBeNull();
    expect(shortcutFor(key("a", { inTextField: true }), true)).toBeNull();
    expect(shortcutFor(key("a", { metaKey: true }), true)).toBeNull();
    expect(shortcutFor(key("a", { ctrlKey: true }), true)).toBeNull();
    expect(shortcutFor(key("a", { altKey: true }), true)).toBeNull();
    expect(shortcutFor(key("a", { repeat: true }), true)).toBeNull();
  });

  it("knows text targets", () => {
    expect(isTextTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTextTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTextTarget({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(isTextTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTextTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTextTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTextTarget({ tagName: "BUTTON", closest: () => null })).toBe(false);
    expect(isTextTarget({ tagName: "BUTTON", closest: () => ({}) })).toBe(true);
    expect(isTextTarget(null)).toBe(false);
  });

  it("moves J to the next proposed finding and K to the previous one", () => {
    const ids = [
      { id: "d", proposed: false },
      { id: "f1", proposed: true },
      { id: "f2", proposed: false },
      { id: "f3", proposed: true },
    ];
    expect(moveFocus(ids, -1, "next")).toBe(1);
    expect(moveFocus(ids, 1, "next")).toBe(3);
    expect(moveFocus(ids, 3, "next")).toBe(3);
    expect(moveFocus(ids, 3, "prev")).toBe(2);
    expect(moveFocus(ids, 0, "prev")).toBe(0);
    expect(moveFocus([], 0, "next")).toBe(-1);
  });
});

describe("record marks", () => {
  it("marks quotes case-insensitively across whitespace, and splits on ellipses", () => {
    const text = "reason: no error or latency signal on checkout_api or\ncheckout_front_api; ~100% HTTP 200 with flat latency against the baseline";
    const parts = markQuotes(text, ["No error or latency signal", "~100% HTTP 200 ... flat latency", null]);
    expect(parts.filter((p) => p.mark).map((p) => p.text)).toEqual(["no error or latency signal", "~100% HTTP 200", "flat latency"]);
    expect(parts.map((p) => p.text).join("")).toBe(text);
    expect(markQuotes("checkout_api or\ncheckout_front_api", ["or checkout_front_api"]).find((p) => p.mark)?.text).toBe("or\ncheckout_front_api");
  });

  it("leaves text without a match unmarked and ignores very short quotes", () => {
    expect(markQuotes("abc", ["zzz"])).toEqual([{ text: "abc", mark: false }]);
    expect(hasMarks(markQuotes("a b c", ["a"]))).toBe(false);
    expect(markQuotes("", ["x"])).toEqual([]);
    // Regex characters in a quote are literal.
    expect(hasMarks(markQuotes("value (x+y) here", ["(x+y) here"]))).toBe(true);
  });

  it("merges overlapping quotes", () => {
    const parts = markQuotes("one two three four", ["one two three", "two three four"]);
    expect(parts).toEqual([{ text: "one two three four", mark: true }]);
  });
});

describe("cohorts", () => {
  const items = [
    { taskId: "a", createdAt: "2026-11-09T10:00:00.000Z" },
    { taskId: "b", createdAt: "2026-11-11T10:00:00.000Z" },
    { taskId: "c", createdAt: null },
  ];

  it("splits at a time, with moves by hand", () => {
    const at = new Date("2026-11-10T16:15:00Z");
    expect(assignByTime(items, ["before", "after"], at)).toEqual([
      { taskId: "a", cohort: "before", moved: false },
      { taskId: "b", cohort: "after", moved: false },
      { taskId: "c", cohort: "before", moved: false },
    ]);
    const moved = assignByTime(items, ["before", "after"], at, { a: "after", b: "nope" });
    expect(moved.map((m) => [m.cohort, m.moved])).toEqual([
      ["after", true],
      ["after", false],
      ["before", false],
    ]);
    expect(cohortSelections(moved, ["before", "after"])).toEqual([
      { by: "tasks", cohort: "before", taskIds: ["c"] },
      { by: "tasks", cohort: "after", taskIds: ["a", "b"] },
    ]);
    expect(cohortCounts(items, moved, ["before", "after"])).toEqual([
      { cohort: "before", n: 1, from: null, to: null },
      { cohort: "after", n: 2, from: "2026-11-09T10:00:00.000Z", to: "2026-11-11T10:00:00.000Z" },
    ]);
    expect(assignByTime(items, [], at)).toEqual([]);
  });
});

describe("readiness", () => {
  const base: ReadinessInput = {
    name: "Late October low scores",
    investigations: 21,
    missingJournalIds: 1,
    missingByInput: [
      { label: "Confirmed root cause", items: 0 },
      { label: "Benchmark scorecard", items: 1 },
    ],
    ready: 20,
    cohorts: [],
    analyzers: { count: 4, words: "run metrics, condensed trace, memory reads and output rules" },
    reviewModelId: "us.example.model",
    connectionFailed: false,
  };

  it("lists the checks in the page file's words", () => {
    expect(readinessRows(base)).toEqual([
      { tone: "success", text: "Name and profile" },
      { tone: "success", text: "21 investigations with cached journals" },
      { tone: "warning", text: "1 ID has no cached journal and is left out" },
      { tone: "warning", text: "1 investigation is missing a scorecard and is skipped" },
      { tone: "success", text: "4 analyzers run first", detail: "Run metrics, condensed trace, memory reads and output rules" },
    ]);
    expect(readinessRows({ ...base, cohorts: [{ label: "Before", items: 15 }, { label: "After", items: 15 }] })).toContainEqual({ tone: "success", text: "2 cohorts, 15 investigations each" });
    expect(readinessRows({ ...base, cohorts: [{ label: "Before", items: 0 }, { label: "After", items: 3 }] })).toContainEqual({ tone: "destructive", text: "Before has no investigations" });
    expect(startLabel(20)).toBe("Start audit with 20 reviews");
  });

  it("adds an Amazon Bedrock row from the model catalogue for the inference Region", () => {
    const row = (kind: BedrockReadiness["kind"], detail: string | null = null, canManageSpace = true) => readinessRows({ ...base, bedrock: { kind, region: "us-east-1", detail }, canManageSpace }).find((r) => r.text.startsWith("Amazon Bedrock"));
    expect(row(null)).toEqual({ tone: "success", text: "Amazon Bedrock in us-east-1" });
    expect(row("no-credentials", "CredentialsProviderError: Could not resolve credentials")).toEqual({
      tone: "destructive",
      text: "Amazon Bedrock: This app has no AWS credentials for this space, so it can't reach AWS. An Admin sets the connection in Space settings.",
      detail: "CredentialsProviderError: Could not resolve credentials (Region us-east-1)",
    });
    expect(row("no-credentials", null, false)?.text).toBe("Amazon Bedrock: This app has no AWS credentials for this space, so it can't reach AWS. Ask an Admin to check the connection in Space settings.");
    expect(row("access-denied", "IAM actions refused: bedrock:ListInferenceProfiles, bedrock:ListFoundationModels")).toEqual({
      tone: "warning",
      text: "Amazon Bedrock: Can't list models; a typed ID is used as is",
      detail: "IAM actions refused: bedrock:ListInferenceProfiles, bedrock:ListFoundationModels (Region us-east-1)",
    });
    expect(row("throttled")?.tone).toBe("warning");
    expect(row("timeout")?.text).toMatch(/can't check it right now/);
    // Without a check (an older caller), no row.
    expect(readinessRows(base).some((r) => r.text.startsWith("Amazon Bedrock"))).toBe(false);
  });

  it("says why Start is disabled, the model last but one", () => {
    expect(startBlockedReason(base)).toBeNull();
    expect(startBlockedReason({ ...base, name: " " })).toBe("Enter a name.");
    expect(startBlockedReason({ ...base, investigations: 0 })).toBe("Choose at least one investigation.");
    expect(startBlockedReason({ ...base, ready: 0 })).toBe("Every investigation is missing ground truth. Upload it first.");
    expect(startBlockedReason({ ...base, cohorts: [{ label: "After the revision", items: 0 }] })).toBe("After the revision has no investigations.");
    expect(startBlockedReason({ ...base, reviewModelId: null })).toBe(NO_REVIEW_MODEL_REASON);
    expect(startBlockedReason({ ...base, connectionFailed: true })).toBe(CONNECTION_FAILED_REASON);
  });

  it("disables Start with the shared sentence when the app has no AWS credentials, and only then", () => {
    const at = (kind: BedrockReadiness["kind"], canManageSpace = false) => startBlockedReason({ ...base, bedrock: { kind, region: "us-west-2", detail: null }, canManageSpace });
    expect(at("no-credentials")).toBe("This app has no AWS credentials for this space, so it can't reach AWS. Ask an Admin to check the connection in Space settings.");
    expect(at("no-credentials", true)).toBe("This app has no AWS credentials for this space, so it can't reach AWS. An Admin sets the connection in Space settings.");
    for (const k of [null, "access-denied", "throttled", "network", "expired", "timeout", "other"] as const) expect(at(k)).toBeNull();
  });
});

describe("readiness for a reviewer that is not a Bedrock model", () => {
  const input: ReadinessInput = {
    name: "Hand-off run",
    investigations: 3,
    missingJournalIds: 0,
    missingByInput: [],
    ready: 3,
    cohorts: [],
    analyzers: { count: 4, words: "run metrics, condensed trace, memory reads and output rules" },
    reviewModelId: null,
    connectionFailed: true,
    bedrock: { kind: "no-credentials", region: "us-west-2", detail: null },
    reviewer: { runner: "handoff", label: "Review files" },
  };

  it("needs no review model, no Bedrock check and no AWS connection for review files", () => {
    expect(startBlockedReason(input)).toBeNull();
    const rows = readinessRows(input);
    expect(rows.some((r) => r.text.startsWith("Amazon Bedrock"))).toBe(false);
    expect(rows).toContainEqual({ tone: "success", text: "Reviews by Review files", detail: "The app calls no model and needs no access to Amazon Bedrock." });
    expect(startLabel(3, "handoff")).toBe("Start audit with 3 review files");
    expect(startLabel(1, "handoff")).toBe("Start audit with 1 review file");
  });

  it("still checks the AWS connection for another runner, but not the model or Bedrock", () => {
    const chat = { ...input, reviewer: { runner: "devops-agent-chat", label: "DevOps Agent chat" } };
    expect(startBlockedReason(chat)).toBe(CONNECTION_FAILED_REASON);
    expect(startBlockedReason({ ...chat, connectionFailed: false })).toBeNull();
    expect(readinessRows(chat).find((r) => r.text.startsWith("Reviews by"))).toEqual({ tone: "success", text: "Reviews by DevOps Agent chat", detail: null });
  });

  it("keeps every Bedrock check when the reviewer is the Bedrock model, or none is given", () => {
    const bedrock = { ...input, reviewer: { runner: "ai-sdk", label: "Amazon Bedrock model" } };
    expect(startBlockedReason(bedrock)).toBe(NO_REVIEW_MODEL_REASON);
    expect(startBlockedReason({ ...bedrock, reviewModelId: "m" })).toContain("no AWS credentials");
    expect(readinessRows(bedrock).some((r) => r.text.startsWith("Amazon Bedrock"))).toBe(true);
    expect(readinessRows(bedrock).some((r) => r.text.startsWith("Reviews by"))).toBe(false);
    expect(startBlockedReason({ ...input, reviewer: undefined })).toBe(NO_REVIEW_MODEL_REASON);
  });

  it("words the Start card and a waiting item for review files", () => {
    expect(itemReviewBadge("pending", "Waiting for a review file")).toMatchObject({ tone: "neutral", label: "Waiting for a review file" });
    expect(itemReviewBadge("pending").label).toBe("Waiting");
    expect(itemReviewBadge("reviewed", "Waiting for a review file").label).toBe("Reviewed");
    expect(reviewerFacts("handoff")[0]![0]).toBe("Review files");
    expect(reviewerFacts("handoff")[0]![1]).toMatch(/approved/);
    expect(reviewerFacts("ai-sdk")).toEqual([]);
    expect(startHelp("handoff")).toMatch(/download the review files/);
    expect(startHelp("ai-sdk")).toMatch(/Each review reads only its own investigation/);
    expect(reviewedBy("handoff", "Claude Code, Opus 5.5")).toBe("Claude Code, Opus 5.5, from a review file");
    expect(reviewedBy("ai-sdk", "us.model")).toBe("us.model");
  });
});

describe("audit state words", () => {
  const items = (o: Partial<Record<"pending" | "analyzing" | "reviewing" | "reviewed" | "failed" | "skipped", number>>) => ({ pending: 0, analyzing: 0, reviewing: 0, reviewed: 0, failed: 0, skipped: 0, ...o });

  it("says Reviews failed when every review failed, never In review", () => {
    const f = { items: items({ failed: 2 }), findings: { proposed: 0, total: 0 } };
    expect(auditStateBadge("reviewing", f)).toMatchObject({ tone: "destructive", label: "Reviews failed" });
    expect(reviewProgressText(f.items)).toEqual({ value: "0 of 2 reviewed", failed: "2 failed" });
    // One still reviewing: not settled yet.
    expect(auditStateBadge("reviewing", { ...f, items: items({ failed: 1, reviewing: 1 }) }).label).toBe("In review");
    expect(auditStateBadge("running", f).label).toBe("Running");
  });

  it("says Ready to save the record when every investigation is reviewed and every finding decided", () => {
    expect(auditStateBadge("reviewing", { items: items({ reviewed: 3 }), findings: { proposed: 0, total: 12 } })).toMatchObject({ tone: "success", label: "Ready to save the record" });
    expect(auditStateBadge("reviewing", { items: items({ reviewed: 2, skipped: 1 }), findings: { proposed: 0, total: 5 } }).label).toBe("Ready to save the record");
    expect(auditStateBadge("reviewing", { items: items({ reviewed: 3 }), findings: { proposed: 1, total: 12 } }).label).toBe("In review");
    // A failed review blocks finalize (pages/audit-report.md), so it isn't ready.
    expect(auditStateBadge("reviewing", { items: items({ reviewed: 2, failed: 1 }), findings: { proposed: 0, total: 8 } }).label).toBe("In review");
    expect(auditStateBadge("finalized", { items: items({ reviewed: 3 }), findings: { proposed: 0, total: 12 } }).label).toBe("Record saved");
    expect(auditStateBadge("reviewing", null)).toBe(AUDIT_STATE_BADGE.reviewing);
  });

  it("groups failures by cause and offers a rerun only where one can help", () => {
    const noCreds = "The model call failed: CredentialsProviderError: Could not resolve credentials using profile: [x].";
    const failed = [
      { id: "1", incidentId: "INCIDENT-1", taskId: "t1", stateReason: noCreds },
      { id: "2", incidentId: "INCIDENT-2", taskId: "t2", stateReason: noCreds },
      { id: "3", incidentId: "INCIDENT-3", taskId: "t3", stateReason: "The model call failed: ThrottlingException: Rate exceeded" },
      { id: "4", incidentId: "INCIDENT-4", taskId: "t4", stateReason: "The model call failed: AccessDeniedException: not authorized to perform: bedrock:InvokeModel" },
    ];
    const groups = failureGroups(failed, { canManage: false, stepLimit: 40, accessWorksNow: false });
    expect(groups.map((g) => [g.kind, g.incidents, g.rerun])).toEqual([
      ["no-credentials", ["INCIDENT-1", "INCIDENT-2"], false],
      ["throttled", ["INCIDENT-3"], true],
      ["access-denied", ["INCIDENT-4"], false],
    ]);
    expect(groups[2]!.text).toBe("AWS refused the request: the space's read role isn't allowed to call the review model in Amazon Bedrock. Ask your AWS admin to allow it.");
    expect(groups[0]!.details[0]!.reason).toBe(noCreds);
    expect(failureNextStep(groups, true)).toBe("Rerun the one a rerun can fix; the others need the cause fixed first.");
    // Once the space reaches Bedrock again, the credential failures can be rerun; refused access still can't.
    const later = failureGroups(failed, { canManage: false, stepLimit: 40, accessWorksNow: true });
    expect(later.map((g) => g.rerun)).toEqual([true, true, false]);
    expect(failureNextStep(failureGroups(failed.slice(0, 2), { canManage: true, stepLimit: 40, accessWorksNow: false }), true)).toBe("A rerun would fail the same way until that is fixed. The report counts only accepted findings.");
    expect(incidentList(["A", "B", "C", "D", "E"])).toBe("A, B, C and 2 more");
  });
});

describe("next incident", () => {
  const it_ = (id: string, incidentId: string, proposed: number, flaggedProposed = 0) => ({ id, incidentId, taskId: id, findings: { proposed }, flaggedProposed });

  it("picks incidents with proposed findings, flagged ones first, then in table order, never the current one", () => {
    const items = [it_("a", "INCIDENT-31744", 2), it_("b", "INCIDENT-31801", 0), it_("c", "INCIDENT-31808", 1, 1), it_("d", "INCIDENT-9", 3)];
    expect(nextIncidentToReview(items)?.id).toBe("c");
    expect(nextIncidentToReview(items, "c")?.id).toBe("d");
    expect(nextIncidentToReview(items.filter((i) => i.id !== "c"), "d")?.id).toBe("a");
    expect(nextIncidentToReview([it_("a", "I-1", 0)])).toBeNull();
    expect(nextIncidentToReview([it_("a", "I-1", 2)], "a")).toBeNull();
  });
});

describe("finding cards", () => {
  const f = (key: string, extra: Partial<CardField> = {}): CardField => ({ key, label: key, value: "v", valueLabel: "v", editable: false, choices: null, multiple: false, changed: false, ...extra });

  it("puts reasons and notes under their field and leaves hidden fields out", () => {
    const rows = cardRows([f("primary_failure_mode"), f("reachability"), f("reachability_reason"), f("scorecard_fair"), f("scorecard_notes"), f("one_line"), f("near_miss")], ["one_line"]);
    expect(rows.map((r) => [r.field.key, r.detail?.key ?? null])).toEqual([
      ["primary_failure_mode", null],
      ["reachability", "reachability_reason"],
      ["scorecard_fair", "scorecard_notes"],
      ["near_miss", null],
    ]);
  });

  it("files citations under the field they support", () => {
    expect(citationField({ field: "near_miss" }, "$")).toBe("near_miss");
    expect(citationField({ field: "citations[3]", supports: "reachability_reason" }, "$")).toBe("reachability_reason");
    expect(citationField({ field: "fixes[2].evidence[1]" }, "fixes")).toBe("evidence");
    expect(citationField({ field: "issues[0].evidence[0]" }, "issues")).toBe("evidence");
    const cs = [
      { record: 115, quote: null, field: "near_miss", ok: true },
      { record: 65, quote: "q", field: "near_miss", ok: true },
      { record: 65, quote: null, field: "citations[0]", supports: "near_miss", ok: false, problem: "quote-not-found" as const },
      { record: 9, quote: null, field: "quality_notes[0]", ok: true },
    ];
    const by = citationsByField(cs, "$", ["near_miss"]);
    expect(by.get("near_miss")!.map((c) => [c.record, c.ok])).toEqual([
      [65, false],
      [115, true],
    ]);
    expect(by.get("")!.map((c) => c.record)).toEqual([9]);
    expect(quotesFor(cs, 65)).toEqual(["q"]);
  });

  it("opens the first passing citation of the first proposed finding", () => {
    const cs = (n: number, ok = true) => ({ record: n, quote: null, field: "x", ok });
    expect(firstCitation([{ state: "accepted", citations: [cs(1)] }, { state: "proposed", citations: [cs(171, false), cs(19)] }])!.record).toBe(19);
    expect(firstCitation([{ state: "accepted", citations: [cs(2)] }])!.record).toBe(2);
    expect(firstCitation([])).toBeNull();
  });

  it("sends only changed values", () => {
    expect(changedValues({ owner: "a", fix: "x", modes: ["A"] }, { owner: "a", fix: "y", modes: ["A", "B"] })).toEqual({ fix: "y", modes: ["A", "B"] });
  });
});

describe("list params", () => {
  it("reads and writes the audits list", () => {
    expect(parseAuditListParams({})).toEqual({ state: "open", profile: "", q: "", show: 50 });
    const p = parseAuditListParams({ state: "finalized", profile: "benchmark", q: " nov ", show: "120" });
    expect(p).toEqual({ state: "finalized", profile: "benchmark", q: "nov", show: 150 });
    expect(auditListQuery(p)).toBe("?state=finalized&profile=benchmark&q=nov&show=150");
    expect(parseAuditListParams({ state: "bogus" }).state).toBe("open");
    expect(auditListQuery({ state: "open", show: 50 })).toBe("");
  });

  it("reads and writes the tabs", () => {
    expect(parseItemListParams({ show: "failed", q: "418" })).toEqual({ show: "failed", q: "418", rows: 50 });
    expect(itemListQuery({ show: "all", q: "" })).toBe("");
    expect(parseFindingListParams({ state: "all", kind: "fix", mode: "F_premature_ruleout" })).toMatchObject({ state: "all", kind: "fix", mode: "F_premature_ruleout", owner: "" });
    expect(parseFindingListParams({ state: "nope" }).state).toBe("");
    expect(findingListQuery({ state: "all", rows: 100 })).toBe("?state=all&rows=100");
    expect(defaultFindingState("reviewing")).toBe("proposed");
    expect(defaultFindingState("finalized")).toBe("all");
    expect(filterQuery({ state: "open", profile: "x", q: "" }, { state: "open", profile: "" })).toBe("?profile=x");
  });
});

describe("the selected finding in the address", () => {
  const id = "11111111-2222-4333-8444-555555555555";

  it("reads ?finding= and keeps only an ID", () => {
    expect(parseFindingListParams({ finding: id }).finding).toBe(id);
    expect(parseFindingListParams({ finding: id.toUpperCase() }).finding).toBe(id.toUpperCase());
    expect(parseFindingListParams({ finding: "../../etc" }).finding).toBe("");
    expect(parseFindingListParams({}).finding).toBe("");
  });

  it("writes it back, with the other filters and the default left out", () => {
    expect(findingListQuery({ state: "accepted", finding: id })).toBe(`?state=accepted&finding=${id}`);
    expect(findingListQuery({ finding: id })).toBe(`?finding=${id}`);
    expect(findingListQuery({ state: "", finding: "" })).toBe("");
  });

  it("reads the Next step filter", () => {
    expect(parseFindingListParams({ fix: "open" }).fix).toBe("open");
    expect(parseFindingListParams({ fix: "package" }).fix).toBe("package");
    expect(parseFindingListParams({ fix: "bogus" }).fix).toBe("");
    expect(findingListQuery({ state: "accepted", fix: "package" })).toBe("?state=accepted&fix=package");
  });
});

describe("the evidence list", () => {
  const c = (record: number, quote: string | null, ok = true, checked = false) => ({ record, quote, field: "evidence[0]", ok, ...(ok ? {} : { problem: "quote-not-found" as const }), ...(checked ? { checked: { by: "Alex", at: "now", note: "fine" } } : {}) });

  it("has a row for each record and quote, in record order", () => {
    const rows = evidenceRows([c(153, "b"), c(12, "a"), c(12, "a"), c(12, "other")]);
    expect(rows.map((r) => [r.record, r.quote])).toEqual([
      [12, "a"],
      [12, "other"],
      [153, "b"],
    ]);
  });

  it("keeps the failed copy of a citation over a passed one, and the checked failure over the unchecked one", () => {
    expect(evidenceRows([c(1, "q"), c(1, "q", false)])[0]!.ok).toBe(false);
    expect(evidenceRows([c(1, "q", false), c(1, "q", false, true)])[0]!.checked).toBeUndefined();
    expect(evidenceRows([c(1, "q", false, true), c(1, "q", false)])[0]!.checked).toBeUndefined();
  });

  it("says what the check found under each citation", () => {
    expect(citationResult(c(12, "the cache path is healthy"), 200)).toEqual({ tone: "success", text: "The quoted text is in R12." });
    expect(citationResult(c(12, null), 200)).toEqual({ tone: "success", text: "R12 exists in this journal." });
    expect(citationResult(c(12, "x", false), 200)).toEqual({ tone: "warning", text: "The text quoted from R12 isn't in that record." });
    expect(citationResult({ record: 43, quote: "x", ok: false, problem: "missing-record" }, 41)).toEqual({ tone: "warning", text: "R43 doesn't exist: this journal has 41 records." });
    expect(citationResult(c(12, "x", false, true), 200)).toEqual({ tone: "warning", text: "Checked by Alex: fine" });
  });

  it("sums the evidence up", () => {
    expect(evidenceSummary([])).toEqual({ tone: "muted", label: "No records cited" });
    expect(evidenceSummary([c(1, "a"), c(2, "b")])).toEqual({ tone: "success", label: "2 citations passed" });
    expect(evidenceSummary([c(1, "a"), c(2, "b", false)])).toEqual({ tone: "warning", label: "1 of 2 failed the check" });
    expect(evidenceSummary([c(1, "a"), c(2, "b", false, true)])).toEqual({ tone: "success", label: "1 failed citation checked by a reviewer" });
  });
});

describe("words for the flow", () => {
  it("words the audits list's footer links for the audits it leaves out", () => {
    expect(showClosedText("cancelled", 2)).toBe("Show 2 cancelled audits");
    expect(showClosedText("cancelled", 1)).toBe("Show 1 cancelled audit");
    expect(showClosedText("finalized", 3)).toBe("Show 3 audits with a saved record");
    expect(showClosedText("finalized", 1)).toBe("Show 1 audit with a saved record");
  });

  it("words the plan a finding went to", () => {
    expect(planStateWords("waiting")).toBe("waiting for approval");
    expect(planStateWords("applied")).toBe("applied");
    expect(planStateWords("odd")).toBe("odd");
  });

  it("words the confirm button of 'Add to revision…'", () => {
    expect(confirmRevisionLabel({ acceptFirst: false, target: { name: "moss-lag-fixes" } })).toBe("Add to moss-lag-fixes");
    expect(confirmRevisionLabel({ acceptFirst: true, target: { name: "v2.4" } })).toBe("Accept and add to v2.4");
    expect(confirmRevisionLabel({ acceptFirst: false, target: "new" })).toBe("Add to a new revision");
  });
});
