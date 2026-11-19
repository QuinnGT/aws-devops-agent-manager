import { Ajv2020 } from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { getAppPolicy, readPolicyFile } from "@/server/policy";
import { auditActions, findingActions, itemActions } from "./actions";
import { checkEdits, enumOf, itemSchemaOf, propertySchemas } from "./edits";
import { AuditRequestError } from "./errors";
import { humanize, progressOf, recordHref, valueLabel } from "./loaders";
import { getProfile, listProfiles, readOutputSchema } from "./profiles";
import { itemReadiness, summarizeReadiness } from "./readiness";
import { carryDecision, reviewFailureReason } from "./run";
import { assignCohorts, assertWithinLimit } from "./selection";
import { nextFindingState, stateAfterItemsFinished, canRerunItem, auditStateReason } from "./states";
import type { FindingRow } from "./store";

const loaded = getAppPolicy();
const policy = loaded.policy;
const benchmark = policy.audits.profiles.benchmark!;
const beforeAfter = policy.audits.profiles["before-after"]!;
const schemaOf = (p: typeof benchmark) => readOutputSchema(p, loaded.dirs)!;

describe("audit profiles in the app policy", () => {
  it("lists both profiles, benchmark as the default", () => {
    expect(listProfiles(policy).map((p) => [p.id, p.isDefault])).toEqual([
      ["benchmark", true],
      ["before-after", false],
    ]);
    expect(getProfile(policy, null).id).toBe("benchmark");
    expect(() => getProfile(policy, "nope")).toThrow(AuditRequestError);
  });

  it.each(["benchmark", "before-after"])("%s: every extractor field, editable field and title placeholder is in the output schema", (id) => {
    const p = policy.audits.profiles[id]!;
    const schema = schemaOf(p);
    for (const ex of p.findings) {
      const item = itemSchemaOf(schema, ex)!;
      const props = Object.keys(item.properties as object);
      for (const f of [...ex.fields, ...ex.editable]) expect(props, `${ex.kind}.${f}`).toContain(f);
      for (const f of ex.editable) expect(ex.fields).toContain(f);
      if (ex.summaryField) expect(ex.fields).toContain(ex.summaryField);
      for (const m of ex.title.matchAll(/\{(\w+)\}/g)) if (m[1] !== "incidentId") expect(props).toContain(m[1]);
    }
  });

  it("before-after: the schema compiles, its enums match the profile's areas and owners, and its brief exists", () => {
    const schema = schemaOf(beforeAfter);
    expect(() => new Ajv2020({ strict: false }).compile(schema)).not.toThrow();
    const issue = propertySchemas(schema, { from: "issues" }, ["area", "owner"]);
    expect(enumOf(issue.area)).toEqual(beforeAfter.failureModes.map((m) => m.id));
    expect(enumOf(issue.owner)).toEqual(beforeAfter.fixOwners.map((o) => o.id));
    expect(enumOf(propertySchemas(schema, { from: "$" }, ["cohort"]).cohort)).toEqual(beforeAfter.cohorts.map((c) => c.id));
    expect(readPolicyFile(loaded.dirs, beforeAfter.review.promptTemplate)).toContain("{{condensed_trace}}");
    expect(beforeAfter.inputs.every((i) => !i.required)).toBe(true);
  });

  it("benchmark: failure modes and owners match the schema's enums", () => {
    const schema = schemaOf(benchmark);
    expect(enumOf(propertySchemas(schema, { from: "$" }, ["primary_failure_mode"]).primary_failure_mode)).toEqual(benchmark.failureModes.map((m) => m.id));
    expect(enumOf(propertySchemas(schema, { from: "fixes" }, ["owner"]).owner)).toEqual(benchmark.fixOwners.map((o) => o.id));
    expect(benchmark.inputs.find((i) => i.kind === "scorecard")!.fields.score!.column).toBe(true);
  });
});

