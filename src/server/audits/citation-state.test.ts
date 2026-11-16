import { describe, expect, it } from "vitest";
import { citationProblemCounts, hasOpenProblem, markChecked } from "./citation-state";
import type { Citation } from "./contract";
import { rerunCanHelp, reviewFailureKind } from "./failure";

const c = (record: number, ok: boolean, extra: Partial<Citation> = {}): Citation => ({ record, quote: null, field: "near_miss", ok, ...(ok ? {} : { problem: "quote-not-found" as const }), ...extra });

describe("checked citations", () => {
  it("marks every failed citation of the record as checked and keeps the check's result", () => {
    const cs = [c(121, false, { field: "reachability_reason" }), c(121, false, { field: "near_miss" }), c(121, true, { field: "one_line" }), c(19, false)];
    const checked = { by: "alex@example.com", at: "2026-11-13T22:00:00.000Z", note: "The numbers are there; only the dash differs." };
    const out = markChecked(cs, 121, checked);
    expect(out.changed).toBe(2);
    expect(out.citations.filter((x) => x.record === 121 && !x.ok).every((x) => x.checked === checked && x.problem === "quote-not-found")).toBe(true);
    expect(out.citations.find((x) => x.record === 121 && x.ok)?.checked).toBeUndefined();
    expect(citationProblemCounts(out.citations)).toEqual({ open: 1, checked: 2 });
    expect(hasOpenProblem(out.citations)).toBe(true);
    // The first reviewer's note stays.
    expect(markChecked(out.citations, 121, { ...checked, by: "sam@example.com" }).changed).toBe(0);
    expect(hasOpenProblem(markChecked(out.citations, 19, checked).citations)).toBe(false);
  });
});

describe("review failures", () => {
  it("reads the cause from the stored reason", () => {
    expect(reviewFailureKind("The model call failed: CredentialsProviderError: Could not resolve credentials using profile: [x]")).toBe("no-credentials");
    expect(reviewFailureKind("The model call failed: AccessDeniedException: not authorized to perform: bedrock:InvokeModel")).toBe("access-denied");
    expect(reviewFailureKind("The model call failed: ThrottlingException: Too many requests")).toBe("throttled");
    expect(reviewFailureKind("The step limit (40) was reached without output.")).toBe("step-limit");
    expect(reviewFailureKind("The review timed out after 900 seconds, during step 12.")).toBe("timeout");
    expect(reviewFailureKind("The output does not match the schema (3 errors).")).toBe("schema");
    expect(reviewFailureKind("The journal is not in the journal cache.")).toBe("no-journal");
    expect(reviewFailureKind("The model call failed: ValidationException: bad model")).toBe("model");
    expect(reviewFailureKind(null)).toBe("other");
  });

  it("offers a rerun for causes a rerun can fix", () => {
    for (const k of ["throttled", "network", "timeout", "step-limit", "schema", "model", "interrupted", "other"] as const) expect(rerunCanHelp(k)).toBe(true);
    for (const k of ["no-credentials", "expired", "access-denied", "no-journal", "analyzers", "no-model"] as const) expect(rerunCanHelp(k)).toBe(false);
    expect(rerunCanHelp("no-credentials", true)).toBe(true);
    expect(rerunCanHelp("access-denied", true)).toBe(false);
  });
});
