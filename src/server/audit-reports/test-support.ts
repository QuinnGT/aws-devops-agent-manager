import { getAppPolicy, readPolicyFile } from "@/server/policy";
import type { AuditProfile } from "@/server/policy/sections/audits";
import type { ReportItem } from "./types";
import type { AuditRecord, BuildViewInput, FindingRecord } from "./view";

/**
 * Test support: synthetic audits for the report tests (no customer data).
 * Account IDs are the documented placeholder 111122223333.
 */

export function benchmarkProfile(): AuditProfile {
  const p = structuredClone(getAppPolicy().policy.audits.profiles.benchmark!);
  // The shipped policy names no model; an audit snapshot carries the one chosen in the app.
  p.review.modelId = "test-model";
  return p;
}

export function benchmarkSchema(): unknown {
  const p = getAppPolicy();
  return JSON.parse(readPolicyFile(p.dirs, p.policy.audits.profiles.benchmark!.review.outputSchema)!);
}

export const uuidOf = (prefix: string, n: number) => `${prefix.padEnd(8, "0").slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function item(n: number, over: Partial<ReportItem> = {}): ReportItem {
  return {
    id: uuidOf("aaaaaaaa", n),
    taskId: `task-${n}`,
    incidentId: `INCIDENT-${n}`,
    cohort: null,
    state: "reviewed",
    stateReason: null,
    journalSha256: `${String(n).padStart(2, "0")}`.repeat(32),
    currentReviewId: uuidOf("bbbbbbbb", n),
    ...over,
  };
}

let seq = 0;
export function finding(it: ReportItem, kind: string, values: Record<string, unknown>, over: Partial<FindingRecord> = {}): FindingRecord {
  seq++;
  return {
    id: uuidOf("cccccccc", seq),
    auditItemId: it.id,
    reviewId: it.currentReviewId ?? uuidOf("bbbbbbbb", 0),
    incidentId: it.incidentId,
    kind,
    ordinal: 0,
    title: kind === "diagnosis" ? `${it.incidentId}: ${String(values.one_line ?? "")}` : String(values.fix ?? kind),
    current: values,
    proposed: values,
    citations: [],
    state: "accepted",
    edited: false,
    reviewNote: null,
    reviewedBy: "reviewer@example.com",
    reviewedAt: new Date("2026-11-12T10:00:00.000Z"),
    ...over,
  };
}

export function diagnosis(it: ReportItem, over: Record<string, unknown> = {}, rec: Partial<FindingRecord> = {}): FindingRecord {
  return finding(
    it,
    "diagnosis",
    {
      primary_failure_mode: "D_wrong_component",
      failure_modes: ["D_wrong_component"],
      reachability: "reachable",
      reachability_reason: "The logs were queryable.",
      near_miss: null,
      scorecard_fair: "yes",
      scorecard_notes: "",
      ground_truth: "Redis timeouts in the cache tier.",
      agent_final_answer: "Blamed the gateway.",
      one_line: "Investigated the gateway instead of the cache.",
      score: "2/5",
      ...over,
    },
    rec,
  );
}

export function fix(it: ReportItem, ordinal: number, over: Record<string, unknown> = {}, rec: Partial<FindingRecord> = {}): FindingRecord {
  return finding(it, "fix", { owner: "instructions", fix: "Check the cache tier before the gateway.", evidence: [{ record: 12, quote: "timeout" }], ...over }, { ordinal, ...rec });
}

export function auditRecord(over: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: uuidOf("dddddddd", 1),
    spaceId: uuidOf("eeeeeeee", 1),
    name: "Late October low scores",
    state: "reviewing",
    profileId: "benchmark",
    createdBy: "alex@example.com",
    createdAt: new Date("2026-11-10T09:00:00.000Z"),
    report: null,
    reportUpdatedBy: null,
    reportUpdatedAt: null,
    finalizedCommit: null,
    finalizedBy: null,
    finalizedAt: null,
    ...over,
  };
}

export function viewInput(over: Partial<BuildViewInput> = {}): BuildViewInput {
  return {
    audit: auditRecord(),
    profile: benchmarkProfile(),
    items: [],
    findings: [],
    evidence: {},
    analyzerRuns: {},
    outputSchema: benchmarkSchema(),
    inputsChangedAt: null,
    ...over,
  };
}
