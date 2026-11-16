import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { NormBundle, NormRecord } from "@/server/analyzers/normalize";
import { normalizeBundle } from "@/server/analyzers/normalize";
import { markdownBundle } from "@/server/analyzers/testing";
import type { AuditProfile, ReviewRunInput } from "@/server/audits/contract";
import { getAppPolicy } from "@/server/policy";
import { BENCHMARK_AUDIT_DIR, BENCHMARK_JOURNALS_DIR } from "../../../test/helpers/fixtures";

/** Test helpers for the reviewer: synthetic bundles and run inputs. Not used by app code. */

export interface RecordSpec {
  type?: string;
  role?: string | null;
  text: string;
  /** Structured message parts; when set, the record is a structured message */
  toolUses?: { name: string; input: unknown }[];
  toolResults?: string[];
  thinking?: string[];
}

export function syntheticBundle(specs: RecordSpec[], opts: { incidentId?: string | null; title?: string } = {}): NormBundle {
  const t0 = Date.parse("2026-10-19T07:49:00Z");
  const records: NormRecord[] = specs.map((s, i) => {
    const structured = !!(s.toolUses || s.toolResults || s.thinking);
    const type = s.type ?? "message";
    return {
      n: i + 1,
      recordId: `rec-${i + 1}`,
      executionId: "exec-1",
      seq: i + 1,
      recordType: type,
      createdAt: new Date(t0 + i * 1000),
      isMessage: type === "message",
      role: s.role === undefined ? (type === "message" ? (i === 0 ? "user" : "assistant") : null) : s.role,
      text: s.text,
      hasText: s.text.trim().length > 0,
      textBlocks: s.text ? [s.text] : [],
      thinking: s.thinking ?? [],
      toolUses: (s.toolUses ?? []).map((u, j) => ({ id: `tu-${i}-${j}`, name: u.name, input: u.input, inputComplete: true })),
      toolResults: (s.toolResults ?? []).map((t, j) => ({ id: `tu-${i}-${j}`, status: "success", text: t })),
      structured,
      data: null,
      sourceNumber: i + 1,
      sourceLine: null,
    };
  });
  return {
    spaceId: "00000000-0000-0000-0000-000000000001",
    task: {
      taskId: "task-1",
      incidentId: opts.incidentId === undefined ? "INCIDENT-1" : opts.incidentId,
      title: opts.title ?? "INC-1: Orders were delayed",
      description: null,
      taskType: "INVESTIGATION",
      status: "COMPLETED",
      priority: "HIGH",
      reference: null,
      createdAt: new Date(t0),
      updatedAt: new Date(t0),
      source: "import",
      raw: null,
    },
    rootExecutionId: "exec-1",
    executionIds: ["exec-1"],
    importHeader: null,
    records,
  };
}

export function benchmarkProfile(over: Partial<AuditProfile["review"]> = {}): AuditProfile {
  const p = getAppPolicy().policy.audits.profiles.benchmark!;
  // The shipped policy names no model; reviews in tests run on an injected mock.
  return { ...p, review: { ...p.review, modelId: "test-model", ...over } };
}

export function runInput(bundle: NormBundle, over: Partial<ReviewRunInput> = {}): ReviewRunInput {
  return {
    space: {
      id: "00000000-0000-0000-0000-000000000001",
      alias: "test",
      region: "us-west-2",
      accountId: "111122223333",
      agentSpaceId: "space-1",
      readRoleArn: null,
      writeRoleArn: null,
      externalId: null,
      awsProfile: null,
    },
    region: "us-west-2",
    actor: { email: "reviewer@example.com" },
    profile: benchmarkProfile(),
    policyDirs: getAppPolicy().dirs,
    incidentId: bundle.task.incidentId,
    bundle,
    analyzerOutputs: {},
    groundTruth: [
      { kind: "actual_rca", label: "Confirmed root cause", fileName: "1_actual_rca.md", body: "The consumer group rebalanced on every scale event.", fields: {} },
      { kind: "scorecard", label: "Benchmark scorecard", fileName: "INCIDENT-1_scorecard.md", body: "| DevOps RCA score | **2/5** |", fields: { score: "2/5", verdict: "Symptom only" } },
    ],
    ...over,
  };
}

/** A review output that passes the benchmark schema, citing records of a bundle with at least 3 records. */
export function validBenchmarkOutput(): Record<string, unknown> {
  return {
    incident: "INCIDENT-1",
    title: "INC-1: Orders were delayed",
    score: "2/5",
    ground_truth: "Consumer rebalances stalled consumption.",
    ground_truth_uncertain: false,
    agent_final_answer: "A timing race between a batch job and a stream (R3).",
    summaries: [{ record: 3, utc: "2026-10-19T07:49:02Z", conclusion: "Timing race.", prompted_by: "initial run" }],
    scored_summary_record: 3,
    timing: {
      incident_created: "2026-10-19 00:48 PT",
      agent_start_utc: "2026-10-19T07:49:00Z",
      first_summary_utc: "2026-10-19T07:49:02Z",
      ran_while_incident_minutes_old: true,
      decisive_evidence_existed_at_run_time: "yes",
      note: "Started a minute after the alert (R1).",
    },
    reachability: "partially_reachable",
    reachability_reason: "Consumer lag was queryable but not queried (R2).",
    near_miss: null,
    failure_modes: ["D_wrong_component"],
    primary_failure_mode: "D_wrong_component",
    blocking_errors: [],
    scorecard_fair: "yes",
    scorecard_notes: "Fair.",
    quality_notes: [],
    fixes: [{ owner: "customer_memory", fix: "Add a memory entry for the ingest path.", evidence: [{ record: 2, quote: "consumer lag" }] }],
    one_line: "Blamed the wrong consumer.",
    citations: [{ record: 3, quote: "timing race", supports: "agent_final_answer" }],
  };
}

/** The benchmark journals' and reference reviews' folders (sample-data/journals/benchmark and sample-data/audit/reviews by default; see test/helpers/fixtures.ts). */
export function benchmarkDirs(): { incidents: string; reviews: string } {
  return { incidents: BENCHMARK_JOURNALS_DIR, reviews: path.join(BENCHMARK_AUDIT_DIR, "reviews") };
}

/** A benchmark full journal, imported as the journal import job would and normalized. */
export function benchmarkBundle(incidentsDir: string, incident: string): NormBundle {
  const buf = readFileSync(path.join(incidentsDir, incident, `${incident}_full_journal.md`));
  return normalizeBundle(markdownBundle(buf.toString("utf8"), getAppPolicy().policy, createHash("sha256").update(buf).digest("hex")));
}
