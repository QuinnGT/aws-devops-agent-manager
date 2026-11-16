import { and, eq, inArray } from "drizzle-orm";
import type { ReviewRunInput, ReviewRunResult, RunReview } from "@/server/audits/contract";
import { reviewFinding } from "@/server/audits/finding-review";
import { runAuditJob, runReviewItemJob, type EnqueueReview } from "@/server/audits/run";
import { createAudit, startAudit } from "@/server/audits/service";
import { benchmarkFixture, benchmarkReviews, reachableCatalog } from "@/server/audits/testing";
import { db } from "@/server/db/client";
import { auditItems, audits, findings, jobRuns, journalTasks } from "@/server/db/schema";
import { testJobContext } from "@/server/jobs/registry";
import { recordText } from "@/server/review/records";
import type { Space } from "@/server/spaces/queries";
import { importBenchmarkJournals, uploadBenchmarkGroundTruth } from "../lib/benchmark";
import { logger, NO_AWS_PROFILE, REVIEW_MODEL, SAMPLE, type SeedPerson } from "../lib/common";
import { settle } from "../lib/jobs";

/**
 * The audit pages' part of the demo: three sample
 * benchmark journals (20101, 20104, 20105) and their ground truth, a benchmark
 * audit run with a fake runReview built from the sample reference reviews
 * (sample-data/audit/reviews; no AWS, no model call) that leaves findings
 * proposed, accepted, rejected and one flagged by the citation check, a
 * benchmark draft, a before-and-after draft, and an audit whose reviews all
 * failed for missing AWS credentials. Audits that already exist by name are
 * left alone.
 */

export const AUDIT_INCIDENTS = ["INCIDENT-20101", "INCIDENT-20104", "INCIDENT-20105"];
export const AUDIT_NAMES = {
  /** In review, with a quote the record doesn't contain and a record the journal doesn't have */
  benchmark: "Late October low scores, first look",
  draft: "Seat hold, sign-in and search incidents",
  beforeAfter: "Change window rules, before and after",
  /** Started before the app checked Bedrock at start: both reviews failed for missing AWS credentials */
  failed: "20101 and 20104, no AWS access",
} as const;

const log = logger("audits");

/** Some words from the middle of a record, as a quote the record contains. */
function quoteFrom(text: string): string | null {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  if (words.length < 12) return null;
  const start = Math.floor(words.length / 3);
  return words.slice(start, start + 8).join(" ");
}

function fakeRunReview(): RunReview {
  const byIncident = new Map(benchmarkReviews(SAMPLE.auditDir).map((r) => [String(r.raw.incident), r.raw]));
  return async (input: ReviewRunInput): Promise<ReviewRunResult> => {
    const inc = input.incidentId ?? "";
    const raw = byIncident.get(inc) ?? { incident: inc, one_line: "No reference review", primary_failure_mode: "L_other", fixes: [{ owner: "instructions", fix: "Check R2 first" }] };
    const diagnosisFields = input.profile.findings.find((f) => f.kind === "diagnosis")?.fields ?? [];
    const fx = benchmarkFixture(raw, diagnosisFields);
    const records = input.bundle.records;
    const max = records.length;
    let quoted = 0;
    let citations = fx.citationCheck.citations.map((c) => {
      if (c.record > max) return { ...c, ok: false, problem: "missing-record" as const };
      // Give a few citations a quote from their record, so the record card highlights it.
      if (quoted < 4 && !c.field.startsWith("summaries")) {
        const q = quoteFrom(recordText(records[c.record - 1]!));
        if (q) {
          quoted++;
          return { ...c, quote: q };
        }
      }
      return c;
    });
    if (inc === AUDIT_INCIDENTS[2]) {
      // One quote the record doesn't contain, and one record the journal doesn't have.
      const i = citations.findIndex((c) => c.ok && c.field.startsWith("reachability"));
      if (i >= 0) citations[i] = { ...citations[i]!, quote: "the search indexer stopped accepting every document", ok: false, problem: "quote-not-found" };
      const fixes = (fx.output.fixes as { evidence: { record: number; quote: string | null }[] }[]) ?? [];
      const last = fixes.length - 1;
      if (last >= 0) {
        fixes[last]!.evidence.push({ record: max + 2, quote: null });
        citations = [...citations, { record: max + 2, quote: null, field: `fixes[${last}].evidence[${fixes[last]!.evidence.length - 1}]`, ok: false, problem: "missing-record" as const }];
      }
    }
    const failed = citations.filter((c) => !c.ok).length;
    const modelId = input.profile.review.modelId ?? REVIEW_MODEL;
    return {
      state: "succeeded",
      runner: "seed",
      modelId,
      promptDigest: "0".repeat(64),
      output: fx.output,
      schemaValid: true,
      schemaErrors: [],
      citationCheck: { ok: failed === 0, checked: citations.length, failed, citations },
      steps: 31,
      inputTokens: 92_000,
      outputTokens: 4_100,
      durationMs: 64_000,
      error: null,
      modelCalls: [{ purpose: "review", runner: "seed", modelId, region: input.region, steps: 31, inputTokens: 92_000, outputTokens: 4_100, durationMs: 64_000, error: null }],
    };
  };
}