describe("finding edits", () => {
  const schema = schemaOf(benchmark);
  const diagnosis = benchmark.findings.find((f) => f.kind === "diagnosis")!;
  const fix = benchmark.findings.find((f) => f.kind === "fix")!;
  const current = { primary_failure_mode: "D_wrong_component", failure_modes: ["D_wrong_component"], one_line: "x", ground_truth: "gt" };

  it("accepts edits that pass the schema property and reports what changed", () => {
    const r = checkEdits(schema, diagnosis, current, { primary_failure_mode: "F_premature_ruleout", failure_modes: ["F_premature_ruleout", "D_wrong_component"], one_line: "x" });
    expect(r).toMatchObject({ ok: true, changed: ["primary_failure_mode", "failure_modes"] });
    expect(r.values).toMatchObject({ primary_failure_mode: "F_premature_ruleout", ground_truth: "gt" });
    expect(checkEdits(schema, fix, { owner: "instructions", fix: "a" }, { owner: "aws_service" }).ok).toBe(true);
  });

  it("refuses fields that are not editable and values the schema rejects", () => {
    const r = checkEdits(schema, diagnosis, current, { ground_truth: "changed", primary_failure_mode: "Z_unknown", failure_modes: [], one_line: "y".repeat(301) });
    expect(r.ok).toBe(false);
    const by = Object.fromEntries(r.errors.map((e) => [e.field, e.message]));
    expect(by.ground_truth).toContain("can't be edited");
    expect(by.primary_failure_mode).toContain("must be one of");
    expect(by.failure_modes).toContain("at least 1");
    expect(by.one_line).toContain("at most 300 characters");
    expect(checkEdits(schema, fix, { owner: "x" }, { owner: 3 }).ok).toBe(false);
    expect(checkEdits(schema, diagnosis, current, {}).errors[0]!.message).toBe("There is nothing to change.");
    expect(checkEdits(null, diagnosis, current, { one_line: "y" }).errors[0]!.message).toContain("does not describe");
  });

  it("describes enum fields for the edit form", () => {
    const props = propertySchemas(schema, diagnosis, diagnosis.editable);
    expect(enumOf(props.failure_modes, schema)).toHaveLength(12);
    expect(enumOf(props.one_line)).toBeNull();
  });
});

describe("state rules", () => {
  it("moves findings between proposed, accepted and rejected", () => {
    expect(nextFindingState("proposed", "accept")).toBe("accepted");
    expect(nextFindingState("rejected", "accept")).toBe("accepted");
    expect(nextFindingState("accepted", "accept")).toBeNull();
    expect(nextFindingState("accepted", "reject")).toBe("rejected");
    expect(nextFindingState("rejected", "reject")).toBeNull();
    expect(nextFindingState("accepted", "reopen")).toBe("proposed");
    expect(nextFindingState("proposed", "reopen")).toBeNull();
    expect(nextFindingState("accepted", "edit")).toBe("accepted");
    expect(nextFindingState("rejected", "edit")).toBeNull();
  });

  it("moves a running audit to reviewing once every item is finished", () => {
    expect(stateAfterItemsFinished("running", ["reviewed", "failed", "skipped"])).toBe("reviewing");
    expect(stateAfterItemsFinished("running", ["reviewed", "reviewing"])).toBe("running");
    expect(stateAfterItemsFinished("cancelled", ["reviewed"])).toBe("cancelled");
  });

  it("allows a rerun only of a finished item while the audit runs or is reviewed", () => {
    expect(canRerunItem("reviewing", "reviewed")).toBe(true);
    expect(canRerunItem("running", "failed")).toBe(true);
    expect(canRerunItem("reviewing", "reviewing")).toBe(false);
    expect(canRerunItem("finalized", "reviewed")).toBe(false);
    expect(auditStateReason("delete", "running")).toBe("A running audit can't be deleted.");
  });
});

