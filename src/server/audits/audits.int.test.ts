import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import JSZip from "jszip";
import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from "@aws-sdk/client-bedrock";
import { mockClient } from "aws-sdk-client-mock";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModelCatalogCache } from "@/server/ai/catalog";
import { NO_REVIEW_MODEL_REASON } from "@/server/ai/models";
import { db } from "@/server/db/client";
import { agentSpaces, auditEvents, auditItems, audits, evidenceDocs, findings, jobRuns, modelCalls, reviews } from "@/server/db/schema";
import { testJobContext } from "@/server/jobs/registry";
import { runImport, saveUpload } from "@/server/journals/import";
import { getAppPolicy } from "@/server/policy";
import { getSpaceById, type Space } from "@/server/spaces/queries";
import { BENCHMARK_AUDIT_DIR, BENCHMARK_JOURNALS_DIR, benchmarkExpected } from "../../../test/helpers/fixtures";
import { truncateAll } from "../../../test/helpers/db";
import type { ReviewRunInput, ReviewRunResult, RunReview } from "./contract";
import { AuditRequestError } from "./errors";
import { decodeText, matchEvidenceFile } from "./evidence-match";
import { uploadGroundTruth } from "./evidence";
import { acceptAllProposed, reviewFinding } from "./finding-review";
import { enqueueReview } from "./jobs";
import { listLinkableFindings } from "./linkable";
import { loadAuditDetail, loadAuditItem, loadAuditList, loadFindingsQueue } from "./loaders";
import { runAuditJob, runReviewItemJob, type RunDeps } from "./run";
import { addAuditItems, cancelAudit, createAudit, deleteAudit, removeAuditItems, rerunItem, startAudit } from "./service";
import { benchmarkFixture, benchmarkReviews } from "./testing";

// Jobs run directly in these tests. enqueue records a job_runs row and the job; nothing goes to pg-boss.
const h = vi.hoisted(() => ({ queued: [] as { queue: string; input: Record<string, string>; runId: string; done: boolean }[], cancelled: [] as string[][] }));
vi.mock("@/server/jobs/enqueue", async () => {
  const { db: d } = await import("@/server/db/client");
  const { jobRuns: jr } = await import("@/server/db/schema");
  return {
    enqueue: vi.fn(async (job: { name: string }, input: Record<string, string>, opts: { actor: { email: string }; spaceId?: string | null }) => {
      const [row] = await d()
        .insert(jr)
        .values({ queue: job.name, actorEmail: opts.actor.email, spaceId: opts.spaceId ?? null, input, bossJobId: crypto.randomUUID() })
        .returning({ id: jr.id });
      h.queued.push({ queue: job.name, input, runId: row!.id, done: false });
      return row!.id;
    }),
  };
});
vi.mock("@/server/jobs/boss", () => ({ boss: async () => ({ cancel: async (_q: string, ids: string[]) => void h.cancelled.push(ids) }) }));

const actor = { email: "auditor@example.com" };
const reviewer = { email: "reviewer@example.com" };

async function createSpace(alias: string): Promise<Space> {
  const [row] = await db()
    .insert(agentSpaces)
    .values({ alias, region: "us-west-2", accountId: "111122223333", agentSpaceId: crypto.randomUUID() })
    .returning({ id: agentSpaces.id });
  return (await getSpaceById(row!.id))!;
}

async function importMarkdown(space: Space, fileName: string, text: string | Buffer) {
  const { importId } = await saveUpload(space, { fileName, bytes: Buffer.isBuffer(text) ? text : Buffer.from(text) }, actor);
  const report = await runImport({ importId }, testJobContext({ actor, spaceId: space.id }));
  expect(report.totals.failed).toBe(0);
  return report.files[0]!;
}

const ctxFor = (spaceId: string, runId?: string, who = actor) => testJobContext({ actor: who, spaceId, ...(runId ? { runId } : {}) });

/** Run every queued review job, in order, until none is left. */
async function drain(spaceId: string, deps: RunDeps): Promise<number> {
  let n = 0;
  for (let guard = 0; guard < 100; guard++) {
    const next = h.queued.find((q) => q.queue === "audits.review-item" && !q.done);
    if (!next) return n;
    next.done = true;
    n++;
    await runReviewItemJob(next.input as { auditId: string; itemId: string }, ctxFor(spaceId, next.runId), deps);
  }
  throw new Error("review jobs did not settle");
}

async function runQueuedAuditJob(spaceId: string, deps: RunDeps) {
  const job = h.queued.find((q) => q.queue === "audits.run" && !q.done)!;
  job.done = true;
  return runAuditJob(job.input as { auditId: string }, ctxFor(spaceId, job.runId), deps);
}