async function auditByName(spaceId: string, name: string) {
  const [a] = await db()
    .select({ id: audits.id })
    .from(audits)
    .where(and(eq(audits.spaceId, spaceId), eq(audits.name, name)));
  return a?.id ?? null;
}

async function benchmarkAudit(space: Space, actor: SeedPerson): Promise<string> {
  const name = AUDIT_NAMES.benchmark;
  const existing = await auditByName(space.id, name);
  if (existing) {
    log("exists:", name);
    return existing;
  }
  const { auditId } = await createAudit(actor, space.id, {
    name,
    note: "Three of the late October incidents that scored 3/5 or lower against the confirmed root cause.",
    reviewModelId: REVIEW_MODEL,
    selections: [{ by: "incidents", incidentIds: AUDIT_INCIDENTS }],
  });
  // The reviews are the fake runReview below, so the Bedrock check answers from a stub.
  const { runId } = await startAudit(actor, space.id, auditId, {}, { listCatalog: reachableCatalog(REVIEW_MODEL) });
  const queued: { input: { auditId: string; itemId: string }; runId: string }[] = [];
  const enqueueReview: EnqueueReview = async (input, opts) => {
    const [row] = await db()
      .insert(jobRuns)
      .values({ queue: "audits.review-item", actorEmail: opts.actor.email, spaceId: opts.spaceId, input })
      .returning({ id: jobRuns.id });
    queued.push({ input, runId: row!.id });
    return row!.id;
  };
  const deps = { enqueueReview, runReview: fakeRunReview() };
  const result = await runAuditJob({ auditId }, testJobContext({ actor, spaceId: space.id, runId }), deps);
  await settle(runId, result);
  for (let guard = 0; queued.length && guard < 50; guard++) {
    const next = queued.shift()!;
    const r = await runReviewItemJob(next.input, testJobContext({ actor, spaceId: space.id, runId: next.runId }), deps);
    await settle(next.runId, r);
  }

  // Decisions: 20101 diagnosis and first fix accepted, 20104 first fix accepted, 20105 first fix rejected; the rest stay proposed.
  const items = await db().select().from(auditItems).where(eq(auditItems.auditId, auditId));
  const reviewIds = items.flatMap((i) => (i.currentReviewId ? [i.currentReviewId] : []));
  const fs = reviewIds.length ? await db().select().from(findings).where(inArray(findings.reviewId, reviewIds)) : [];
  const of = (inc: string, kind: string, ordinal: number) => fs.find((f) => f.incidentId === inc && f.kind === kind && f.ordinal === ordinal);
  for (const [inc, kind, ordinal, note] of [
    ["INCIDENT-20101", "diagnosis", 0, null],
    ["INCIDENT-20101", "fix", 0, null],
    ["INCIDENT-20104", "fix", 0, "The access request goes to team-identity."],
  ] as const) {
    const f = of(inc, kind, ordinal);
    if (f) await reviewFinding(actor, space.id, f.id, { action: "accept", ...(note ? { note } : {}) });
  }
  const f2 = of("INCIDENT-20105", "fix", 0);
  if (f2) await reviewFinding(actor, space.id, f2.id, { action: "reject", note: "Nothing to change in the package. The search team owns the indexer log." });
  log("benchmark audit", name, auditId, result);
  return auditId;
}