describe("readiness", () => {
  const item = { id: "i1", taskId: "t1", incidentId: "INCIDENT-1" };

  it("needs the journal and every required document", () => {
    expect(itemReadiness(item, { journalPresent: true, docKinds: new Set(["actual_rca", "scorecard"]) }, benchmark)).toMatchObject({ ready: true, reason: null, missing: [] });
    const r = itemReadiness(item, { journalPresent: false, docKinds: new Set(["actual_rca"]) }, benchmark);
    expect(r.ready).toBe(false);
    expect(r.missing.map((m) => m.kind)).toEqual(["scorecard"]);
    expect(r.reason).toBe("The journal is not in the journal cache. Missing Benchmark scorecard.");
    expect(itemReadiness({ ...item, incidentId: null }, { journalPresent: true, docKinds: new Set() }, benchmark).reason).toContain("no incident ID");
  });

  it("treats optional inputs as not blocking", () => {
    const r = itemReadiness(item, { journalPresent: true, docKinds: new Set(["actual_rca"]) }, beforeAfter);
    expect(r).toMatchObject({ ready: true, present: [{ kind: "actual_rca" }] });
    expect(itemReadiness(item, { journalPresent: true, docKinds: new Set() }, beforeAfter).ready).toBe(true);
  });

  it("summarizes by missing kind", () => {
    const rs = [
      itemReadiness(item, { journalPresent: true, docKinds: new Set(["actual_rca", "scorecard"]) }, benchmark),
      itemReadiness({ ...item, id: "i2" }, { journalPresent: true, docKinds: new Set(["actual_rca"]) }, benchmark),
      itemReadiness({ ...item, id: "i3" }, { journalPresent: false, docKinds: new Set() }, benchmark),
    ];
    expect(summarizeReadiness(rs, benchmark)).toEqual({
      total: 3,
      ready: 1,
      notReady: 2,
      missingJournal: 1,
      missingByKind: [
        { kind: "actual_rca", label: "Confirmed root cause", items: 1 },
        { kind: "scorecard", label: "Benchmark scorecard", items: 2 },
      ],
    });
  });
});

describe("cohorts and limits", () => {
  const t = (taskId: string) => ({ taskId, incidentId: null });

  it("assigns cohorts and refuses a task in two cohorts", () => {
    expect(assignCohorts([{ cohort: "before", tasks: [t("a"), t("b")] }, { cohort: "after", tasks: [t("c")] }, { cohort: "before", tasks: [t("a")] }], beforeAfter)).toEqual([
      { taskId: "a", incidentId: null, cohort: "before" },
      { taskId: "b", incidentId: null, cohort: "before" },
      { taskId: "c", incidentId: null, cohort: "after" },
    ]);
    expect(() => assignCohorts([{ cohort: "before", tasks: [t("a")] }, { cohort: "after", tasks: [t("a")] }], beforeAfter)).toThrow("two cohorts");
    expect(() => assignCohorts([{ cohort: null, tasks: [t("a")] }], beforeAfter)).toThrow("Choose a cohort");
    expect(() => assignCohorts([{ cohort: "during", tasks: [t("a")] }], beforeAfter)).toThrow("not a cohort");
  });

  it("takes no cohort for a profile without cohorts", () => {
    expect(assignCohorts([{ tasks: [t("a"), t("a")] }], benchmark)).toEqual([{ taskId: "a", incidentId: null, cohort: null }]);
    expect(() => assignCohorts([{ cohort: "before", tasks: [t("a")] }], benchmark)).toThrow("does not compare cohorts");
  });

  it("enforces maxItemsPerAudit", () => {
    expect(() => assertWithinLimit(policy.audits.maxItemsPerAudit + 1, policy.audits.maxItemsPerAudit)).toThrow("at most 500");
    expect(() => assertWithinLimit(3, 3)).not.toThrow();
  });
});