function okResult(input: ReviewRunInput, output: unknown, citationCheck: ReviewRunResult["citationCheck"]): ReviewRunResult {
  return {
    state: "succeeded",
    runner: "fake",
    modelId: input.profile.review.modelId ?? "test-model",
    promptDigest: "f".repeat(64),
    output,
    schemaValid: true,
    schemaErrors: [],
    citationCheck,
    steps: 3,
    inputTokens: 1200,
    outputTokens: 300,
    durationMs: 42,
    error: null,
    modelCalls: [{ purpose: "review", runner: "fake", modelId: input.profile.review.modelId ?? "test-model", region: input.region, steps: 3, inputTokens: 1200, outputTokens: 300, durationMs: 42, error: null }],
  };
}

const auditEventsFor = async (targetId: string) => (await db().select().from(auditEvents).where(eq(auditEvents.targetId, targetId))).map((e) => e.action);

// startAudit checks that Bedrock can be reached; the catalogue answers from a mock, never from AWS.
const bedrock = mockClient(BedrockClient);
beforeEach(() => {
  bedrock.reset();
  resetModelCatalogCache();
  bedrock.on(ListInferenceProfilesCommand).resolves({ inferenceProfileSummaries: [] });
  bedrock.on(ListFoundationModelsCommand).resolves({ modelSummaries: [] });
});

beforeAll(async () => {
  await truncateAll();
});

// ---------------------------------------------------------------- synthetic, always runs

const syntheticJournal = (n: number) => `# INCIDENT-${n} — Full DevOps Agent Investigation Journal

_Execution: exe-syn-${n} · Retrieved from prod · 3 records across 1 pages_

## Record 1 — message (2026-10-19 07:00:00.000000+00:00)

**role: user**

TITLE: INCIDENT-${n}

## Record 2 — message (2026-10-19 07:01:00.000000+00:00)

**role: assistant**

Checking the consumer lag for INCIDENT-${n}.

## Record 3 — investigation_summary_md (2026-10-19 07:05:00.000000+00:00)

The cause is a slow consumer.
`;