async function drafts(space: Space, actor: SeedPerson): Promise<string[]> {
  const ids: string[] = [];
  const bench = AUDIT_NAMES.draft;
  const haveBench = await auditByName(space.id, bench);
  if (haveBench) ids.push(haveBench);
  else {
    const { auditId } = await createAudit(actor, space.id, { name: bench, profileId: "benchmark", reviewModelId: REVIEW_MODEL, selections: [{ by: "incidents", incidentIds: AUDIT_INCIDENTS }] });
    log("benchmark draft", auditId);
    ids.push(auditId);
  }
  const ba = AUDIT_NAMES.beforeAfter;
  const haveBa = await auditByName(space.id, ba);
  if (haveBa) ids.push(haveBa);
  else {
    const tasks = await db()
      .select({ taskId: journalTasks.taskId, incidentId: journalTasks.incidentId })
      .from(journalTasks)
      .where(and(eq(journalTasks.spaceId, space.id), inArray(journalTasks.incidentId, AUDIT_INCIDENTS)));
    const before = tasks.filter((t) => t.incidentId === AUDIT_INCIDENTS[0]).map((t) => t.taskId);
    const after = tasks.filter((t) => t.incidentId !== AUDIT_INCIDENTS[0]).map((t) => t.taskId);
    const { auditId } = await createAudit(actor, space.id, {
      name: ba,
      profileId: "before-after",
      selections: [
        { by: "tasks", taskIds: before, cohort: "before" },
        { by: "tasks", taskIds: after, cohort: "after" },
      ],
    });
    log("before-after draft", auditId);
    ids.push(auditId);
  }
  return ids;
}

/**
 * An audit whose every review failed because the app had no AWS credentials
 * for the space, as when an audit was started before startAudit checked
 * Bedrock. The error is the reviewer's own
 * wording for a missing profile; nothing calls AWS.
 */
async function failedAudit(space: Space, actor: SeedPerson): Promise<string> {
  const name = AUDIT_NAMES.failed;
  const existing = await auditByName(space.id, name);
  if (existing) return existing;
  const { auditId } = await createAudit(actor, space.id, { name, reviewModelId: REVIEW_MODEL, selections: [{ by: "incidents", incidentIds: AUDIT_INCIDENTS.slice(0, 2) }] });
  const { runId } = await startAudit(actor, space.id, auditId, {}, { listCatalog: reachableCatalog(REVIEW_MODEL) });
  const queued: { input: { auditId: string; itemId: string }; runId: string }[] = [];
  const enqueueReview: EnqueueReview = async (input, opts) => {
    const [row] = await db()
      .insert(jobRuns)
      .values({ queue: "audits.review-item", actorEmail: opts.actor.email, spaceId: opts.spaceId, input })
      .returning({ id: jobRuns.id });
    queued.push({ input, runId: row!.id });
    return row!.id;
  };
  const noCredentials: RunReview = async (input) => {
    const error = `The model call failed: CredentialsProviderError: Could not resolve credentials using profile: [${NO_AWS_PROFILE}] in configuration/credentials file(s).`;
    const modelId = input.profile.review.modelId ?? REVIEW_MODEL;
    return {
      state: "failed",
      runner: "ai-sdk",
      modelId,
      promptDigest: "0".repeat(64),
      output: null,
      schemaValid: false,
      schemaErrors: [],
      citationCheck: null,
      steps: 1,
      inputTokens: null,
      outputTokens: null,
      durationMs: 900,
      error,
      modelCalls: [{ purpose: "review", runner: "ai-sdk", modelId, region: input.region, steps: 1, inputTokens: null, outputTokens: null, durationMs: 900, error }],
    };
  };
  const deps = { enqueueReview, runReview: noCredentials };
  const result = await runAuditJob({ auditId }, testJobContext({ actor, spaceId: space.id, runId }), deps);
  await settle(runId, result);
  for (let guard = 0; queued.length && guard < 20; guard++) {
    const next = queued.shift()!;
    const r = await runReviewItemJob(next.input, testJobContext({ actor, spaceId: space.id, runId: next.runId }), deps);
    await settle(next.runId, r);
  }
  log("failed audit", name, auditId);
  return auditId;
}

export interface AuditScreens {
  benchmarkId: string;
  draftIds: string[];
  failedId: string;
}

/** Seed the audit pages' data in the space. */
export async function seedAuditScreens(space: Space, actor: SeedPerson): Promise<AuditScreens> {
  const imported = await importBenchmarkJournals(space, actor, AUDIT_INCIDENTS);
  if (imported.length) log("imported", imported.join(", "));
  const gt = await uploadBenchmarkGroundTruth(space, actor, AUDIT_INCIDENTS);
  log("ground truth", gt.totals);
  const benchmarkId = await benchmarkAudit(space, actor);
  const draftIds = await drafts(space, actor);
  const failedId = await failedAudit(space, actor);
  return { benchmarkId, draftIds, failedId };
}