describe("reruns", () => {
  const prev = (over: Partial<FindingRow>): FindingRow =>
    ({ id: "f-old", kind: "fix", ordinal: 0, state: "accepted", proposed: { owner: "instructions", fix: "a" }, current: { owner: "aws_service", fix: "a" }, edited: true, reviewNote: "n", reviewedBy: "p@example.com", ...over }) as FindingRow;

  it("carries a decision only to the same kind, position and proposed values", () => {
    const next = { kind: "fix", ordinal: 0, title: "a", values: { fix: "a", owner: "instructions" }, citations: [] };
    expect(carryDecision([prev({})], next)?.id).toBe("f-old");
    expect(carryDecision([prev({ state: "proposed" })], next)).toBeNull();
    expect(carryDecision([prev({ ordinal: 1 })], next)).toBeNull();
    expect(carryDecision([prev({})], { ...next, values: { fix: "b", owner: "instructions" } })).toBeNull();
  });

  it("says why a review gave no findings", () => {
    expect(reviewFailureReason({ state: "failed", error: "Throttled", schemaValid: false, schemaErrors: [], output: null })).toBe("Throttled");
    expect(
      reviewFailureReason({ state: "failed", error: "The output does not match the schema (1 error).", schemaValid: false, schemaErrors: ["timing.incident_created must NOT have more than 100 characters"], output: {} }),
    ).toBe("The output does not match the schema (1 error). timing.incident_created must NOT have more than 100 characters.");
    expect(reviewFailureReason({ state: "succeeded", error: null, schemaValid: false, schemaErrors: ["/score must be string"], output: {} })).toContain("/score must be string");
    expect(reviewFailureReason({ state: "succeeded", error: null, schemaValid: true, schemaErrors: [], output: null })).toBe("The model returned no structured output.");
  });
});

describe("page helpers and buttons", () => {
  const all = { permissions: ["audits.read", "audits.run", "findings.review"] as const };
  const readOnly = { permissions: ["audits.read"] as const };

  it("links a record on its journal page", () => {
    expect(recordHref("test space", "task/1", "rec-9", 0, 50)).toBe("/spaces/test%20space/journals/investigations/task%2F1#rec-rec-9");
    expect(recordHref("s", "t", "r", 120, 50)).toBe("/spaces/s/journals/investigations/t?page=3#rec-r");
  });

  it("labels values and fields", () => {
    expect(valueLabel(benchmark, "D_wrong_component")).toBe("Wrong component");
    expect(valueLabel(benchmark, ["customer_access", "other"])).toBe("Customer tool or data access, other");
    expect(valueLabel(beforeAfter, "after")).toBe("After the revision");
    expect(humanize("primary_failure_mode")).toBe("Primary failure mode");
  });

  it("counts progress, with analyzed pending items waiting for review", () => {
    const p = progressOf([
      { state: "pending", analyzedAt: null },
      { state: "pending", analyzedAt: new Date() },
      { state: "reviewed", analyzedAt: new Date() },
      { state: "skipped", analyzedAt: null },
    ]);
    expect(p).toMatchObject({ total: 4, finished: 2, waitingForReview: 1, fraction: 0.5 });
  });

  it("gates buttons by role, then by state", () => {
    expect(auditActions("draft", { total: 2, ready: 2 }, all).start).toEqual({ enabled: true, disabledReason: null });
    expect(auditActions("draft", { total: 2, ready: 1 }, all).start.disabledReason).toBe("1 of 2 investigation(s) are not ready.");
    expect(auditActions("draft", { total: 2, ready: 1 }, all).startSkippingIncomplete.enabled).toBe(true);
    expect(auditActions("draft", { total: 2, ready: 2 }, readOnly).start.disabledReason).toBe("Your role can't run audits in this space.");
    expect(auditActions("running", null, all).cancel.enabled).toBe(true);
    expect(auditActions("finalized", null, all).delete.disabledReason).toBe("An audit whose record is saved can't be deleted.");
    expect(itemActions("reviewing", "reviewed", 3, all)).toMatchObject({ rerun: { enabled: true }, acceptAll: { enabled: true } });
    expect(itemActions("reviewing", "reviewed", 0, all).acceptAll.disabledReason).toBe("No finding is waiting for a decision.");
    const fa = findingActions("reviewing", { state: "proposed", current: true, editable: true }, all);
    expect([fa.accept.enabled, fa.reject.enabled, fa.reopen.enabled, fa.edit.enabled]).toEqual([true, true, false, true]);
    expect(findingActions("reviewing", { state: "accepted", current: false, editable: true }, all).reopen.disabledReason).toBe("This finding is from an earlier review.");
    expect(findingActions("cancelled", { state: "proposed", current: true, editable: true }, all).accept.disabledReason).toContain("can't be changed");
    expect(findingActions("reviewing", { state: "proposed", current: true, editable: true }, readOnly).accept.disabledReason).toBe("Your role can't review findings in this space.");
  });
});
