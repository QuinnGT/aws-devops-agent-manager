import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { fieldLabel, fieldValueLabel } from "./loaders";

/** Field and value labels the incident page reads from the profile. */
describe("finding field labels from the profile", () => {
  const { profiles } = getAppPolicy().policy.audits;
  const bench = profiles.benchmark!;
  const ba = profiles["before-after"]!;

  it("labels the benchmark fields in plain words", () => {
    expect(fieldLabel(bench, "failure_modes", "diagnosis")).toBe("Also seen");
    expect(fieldLabel(bench, "reachability", "diagnosis")).toBe("Within reach");
    expect(fieldLabel(bench, "owner", "fix")).toBe("Owner");
    expect(fieldLabel(bench, "owner")).toBe("Owner");
    // A field without a label falls back to the key in words.
    expect(fieldLabel(bench, "timing_note", "diagnosis")).toBe("Timing note");
  });

  it("labels enum values: failure modes and owners from the profile, others from valueLabels", () => {
    expect(fieldValueLabel(bench, "reachability", "partially_reachable", "diagnosis")).toBe("Partly reachable");
    expect(fieldValueLabel(bench, "scorecard_fair", "not_applicable", "diagnosis")).toBe("Not applicable");
    expect(fieldValueLabel(bench, "primary_failure_mode", "F_premature_ruleout", "diagnosis")).toBe("Ruled out too early");
    expect(fieldValueLabel(bench, "failure_modes", ["C_change_anchoring", "J_summary_mismatch"], "diagnosis")).toBe("Anchored on a change, Summary mismatch");
    expect(fieldValueLabel(bench, "owner", "customer_trigger", "fix")).toBe("Customer trigger context");
    expect(fieldValueLabel(ba, "conclusion_support", "partly_supported", "case")).toBe("Partly supported");
    expect(fieldValueLabel(ba, "priority", "P1")).toBe("P1: fix before relying on it");
    expect(fieldValueLabel(bench, "near_miss", "free text", "diagnosis")).toBe("free text");
  });

  it("names the fields each card leaves out and an example file name per input", () => {
    expect(bench.findings.find((f) => f.kind === "diagnosis")!.cardHidden).toEqual(["one_line", "score", "ground_truth", "agent_final_answer"]);
    expect(bench.inputs.map((i) => i.fileNameExample)).toEqual(["INCIDENT-20101_actual_rca.md", "INCIDENT-20101_scorecard.md"]);
    for (const i of bench.inputs) expect(new RegExp(i.fileNamePattern).test(i.fileNameExample!)).toBe(true);
  });
});