describe("before-after audit with cohorts (synthetic journals)", () => {
  let space: Space;
  const taskIds: string[] = [];

  beforeAll(async () => {
    space = await createSpace(`audits-syn-${Date.now()}`);
    for (const n of [9001, 9002, 9003]) {
      const f = await importMarkdown(space, `INCIDENT-${n}_full_journal.md`, syntheticJournal(n));
      taskIds.push(f.taskId!);
    }
  });

  it("creates a draft with cohorts and refuses bad selections", async () => {
    await expect(createAudit(actor, space.id, { name: "x", profileId: "before-after", selections: [{ by: "tasks", taskIds: ["nope"], cohort: "before" }] })).rejects.toMatchObject({
      code: "invalid",
      message: expect.stringContaining("not in this space"),
    });
    await expect(createAudit(actor, space.id, { name: "x", profileId: "before-after", selections: [{ by: "tasks", taskIds: [taskIds[0]!] }] })).rejects.toThrow("Choose a cohort");
    await expect(createAudit(actor, space.id, { name: "x", selections: [{ by: "incidents", incidentIds: ["INCIDENT-1"] }] })).rejects.toThrow("No investigation");
    await expect(createAudit(actor, space.id, { name: "", selections: [{ by: "tasks", taskIds: [taskIds[0]!] }] })).rejects.toThrow("Give the audit a name.");
    await expect(createAudit(actor, space.id, { name: "x", profileId: "missing", selections: [{ by: "tasks", taskIds: [taskIds[0]!] }] })).rejects.toThrow('no audit profile "missing"');

    const { auditId, items } = await createAudit(actor, space.id, {
      name: "Change window rules, before and after",
      profileId: "before-after",
      reviewModelId: "test-model",
      selections: [
        { by: "tasks", taskIds: [taskIds[0]!], cohort: "before" },
        { by: "incidents", incidentIds: ["INCIDENT-9002"], cohort: "after" },
      ],
    });
    expect(items).toBe(2);
    const [a] = await db().select().from(audits).where(eq(audits.id, auditId));
    expect(a).toMatchObject({ state: "draft", profileId: "before-after", createdBy: actor.email });
    expect((a!.profileSnapshot as { label: string }).label).toBe("Before and after a revision");
    expect(a!.policyDigest).toMatch(/^[0-9a-f]{64}$/);
    const rows = await db().select().from(auditItems).where(eq(auditItems.auditId, auditId));
    expect(rows.map((r) => [r.incidentId, r.cohort]).sort()).toEqual([
      ["INCIDENT-9001", "before"],
      ["INCIDENT-9002", "after"],
    ]);

    // Drafts can be edited; a range selection finds the third.
    await expect(addAuditItems(actor, space.id, auditId, [{ by: "tasks", taskIds: [taskIds[0]!], cohort: "after" }])).rejects.toThrow("already in the audit");
    const added = await addAuditItems(actor, space.id, auditId, [{ by: "range", from: "2026-10-19T00:00:00Z", to: "2026-10-20T00:00:00Z", cohort: "after" }]).catch((e) => e);
    // The first two are already in the audit with other or equal cohorts; the range includes task 1 (before), so it is refused.
    expect(added).toBeInstanceOf(AuditRequestError);
    const ok = await addAuditItems(actor, space.id, auditId, [{ by: "tasks", taskIds: [taskIds[2]!], cohort: "after" }]);
    expect(ok).toEqual({ added: 1, items: 3 });
    const third = (await db().select().from(auditItems).where(and(eq(auditItems.auditId, auditId), eq(auditItems.taskId, taskIds[2]!))))[0]!;
    expect(await removeAuditItems(actor, space.id, auditId, [third.id])).toEqual({ removed: 1 });
    expect(await auditEventsFor(auditId)).toEqual(expect.arrayContaining(["audit.create", "audit.items.add", "audit.items.remove"]));
  });

  it("starts without ground truth, runs, cancels and refuses to delete a running audit", async () => {
    const [a] = await db().select().from(audits).where(eq(audits.spaceId, space.id));
    const auditId = a!.id;
    const detail = await loadAuditDetail(space, auditId, { permissions: ["audits.read", "audits.run"] });
    expect(detail!.readiness).toMatchObject({ total: 2, ready: 2 });
    expect(detail!.actions.start.enabled).toBe(true);

    const start = await startAudit(actor, space.id, auditId);
    expect(start).toMatchObject({ items: 2, skipped: 0 });
    await expect(startAudit(actor, space.id, auditId)).rejects.toMatchObject({ code: "state" });
    await expect(deleteAudit(actor, space.id, auditId)).rejects.toThrow("A running audit can't be deleted.");

    // Analyzers run; reviews are queued but not run yet; then the audit is cancelled.
    const res = await runQueuedAuditJob(space.id, { enqueueReview, runReview: (async () => {
      throw new Error("not called");
    }) as RunReview });
    expect(res).toMatchObject({ status: "analyzed", items: 2, analyzed: 2, failed: 0, reviewsQueued: 2 });
    const items = await db().select().from(auditItems).where(eq(auditItems.auditId, auditId));
    for (const i of items) {
      expect(i.state).toBe("reviewing");
      expect(i.journalSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(i.reviewJobRunId).toBeTruthy();
    }

    const cancelled = await cancelAudit(actor, space.id, auditId);
    expect(cancelled).toEqual({ skipped: 2, jobsCancelled: 3 });
    expect(h.cancelled.flat()).toHaveLength(3);
    const after = await db().select().from(auditItems).where(eq(auditItems.auditId, auditId));
    expect(after.every((i) => i.state === "skipped" && i.stateReason === "The audit was cancelled.")).toBe(true);
    const runs = await db().select().from(jobRuns).where(eq(jobRuns.id, items[0]!.reviewJobRunId!));
    expect(runs[0]!.status).toBe("cancelled");
    // A queued review job that still runs does nothing.
    expect(await drain(space.id, { enqueueReview })).toBe(2);
    expect(await db().select().from(reviews).where(eq(reviews.auditId, auditId))).toHaveLength(0);
    await expect(cancelAudit(actor, space.id, auditId)).rejects.toMatchObject({ code: "state" });
    expect(await auditEventsFor(auditId)).toEqual(expect.arrayContaining(["audit.start", "audit.cancel"]));
  });

  it("deletes a draft", async () => {
    const { auditId } = await createAudit(actor, space.id, { name: "throwaway", profileId: "before-after", selections: [{ by: "tasks", taskIds: [taskIds[0]!], cohort: "before" }] });
    // No model chosen and no space default: the audit can't start, and says where to set one.
    await expect(startAudit(actor, space.id, auditId)).rejects.toMatchObject({ code: "invalid", message: NO_REVIEW_MODEL_REASON });
    await db().update(audits).set({ profileSnapshot: sql`jsonb_set(${audits.profileSnapshot}, '{review,modelId}', '"test-model"')` }).where(eq(audits.id, auditId));
    await expect(startAudit(actor, space.id, auditId)).rejects.toThrow('The cohort "After the revision" has no investigation');
    await deleteAudit(actor, space.id, auditId);
    expect(await db().select().from(audits).where(eq(audits.id, auditId))).toHaveLength(0);
    expect(await db().select().from(auditItems).where(eq(auditItems.auditId, auditId))).toHaveLength(0);
    expect(await auditEventsFor(auditId)).toContain("audit.delete");
    await expect(deleteAudit(actor, space.id, auditId)).rejects.toMatchObject({ code: "not-found" });
  });
});

// ---------------------------------------------------------------- Benchmark journals and ground truth

const benchmarkProfile = getAppPolicy().policy.audits.profiles.benchmark!;
const reviewsByIncident = new Map(benchmarkReviews(BENCHMARK_AUDIT_DIR).map((r) => [String(r.raw.incident), r.raw]));
const benchFile = (inc: string, name: string) => path.join(BENCHMARK_JOURNALS_DIR, inc, name);
/** The score the benchmark scorecard of `inc` gives, read the way an upload reads it. */
const scoreOf = (inc: string): string | null => {
  const file = benchFile(inc, `${inc}_scorecard.md`);
  const m = existsSync(file) ? matchEvidenceFile(benchmarkProfile, `${inc}_scorecard.md`, decodeText(readFileSync(file))) : null;
  return m?.matched ? (m.fields.score ?? null) : null;
};
// shortcut: the tests below assume three incidents that scored 2/5 and whose reference review has one
// diagnosis and three fixes (INCIDENT-20102, -20103 and -20106 in the sample set), and that the first
// one's primary failure mode is not G_thin_trigger_context. A dataset without three such incidents fails here.
const BENCH = [...reviewsByIncident.keys()]
  .sort()
  .filter((inc) => scoreOf(inc) === "2/5" && Array.isArray(reviewsByIncident.get(inc)!.fixes) && (reviewsByIncident.get(inc)!.fixes as unknown[]).length === 3)
  .slice(0, 3) as [string, string, string];

describe("benchmark audit over three benchmark journals", () => {
  let space: Space;
  let auditId = "";
  const taskByIncident = new Map<string, string>();
  const inputsSeen: ReviewRunInput[] = [];
  let maxReviewing = 0;
  let failNext = new Set<string>();

  const fakeReview: RunReview = async (input) => {
    inputsSeen.push(input);
    const [{ n } = { n: 0 }] = await db()
      .select({ n: sql<number>`count(*)::int` })
      .from(auditItems)
      .where(and(eq(auditItems.auditId, auditId), eq(auditItems.state, "reviewing")));
    maxReviewing = Math.max(maxReviewing, n);
    const inc = input.incidentId!;
    if (failNext.has(inc)) {
      failNext.delete(inc);
      return { ...okResult(input, null, null), state: "failed", schemaValid: false, error: "Bedrock throttled the request.", modelCalls: [] };
    }
    const raw = reviewsByIncident.get(inc);
    const diagnosisFields = input.profile.findings.find((f) => f.kind === "diagnosis")!.fields;
    const fx = raw
      ? benchmarkFixture(raw, diagnosisFields)
      : benchmarkFixture({ incident: inc, one_line: "synthetic", primary_failure_mode: "L_other", fixes: [{ owner: "instructions", fix: "Check R2 first" }] }, diagnosisFields);
    // Mark citations to records the journal does not have as failed, as the citation check would.
    const max = input.bundle.records.length;
    const citations = fx.citationCheck.citations.map((c) => (c.record <= max ? c : { ...c, ok: false, problem: "missing-record" as const }));
    const failed = citations.filter((c) => !c.ok).length;
    return okResult(input, fx.output, { ok: failed === 0, checked: citations.length, failed, citations });
  };
  const deps: RunDeps = { enqueueReview, runReview: fakeReview };

  beforeAll(async () => {
    expect(BENCH, "the benchmark set needs three incidents that scored 2/5 and whose review has three fixes").toHaveLength(3);
    if (benchmarkExpected()) expect(BENCH).toEqual(["INCIDENT-20102", "INCIDENT-20103", "INCIDENT-20106"]);
    space = await createSpace(`audits-benchmark-${Date.now()}`);
    for (const inc of BENCH) {
      const f = await importMarkdown(space, `${inc}_full_journal.md`, readFileSync(benchFile(inc, `${inc}_full_journal.md`)));
      expect(f.incidentId).toBe(inc);
      taskByIncident.set(inc, f.taskId!);
    }
  });

  it("creates the audit by incident ID and reports missing ground truth", async () => {
    ({ auditId } = await createAudit(actor, space.id, { name: "Benchmark runs", reviewModelId: "test-model", selections: [{ by: "incidents", incidentIds: BENCH }] }));
    await expect(startAudit(actor, space.id, auditId)).rejects.toMatchObject({ code: "not-ready", details: { notReady: expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining("Missing Confirmed root cause and Benchmark scorecard") })]) } });
    const detail = await loadAuditDetail(space, auditId, { permissions: ["audits.read", "audits.run"] });
    expect(detail!.readiness).toMatchObject({ total: 3, ready: 0, missingByKind: [{ kind: "actual_rca", items: 3 }, { kind: "scorecard", items: 3 }] });
    expect(detail!.actions.start).toMatchObject({ enabled: false, disabledReason: "3 of 3 investigation(s) are not ready." });
  });

  it("matches a ground-truth zip and plain files, and supersedes a changed document", async () => {
    const zip = new JSZip();
    for (const inc of BENCH.slice(0, 2)) {
      const num = inc.replace("INCIDENT-", "");
      zip.file(`${inc}/${num}_actual_rca.md`, readFileSync(benchFile(inc, `${num}_actual_rca.md`)));
      zip.file(`${inc}/${inc}_scorecard.md`, readFileSync(benchFile(inc, `${inc}_scorecard.md`)));
      zip.file(`${inc}/${inc}_devops_journal.md`, "condensed");
    }
    zip.file("__MACOSX/._x", "junk");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });
    const first = await uploadGroundTruth(actor, space.id, [{ fileName: "ground-truth.zip", bytes }], { auditId });
    expect(first.totals).toEqual({ files: 7, added: 4, replaced: 0, unchanged: 0, unmatched: 3 });
    expect(first.matched.find((m) => m.incidentId === BENCH[0] && m.kind === "scorecard")).toMatchObject({ fields: { score: scoreOf(BENCH[0]) }, knownIncident: true, outcome: "added" });
    expect(first.unmatched.map((u) => u.fileName).sort()).toEqual(["._x", `${BENCH[0]}_devops_journal.md`, `${BENCH[1]}_devops_journal.md`]);
    expect(first.missing).toEqual([{ incidentId: BENCH[2], taskIds: [taskByIncident.get(BENCH[2])], kinds: [expect.objectContaining({ kind: "actual_rca" }), expect.objectContaining({ kind: "scorecard" })] }]);

    const inc = BENCH[2];
    const rcaName = `${inc.replace("INCIDENT-", "")}_actual_rca.md`;
    const files = [
      { fileName: rcaName, bytes: readFileSync(benchFile(inc, rcaName)) },
      { fileName: `${inc}_scorecard.md`, bytes: readFileSync(benchFile(inc, `${inc}_scorecard.md`)) },
    ];
    const second = await uploadGroundTruth(actor, space.id, files, { auditId });
    expect(second.totals).toMatchObject({ added: 2, unmatched: 0 });
    expect(second.missing).toEqual([]);

    const again = await uploadGroundTruth(actor, space.id, files, { auditId });
    expect(again.totals).toMatchObject({ unchanged: 2, added: 0 });
    const changed = await uploadGroundTruth(actor, space.id, [{ fileName: rcaName, bytes: Buffer.concat([files[0]!.bytes, Buffer.from("\nAddendum.\n")]) }], {});
    expect(changed.totals).toMatchObject({ replaced: 1 });
    const rows = await db().select().from(evidenceDocs).where(and(eq(evidenceDocs.spaceId, space.id), eq(evidenceDocs.incidentId, inc), eq(evidenceDocs.kind, "actual_rca")));
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.supersededAt === null)).toHaveLength(1);
    expect(rows.find((r) => r.supersededAt === null)!.body).toContain("Addendum.");

    await expect(uploadGroundTruth(actor, space.id, [{ fileName: "bad.zip", bytes: Buffer.from("PK not really") }], { auditId })).rejects.toThrow(AuditRequestError);
    await expect(uploadGroundTruth(actor, space.id, [{ fileName: "x.md", bytes: Buffer.from("x") }], { profileId: "before-after" })).resolves.toMatchObject({ totals: { unmatched: 1 } });
    expect(await auditEventsFor(auditId)).toContain("audit.evidence.upload");
  });

  it("runs analyzers and reviews within the profile's concurrency, then moves to reviewing", async () => {
    // One review at a time for this audit.
    await db()
      .update(audits)
      .set({ profileSnapshot: sql`jsonb_set(${audits.profileSnapshot}, '{review,concurrency}', '1'::jsonb)` })
      .where(eq(audits.id, auditId));
    failNext = new Set([BENCH[2]]);
    const detail = await loadAuditDetail(space, auditId, { permissions: ["audits.read", "audits.run"] });
    expect(detail!.readiness).toMatchObject({ ready: 3 });
    await startAudit(actor, space.id, auditId);

    const ctxRun = await runQueuedAuditJob(space.id, deps);
    expect(ctxRun).toMatchObject({ status: "analyzed", analyzed: 3, failed: 0, reviewsQueued: 1 });
    const mid = await loadAuditDetail(space, auditId, { permissions: ["audits.read"] });
    expect(mid!.progress).toMatchObject({ total: 3, waitingForReview: 2, byState: { reviewing: 1 } });
    expect(mid!.items.filter((i) => i.stateLabel === "Waiting for review")).toHaveLength(2);

    expect(await drain(space.id, deps)).toBe(3);
    expect(maxReviewing).toBe(1);
    const [a] = await db().select().from(audits).where(eq(audits.id, auditId));
    expect(a!.state).toBe("reviewing");
    expect(await auditEventsFor(auditId)).toContain("audit.run.completed");

    // What the reviewer was given.
    const first = inputsSeen[0]!;
    expect(first.region).toBe("us-west-2");
    expect(first.actor).toEqual(actor);
    expect(first.policyDirs.length).toBeGreaterThan(0);
    expect(first.profile.review.concurrency).toBe(1);
    expect(first.groundTruth.map((g) => g.kind).sort()).toEqual(["actual_rca", "scorecard"]);
    expect(first.groundTruth.find((g) => g.kind === "scorecard")!.fields.score).toBe(scoreOf(first.incidentId!));
    expect(Object.keys(first.analyzerOutputs).sort()).toEqual(["condensed-trace", "memory-reads", "output-rules", "run-metrics"]);
    // The journal as imported: its records, as many as the benchmark expectations list for the sample set.
    expect(first.bundle.records.length).toBeGreaterThan(0);
    const expected = benchmarkExpected();
    if (expected) expect(first.bundle.records).toHaveLength(expected.journals[first.incidentId!]!.records);

    const items = await db().select().from(auditItems).where(eq(auditItems.auditId, auditId));
    const byInc = new Map(items.map((i) => [i.incidentId!, i]));
    expect(byInc.get(BENCH[2])).toMatchObject({ state: "failed", stateReason: "Bedrock throttled the request.", currentReviewId: null });
    for (const inc of [BENCH[0], BENCH[1]]) {
      const it = byInc.get(inc)!;
      expect(it.state).toBe("reviewed");
      expect(it.journalSha256).toMatch(/^[0-9a-f]{64}$/);
      const fs = await db().select().from(findings).where(eq(findings.reviewId, it.currentReviewId!));
      expect(fs.map((f) => f.kind).sort()).toEqual(["diagnosis", "fix", "fix", "fix"]);
      expect(fs.every((f) => f.state === "proposed" && f.incidentId === inc)).toBe(true);
    }
    expect(await db().select().from(reviews).where(eq(reviews.auditId, auditId))).toHaveLength(3);
    const calls = await db().select().from(modelCalls).where(eq(modelCalls.auditId, auditId));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ purpose: "review", region: "us-west-2", inputTokens: 1200, actor: actor.email });
  });

  it("loads the list, the audit, an item and the findings queue", async () => {
    const viewer = { permissions: ["audits.read", "audits.run", "findings.review"] as const };
    const list = await loadAuditList(space);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Benchmark runs", profileLabel: "Benchmark against ground truth", state: "reviewing", items: 3, findings: { proposed: 8, total: 8 }, createdBy: actor.email });

    const detail = (await loadAuditDetail(space, auditId, viewer))!;
    const row = detail.items.find((i) => i.incidentId === BENCH[0])!;
    const raw = reviewsByIncident.get(BENCH[0])!;
    expect(row).toMatchObject({ score: scoreOf(BENCH[0]), state: "reviewed", findings: { proposed: 4 }, review: { state: "succeeded", schemaValid: true } });
    expect(row.title).toBeTruthy();
    expect(row.primary).toMatchObject({ field: "primary_failure_mode", value: raw.primary_failure_mode });
    expect(row.review!.citationCheck!.checked).toBeGreaterThan(0);
    expect(detail.findingCounts).toEqual([
      { kind: "diagnosis", label: "Diagnosis", counts: { proposed: 2, accepted: 0, rejected: 0, total: 2 } },
      { kind: "fix", label: "Fix", counts: { proposed: 6, accepted: 0, rejected: 0, total: 6 } },
    ]);
    expect(detail.actions.cancel.enabled).toBe(false);

    const item = (await loadAuditItem(space, auditId, row.id, viewer))!;
    expect(item.journalPresent).toBe(true);
    expect(item.groundTruth.map((g) => [g.kind, !!g.doc])).toEqual([
      ["actual_rca", true],
      ["scorecard", true],
    ]);
    expect(item.groundTruth[1]!.doc!.fields.find((f) => f.key === "score")!.value).toBe(scoreOf(BENCH[0]));
    expect(item.analyzers.map((a) => [a.id, a.ran])).toEqual([
      ["run-metrics", true],
      ["condensed-trace", true],
      ["memory-reads", true],
      ["output-rules", true],
    ]);
    expect(item.analyzers[0]!.summary.map((s) => s.key)).toEqual(["span_min", "first_summary_min", "finalize_min", "tool_calls_lead", "n_inv_summaries"]);
    expect(item.reviews).toHaveLength(1);
    const diag = item.reviews[0]!.findings.find((f) => f.kind === "diagnosis")!;
    expect(diag.actions.accept.enabled).toBe(true);
    expect(diag.fields.find((f) => f.key === "primary_failure_mode")).toMatchObject({ editable: true, multiple: false, choices: expect.arrayContaining([{ value: "D_wrong_component", label: "Wrong component" }]) });
    expect(diag.fields.find((f) => f.key === "failure_modes")).toMatchObject({ multiple: true });
    const linked = diag.citations.find((c) => c.href)!;
    expect(linked.href).toMatch(new RegExp(`^/spaces/${space.alias}/journals/investigations/${encodeURIComponent(row.taskId)}(\\?page=\\d+)?#rec-`));
    expect(linked.recordId).toBeTruthy();

    const fixes = (await loadFindingsQueue(space, auditId, { kind: "fix" }, viewer))!;
    expect(fixes.total).toBe(6);
    expect(fixes.kinds).toEqual([
      { kind: "diagnosis", label: "Diagnosis", count: 2 },
      { kind: "fix", label: "Fix", count: 6 },
    ]);
    const owner = fixes.fields.find((f) => f.field === "owner")!;
    const top = owner.values.find((v) => v.count > 0)!;
    const byOwner = (await loadFindingsQueue(space, auditId, { field: "owner", value: top.value }, viewer))!;
    expect(byOwner.total).toBe(top.count);
    expect(byOwner.rows.every((r) => r.tags.some((t) => t.field === "owner" && t.value === top.value))).toBe(true);
    const fm = fixes.fields.find((f) => f.field === "failure_modes")!;
    expect(fm.kinds).toEqual(["diagnosis"]);
    const pfm = String(raw.primary_failure_mode);
    expect((await loadFindingsQueue(space, auditId, { field: "primary_failure_mode", value: pfm }, viewer))!.rows.map((r) => r.incidentId)).toContain(BENCH[0]);
    // Unknown filters are ignored rather than trusted.
    expect((await loadFindingsQueue(space, auditId, { field: "secret", value: "x", kind: "nope" }, viewer))!.total).toBe(8);
    expect(await loadAuditItem(space, auditId, "not-a-uuid", viewer)).toBeNull();
    expect(await loadAuditDetail({ id: crypto.randomUUID() }, auditId, viewer)).toBeNull();
  });

  it("accepts, edits, rejects and reopens findings, recording who did it", async () => {
    const [item] = await db().select().from(auditItems).where(and(eq(auditItems.auditId, auditId), eq(auditItems.incidentId, BENCH[0])));
    const fs = await db().select().from(findings).where(eq(findings.reviewId, item!.currentReviewId!));
    const diag = fs.find((f) => f.kind === "diagnosis")!;
    const [fix0, fix1] = fs.filter((f) => f.kind === "fix").sort((a, b) => a.ordinal - b.ordinal);

    await expect(reviewFinding(reviewer, space.id, diag.id, { action: "edit", values: { ground_truth: "changed" } })).rejects.toThrow("can't be edited");
    await expect(reviewFinding(reviewer, space.id, diag.id, { action: "edit", values: { primary_failure_mode: "Z" } })).rejects.toThrow("must be one of");
    const accepted = await reviewFinding(reviewer, space.id, diag.id, { action: "accept", note: "Agree, but the trigger mattered more.", values: { primary_failure_mode: "G_thin_trigger_context", one_line: "Thin trigger context sent it to the wrong component" } });
    expect(accepted).toMatchObject({ state: "accepted", edited: true, changed: ["primary_failure_mode", "one_line"] });
    const [d2] = await db().select().from(findings).where(eq(findings.id, diag.id));
    expect(d2).toMatchObject({ state: "accepted", reviewedBy: reviewer.email, reviewNote: "Agree, but the trigger mattered more.", title: `${BENCH[0]}: Thin trigger context sent it to the wrong component` });
    expect(d2!.proposed.primary_failure_mode).toBe(diag.proposed.primary_failure_mode);
    await expect(reviewFinding(reviewer, space.id, diag.id, { action: "accept" })).rejects.toThrow("already accepted");

    await reviewFinding(reviewer, space.id, fix0!.id, { action: "reject", note: "Not feasible" });
    await reviewFinding(reviewer, space.id, fix0!.id, { action: "reopen" });
    await reviewFinding(reviewer, space.id, fix0!.id, { action: "reject" });
    await reviewFinding(reviewer, space.id, fix1!.id, { action: "edit", values: { owner: "aws_service" } });
    const [f1] = await db().select().from(findings).where(eq(findings.id, fix1!.id));
    expect(f1).toMatchObject({ state: "proposed", edited: true, current: expect.objectContaining({ owner: "aws_service" }) });

    expect(await acceptAllProposed(reviewer, space.id, auditId, item!.id)).toEqual({ accepted: 2, skipped: 0 });
    const after = await db().select().from(findings).where(eq(findings.reviewId, item!.currentReviewId!));
    expect(after.map((f) => f.state).sort()).toEqual(["accepted", "accepted", "accepted", "rejected"]);
    expect(after.every((f) => f.reviewedBy === reviewer.email)).toBe(true);
    const events = (await db().select().from(auditEvents).where(eq(auditEvents.actorEmail, reviewer.email))).map((e) => e.action);
    expect(events).toEqual(expect.arrayContaining(["finding.accept", "finding.reject", "finding.reopen", "finding.edit", "finding.accept-all"]));

    const linkable = await listLinkableFindings(space.id, { auditId });
    expect(linkable).toHaveLength(3);
    expect(linkable.find((l) => l.id === diag.id)!.values.primary_failure_mode).toBe("G_thin_trigger_context");
    expect(await listLinkableFindings(space.id, { auditId, kind: "fix" })).toHaveLength(2);
    expect(await listLinkableFindings(space.id, { ids: ["not-a-uuid"] })).toEqual([]);
  });

  it("reruns an item: earlier decisions are kept, and carried where the model proposes the same values", async () => {
    const [failed] = await db().select().from(auditItems).where(and(eq(auditItems.auditId, auditId), eq(auditItems.incidentId, BENCH[2])));
    await rerunItem(actor, space.id, auditId, failed!.id);
    expect(await drain(space.id, deps)).toBe(1);
    const [fixed] = await db().select().from(auditItems).where(eq(auditItems.id, failed!.id));
    expect(fixed).toMatchObject({ state: "reviewed", stateReason: null });
    expect((await db().select().from(audits).where(eq(audits.id, auditId)))[0]!.state).toBe("reviewing");

    const [item] = await db().select().from(auditItems).where(and(eq(auditItems.auditId, auditId), eq(auditItems.incidentId, BENCH[0])));
    const oldReview = item!.currentReviewId!;
    await expect(rerunItem(actor, space.id, auditId, item!.id)).rejects.toMatchObject({ code: "confirm", details: { decided: 4 } });
    await rerunItem(actor, space.id, auditId, item!.id, { confirmReplace: true });
    expect((await db().select().from(audits).where(eq(audits.id, auditId)))[0]!.state).toBe("running");
    expect(await drain(space.id, deps)).toBe(1);

    const [now] = await db().select().from(auditItems).where(eq(auditItems.id, item!.id));
    expect(now!.currentReviewId).not.toBe(oldReview);
    const oldFindings = await db().select().from(findings).where(eq(findings.reviewId, oldReview));
    expect(oldFindings.map((f) => f.state).sort()).toEqual(["accepted", "accepted", "accepted", "rejected"]);
    const newFindings = await db().select().from(findings).where(eq(findings.reviewId, now!.currentReviewId!));
    // Same model output, so every decision carried over, edits included.
    expect(newFindings.map((f) => f.state).sort()).toEqual(["accepted", "accepted", "accepted", "rejected"]);
    expect(newFindings.every((f) => f.carriedFromId && oldFindings.some((o) => o.id === f.carriedFromId))).toBe(true);
    expect(newFindings.find((f) => f.kind === "diagnosis")!.current.primary_failure_mode).toBe("G_thin_trigger_context");
    expect(await auditEventsFor(item!.id)).toEqual(expect.arrayContaining(["audit.item.rerun", "audit.item.review-replaced"]));

    // The earlier review's findings are read-only, still linkable by ID, and left out of the picker.
    await expect(reviewFinding(reviewer, space.id, oldFindings[0]!.id, { action: "reopen" })).rejects.toThrow("earlier review");
    const picker = await listLinkableFindings(space.id, { auditId });
    expect(picker.some((l) => oldFindings.some((o) => o.id === l.id))).toBe(false);
    expect(await listLinkableFindings(space.id, { ids: oldFindings.map((o) => o.id) })).toHaveLength(3);

    const view = (await loadAuditItem(space, auditId, item!.id, { permissions: ["audits.read", "findings.review"] }))!;
    expect(view.reviews.map((r) => r.current)).toEqual([true, false]);
    expect(view.reviews[1]!.findings.every((f) => !f.current && !f.actions.accept.enabled)).toBe(true);
  });

  it("starts with incomplete items skipped when asked", async () => {
    const extra = await importMarkdown(space, "INCIDENT-9100_full_journal.md", syntheticJournal(9100));
    const { auditId: second } = await createAudit(actor, space.id, { name: "Partial ground truth", reviewModelId: "test-model", selections: [{ by: "incidents", incidentIds: [BENCH[0], "INCIDENT-9100"] }] });
    await expect(startAudit(actor, space.id, second)).rejects.toMatchObject({ code: "not-ready", message: "1 of 2 investigation(s) are not ready to run." });
    const res = await startAudit(actor, space.id, second, { skipIncomplete: true });
    expect(res).toMatchObject({ items: 1, skipped: 1 });
    const [skipped] = await db().select().from(auditItems).where(and(eq(auditItems.auditId, second), eq(auditItems.taskId, extra.taskId!)));
    expect(skipped).toMatchObject({ state: "skipped", stateReason: "Missing Confirmed root cause and Benchmark scorecard." });
    const audit = (await loadAuditDetail(space, second, { permissions: ["audits.read"] }))!;
    expect(audit.progress).toMatchObject({ total: 2, byState: { skipped: 1, pending: 1 } });
    expect(audit.actions.cancel.disabledReason).toBe("Your role can't run audits in this space.");
    await cancelAudit(actor, space.id, second);
  });

  it("keeps findings read-only once the audit is cancelled or finalized", async () => {
    await db().update(audits).set({ state: "finalized" }).where(eq(audits.id, auditId));
    const [f] = await db().select().from(findings).where(and(eq(findings.auditId, auditId), eq(findings.state, "proposed")));
    if (f) await expect(reviewFinding(reviewer, space.id, f.id, { action: "accept" })).rejects.toMatchObject({ code: "state" });
    await expect(deleteAudit(actor, space.id, auditId)).rejects.toThrow("A finalized audit can't be deleted.");
    await expect(reviewFinding(reviewer, crypto.randomUUID(), crypto.randomUUID(), { action: "accept" })).rejects.toMatchObject({ code: "not-found" });
  });
});
