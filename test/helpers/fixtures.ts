import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { env } from "@/server/env";
import { loadPolicyFromDirs } from "@/server/policy/loader";
import type { Policy } from "@/server/policy";

/**
 * Real API responses captured read-only from the test Agent Space
 * (Customer-Demo-Space, us-west-2) on 2026-11-11, account IDs masked to
 * 111122223333 and pagination tokens redacted. Each file is { request, response }.
 */
export const API_FIXTURE_DIR = path.resolve(__dirname, "../fixtures/api/test-space");

export function apiFixture<T = unknown>(name: string): { request: unknown; response: T } {
  return JSON.parse(readFileSync(path.join(API_FIXTURE_DIR, `${name}.json`), "utf8"));
}

export function apiFixtureNames(): string[] {
  return readdirSync(API_FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

/** The synthetic dataset of the fictional AnyCompany Tickets that ships in the repository (sample-data/README.md). */
export const SAMPLE_DATA_DIR = path.resolve(__dirname, "../../sample-data");

/** Package v1 or v2 of the sample instruction package (a folder; skill zips are built, not committed). */
export function samplePackageDir(version: "v1" | "v2"): string {
  return path.join(SAMPLE_DATA_DIR, "packages", version);
}

/** The sample Agent Space export (agent-space-folders layout). */
export function sampleAgentSpaceExportDir(): string {
  return path.join(SAMPLE_DATA_DIR, "packages", "agent-space-export");
}

/** The four live-run journals (INCIDENT-20201 to INCIDENT-20204, record-created format). */
export function sampleLiveRunsDir(): string {
  return path.join(SAMPLE_DATA_DIR, "journals", "live-runs");
}

/** The app's policy with the sample policy overlay (sample-data/policy) merged over it, as a history repository's policy/ would be. */
export function samplePolicy(): Policy {
  return loadPolicyFromDirs([env().policyDir, path.join(SAMPLE_DATA_DIR, "policy")]).policy;
}

/**
 * The benchmark journals: one folder per incident with its full journal, the person's root cause
 * document and the scorecard (sample-data/journals/benchmark). DAM_BENCHMARK_JOURNALS_DIR points the
 * suites at another dataset in the same layout.
 */
export const BENCHMARK_JOURNALS_DIR = process.env.DAM_BENCHMARK_JOURNALS_DIR ?? path.join(SAMPLE_DATA_DIR, "journals", "benchmark");

/**
 * The reference audit of the benchmark journals: reviews/INCIDENT-*.json, metrics.json and
 * memory_usage.json (sample-data/audit). DAM_BENCHMARK_AUDIT_DIR points the suites at another one.
 */
export const BENCHMARK_AUDIT_DIR = process.env.DAM_BENCHMARK_AUDIT_DIR ?? path.join(SAMPLE_DATA_DIR, "audit");

/** Journals in the older record-created export format (sample-data/journals/live-runs). DAM_LIVE_RUNS_DIR points the suites at another folder. */
export const LIVE_RUNS_DIR = process.env.DAM_LIVE_RUNS_DIR ?? path.join(SAMPLE_DATA_DIR, "journals", "live-runs");

/** The numbers in sample-data/expected/benchmark.json that the suites assert (the file holds more). */
export interface BenchmarkExpected {
  incidents: number;
  incidentIds: string[];
  journals: Record<string, { records: number }>;
  scorecards: Record<string, { score: string; verdict: string; comparisonScore: string }>;
  reviews: Record<string, { score: string; primaryFailureMode: string; failureModes: string[]; summaries: number; citationsChecked: number; fixOwners: string[]; findings: { diagnosis: number; fix: number } }>;
  totals: {
    records: number;
    citationsChecked: number;
    findings: { diagnosis: number; fix: number };
    scoreCounts: Record<string, number>;
    reportCounts: Record<"failure-modes" | "reachability" | "scorecard-fairness" | "fixes-by-owner-id", Record<string, number>>;
  };
}

/**
 * What the sample benchmark set must produce, or null when DAM_BENCHMARK_JOURNALS_DIR or
 * DAM_BENCHMARK_AUDIT_DIR points at another dataset. Suites assert these numbers only when this
 * returns them, and derive what they can from the data otherwise.
 */
export function benchmarkExpected(): BenchmarkExpected | null {
  if (process.env.DAM_BENCHMARK_JOURNALS_DIR || process.env.DAM_BENCHMARK_AUDIT_DIR) return null;
  return JSON.parse(readFileSync(path.join(SAMPLE_DATA_DIR, "expected", "benchmark.json"), "utf8")) as BenchmarkExpected;
}
