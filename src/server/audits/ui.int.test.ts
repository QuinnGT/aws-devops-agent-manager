import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db/client";
import { agentSpaces, auditEvents, audits, findings, reviews } from "@/server/db/schema";
import { testJobContext } from "@/server/jobs/registry";
import { runImport, saveUpload } from "@/server/journals/import";
import { getSpaceById, type Space } from "@/server/spaces/queries";
import { truncateAll } from "../../../test/helpers/db";
import type { ReviewRunInput, ReviewRunResult, RunReview } from "./contract";
import { uploadGroundTruth } from "./evidence";
import { acceptAllProposed } from "./finding-review";
import { enqueueReview } from "./jobs";
import { runAuditJob, runReviewItemJob, type RunDeps } from "./run";
import { createAudit, setAuditModels, startAudit, updateAuditDraft } from "./service";
import { reachableCatalog } from "./testing";
import { auditEventTimes, auditModels, auditUsage, getRecordText, journalRecordCount, loadAuditListPage, loadDraftEvidence, previewSelection, reviewHighlights } from "./ui";

// Jobs run directly; enqueue records a job_runs row only (as in audits.int.test.ts).
const h = vi.hoisted(() => ({ queued: [] as { queue: string; input: Record<string, string>; runId: string; done: boolean }[] }));
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
vi.mock("@/server/jobs/boss", () => ({ boss: async () => ({ cancel: async () => undefined }) }));

const actor = { email: "auditor@example.com" };
const ctxFor = (spaceId: string, runId?: string) => testJobContext({ actor, spaceId, ...(runId ? { runId } : {}) });

const journal = (n: number) => `# INCIDENT-${n} — Full DevOps Agent Investigation Journal

_Execution: exe-ui-${n} · Retrieved from prod · 3 records across 1 pages_

## Record 1 — message (2026-10-19 07:00:00.000000+00:00)

**role: user**

TITLE: INCIDENT-${n}

## Record 2 — message (2026-10-19 07:01:00.000000+00:00)

**role: assistant**

Checking the consumer lag for INCIDENT-${n} before anything else.

## Record 3 — investigation_summary_md (2026-10-19 07:05:00.000000+00:00)

The cause is a slow consumer.
`;

async function createSpace(alias: string): Promise<Space> {
  const [row] = await db()
    .insert(agentSpaces)
    .values({ alias, region: "us-west-2", accountId: "111122223333", agentSpaceId: crypto.randomUUID() })
    .returning({ id: agentSpaces.id });
  return (await getSpaceById(row!.id))!;
}

async function importJournal(space: Space, n: number): Promise<string> {
  const { importId } = await saveUpload(space, { fileName: `INCIDENT-${n}_full_journal.md`, bytes: Buffer.from(journal(n)) }, actor);
  const report = await runImport({ importId }, ctxFor(space.id));
  return report.files[0]!.taskId!;
}

const eventsOf = async (targetId: string) => (await db().select().from(auditEvents).where(eq(auditEvents.targetId, targetId))).map((e) => e.action);

function reviewResult(input: ReviewRunInput, output: unknown, citations: ReviewRunResult["citationCheck"]): ReviewRunResult {
  return {
    state: "succeeded",
    runner: "fake",
    modelId: input.profile.review.modelId!,
    promptDigest: "f".repeat(64),
    output,
    schemaValid: true,
    schemaErrors: [],
    citationCheck: citations,
    steps: 3,
    inputTokens: 1200,
    outputTokens: 300,
    durationMs: 42,
    error: null,
    modelCalls: [{ purpose: "review", runner: "fake", modelId: input.profile.review.modelId!, region: input.region, steps: 3, inputTokens: 1200, outputTokens: 300, durationMs: 42, error: null }],
  };
}

beforeAll(async () => {
  await truncateAll();
});

describe("audit page data", () => {
  let space: Space;
  const tasks: Record<number, string> = {};

  beforeAll(async () => {
    space = await createSpace(`audits-ui-${Date.now()}`);
    for (const n of [9201, 9202]) tasks[n] = await importJournal(space, n);
  });

  it("sets a draft's models, records where each came from, and refuses bad IDs", async () => {
    const { auditId } = await createAudit(actor, space.id, { name: "Models", reviewModelId: "m.audit", selections: [{ by: "tasks", taskIds: [tasks[9201]!] }] });
    const [row] = await db().select().from(audits).where(eq(audits.id, auditId));
    expect(await auditModels(row!)).toEqual({
      review: { id: "m.audit", source: "audit", sourceLabel: "Chosen for this audit" },
      report: { id: "m.audit", source: "review-model", sourceLabel: "Same as the review model" },
    });

    // An Admin sets a space default; the draft switches to it when its own choice is cleared.
    await db()
      .update(agentSpaces)
      .set({ settings: sql`jsonb_build_object('inference', jsonb_build_object('mode', 'space', 'region', null, 'reviewModelId', 'm.space', 'reportModelId', null))` })
      .where(eq(agentSpaces.id, space.id));
    const r1 = await setAuditModels(actor, space.id, auditId, { reviewModelId: "", reportModelId: "m.report" });
    expect(r1).toMatchObject({ review: { id: "m.space", source: "space" }, report: { id: "m.report", source: "audit" } });
    const [after] = await db().select().from(audits).where(eq(audits.id, auditId));
    expect((after!.profileSnapshot as { review: { modelId?: string }; report: { modelId?: string } }).review.modelId).toBe("m.space");
    expect((after!.profileSnapshot as { report: { modelId?: string } }).report.modelId).toBe("m.report");
    expect(await auditModels(after!)).toMatchObject({ review: { id: "m.space", sourceLabel: "Space default" }, report: { id: "m.report", sourceLabel: "Chosen for this audit" } });
    expect(await eventsOf(auditId)).toContain("audit.models.set");

    await expect(setAuditModels(actor, space.id, auditId, { reviewModelId: "not a model id!" })).rejects.toMatchObject({ code: "invalid" });
    await expect(setAuditModels(actor, crypto.randomUUID(), auditId, { reviewModelId: "x" })).rejects.toMatchObject({ code: "not-found" });

    await updateAuditDraft(actor, space.id, auditId, { name: "Models renamed" });
    expect((await db().select().from(audits).where(eq(audits.id, auditId)))[0]!.name).toBe("Models renamed");
    await expect(updateAuditDraft(actor, space.id, auditId, { name: " " })).rejects.toThrow("Enter a name.");
    expect(await eventsOf(auditId)).toContain("audit.update");

    // Clear the space default again for the tests below.
    await db().update(agentSpaces).set({ settings: {} }).where(eq(agentSpaces.id, space.id));
  });

  it("reads one record of an investigation's journal as text, and nothing else", async () => {
    const rec = await getRecordText(space, tasks[9201]!, 2);
    expect(rec).toMatchObject({ n: 2, total: 3, recordType: "message" });
    if (!rec || "missing" in rec) throw new Error("expected a record");
    expect(rec.text).toContain("consumer lag for INCIDENT-9201");
    expect(rec.text).not.toContain("INCIDENT-9202");
    expect(rec.href).toBe(`/spaces/${space.alias}/journals/investigations/${encodeURIComponent(tasks[9201]!)}#rec-${encodeURIComponent(rec.recordId)}`);
    expect(await getRecordText(space, tasks[9201]!, 99)).toEqual({ missing: true, total: 3 });
    expect(await getRecordText(space, "no-such-task", 1)).toBeNull();
    expect(await getRecordText(space, tasks[9201]!, 0)).toBeNull();
    // Another space can't read this space's journal.
    const other = await createSpace(`audits-ui-other-${Date.now()}`);
    expect(await getRecordText(other, tasks[9201]!, 2)).toBeNull();
    expect(await journalRecordCount(space.id, tasks[9201]!)).toBe(3);
  });

  it("previews a selection: found, IDs without a cached journal, ground truth on hand", async () => {
    const p = await previewSelection(space.id, { by: "incidents", incidentIds: ["INCIDENT-9201", "INCIDENT-9999"] }, ["actual_rca", "scorecard"]);
    expect(p.found.map((f) => [f.incidentId, f.executions, f.docKinds])).toEqual([["INCIDENT-9201", 1, []]]);
    expect(p.missing).toEqual(["INCIDENT-9999"]);
    expect(p.overLimit).toBe(false);
    await uploadGroundTruth(actor, space.id, [{ fileName: "9201_actual_rca.md", bytes: Buffer.from("# RCA\nA slow consumer.\n") }]);
    const p2 = await previewSelection(space.id, { by: "incidents", incidentIds: ["INCIDENT-9201"] }, ["actual_rca", "scorecard"]);
    expect(p2.found[0]!.docKinds).toEqual(["actual_rca"]);
    const range = await previewSelection(space.id, { by: "range", from: new Date("2026-10-19T00:00:00Z"), to: new Date("2026-10-20T00:00:00Z") });
    expect(range.found).toHaveLength(2);
    const none = await previewSelection(space.id, { by: "range", from: new Date("2020-01-01T00:00:00Z"), to: new Date("2020-01-02T00:00:00Z") });
    expect(none.found).toEqual([]);
  });

  it("lists a draft's ground truth per incident, marking documents uploaded before the draft as reused", async () => {
    const { auditId } = await createAudit(actor, space.id, { name: "Ground truth", reviewModelId: "m.audit", selections: [{ by: "incidents", incidentIds: ["INCIDENT-9201", "INCIDENT-9202"] }] });
    await uploadGroundTruth(actor, space.id, [{ fileName: "INCIDENT-9202_scorecard.md", bytes: Buffer.from("| DevOps RCA score | **2/5** |\n| Verdict | Miss |\n") }], { auditId });
    const [row] = await db().select().from(audits).where(eq(audits.id, auditId));
    const rows = await loadDraftEvidence(space.id, row!);
    expect(rows.map((r) => r.incidentId)).toEqual(["INCIDENT-9201", "INCIDENT-9202"]);
    const a = rows[0]!.inputs.find((i) => i.kind === "actual_rca")!;
    expect(a.doc).toMatchObject({ fileName: "9201_actual_rca.md", reused: true, uploadedBy: actor.email });
    const s = rows[1]!.inputs.find((i) => i.kind === "scorecard")!;
    expect(s.doc).toMatchObject({ reused: false, fields: expect.arrayContaining([{ key: "score", label: "Score", value: "2/5" }]) });
    expect(rows[1]!.inputs.find((i) => i.kind === "actual_rca")!.doc).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("A slow consumer");
  });

  it("bulk accept leaves out findings whose citation failed; the page reads started-by, tokens and highlights", async () => {
    const { auditId } = await createAudit(actor, space.id, {
      name: "Before and after",
      profileId: "before-after",
      reviewModelId: "m.audit",
      selections: [
        { by: "tasks", taskIds: [tasks[9201]!], cohort: "before" },
        { by: "tasks", taskIds: [tasks[9202]!], cohort: "after" },
      ],
    });
    await startAudit(actor, space.id, auditId, {}, { listCatalog: reachableCatalog() });
    const issue = (n: number, record: number) => ({ area: "tool_use", priority: "P1", issue: `Issue ${n}`, detail: "d", action: "a", owner: "instructions", evidence: [{ record, quote: null }] });
    const fake: RunReview = async (input) =>
      reviewResult(
        input,
        { cohort: input.cohort?.id ?? "before", verdict: "Supported by R2", conclusion_support: "supported", supported: "s", improved: null, concerns: "c", next: "n", one_line: "o", issues: [issue(0, 2), issue(1, 99)], citations: [] },
        {
          ok: false,
          checked: 2,
          failed: 1,
          citations: [
            { record: 2, quote: null, field: "issues[0].evidence[0]", ok: true },
            { record: 99, quote: null, field: "issues[1].evidence[0]", ok: false, problem: "missing-record" },
          ],
        },
      );
    const deps: RunDeps = { enqueueReview, runReview: fake };
    const job = h.queued.find((q) => q.queue === "audits.run" && !q.done)!;
    job.done = true;
    await runAuditJob(job.input as { auditId: string }, ctxFor(space.id, job.runId), deps);
    for (let i = 0; i < 10; i++) {
      const next = h.queued.find((q) => q.queue === "audits.review-item" && !q.done);
      if (!next) break;
      next.done = true;
      await runReviewItemJob(next.input as { auditId: string; itemId: string }, ctxFor(space.id, next.runId), deps);
    }
    const [a] = await db().select().from(audits).where(eq(audits.id, auditId));
    expect(a!.state).toBe("reviewing");

    const [rev] = await db().select().from(reviews).where(eq(reviews.auditId, auditId));
    const itemId = rev!.auditItemId;
    const before = await db().select().from(findings).where(eq(findings.reviewId, rev!.id));
    expect(before.map((f) => f.kind).sort()).toEqual(["case", "issue", "issue"]);
    expect(await acceptAllProposed(actor, space.id, auditId, itemId)).toEqual({ accepted: 2, skipped: 1 });
    const after = await db().select().from(findings).where(eq(findings.reviewId, rev!.id));
    const flagged = after.find((f) => f.citations.some((c) => !c.ok))!;
    expect(flagged.state).toBe("proposed");
    expect(after.filter((f) => f.state === "accepted")).toHaveLength(2);

    const times = await auditEventTimes(auditId, ["audit.start", "audit.cancel"]);
    expect(times["audit.start"]).toMatchObject({ by: actor.email });
    expect(times["audit.cancel"]).toBeNull();
    expect(await auditUsage(auditId)).toEqual({ inputTokens: 2400, outputTokens: 600, calls: 2 });

    expect(await reviewHighlights(itemId, rev!.id)).toEqual({ groundTruthUncertain: false, agentFinalAnswer: null, scoredSummaryRecord: null });
    await db()
      .update(reviews)
      .set({ output: { ground_truth_uncertain: true, agent_final_answer: "A slow consumer.", scored_summary_record: 3 } })
      .where(eq(reviews.id, rev!.id));
    expect(await reviewHighlights(itemId, rev!.id)).toEqual({ groundTruthUncertain: true, agentFinalAnswer: "A slow consumer.", scoredSummaryRecord: 3 });
    // A review of another item is not read.
    expect(await reviewHighlights(crypto.randomUUID(), rev!.id)).toEqual({ groundTruthUncertain: false, agentFinalAnswer: null, scoredSummaryRecord: null });

    // A draft's models can't change once it has started.
    await expect(setAuditModels(actor, space.id, auditId, { reviewModelId: "m.other" })).rejects.toMatchObject({ code: "state" });
  });

  it("filters the audits list and counts each state", async () => {
    const open = await loadAuditListPage(space, { state: "open", limit: 50 });
    expect(open.rows.map((r) => r.name).sort()).toEqual(["Before and after", "Ground truth", "Models renamed"]);
    expect(open.counts).toMatchObject({ open: 3, finalized: 0, cancelled: 0, all: 3 });
    const bench = await loadAuditListPage(space, { state: "all", profileId: "before-after", limit: 50 });
    expect(bench.rows.map((r) => r.name)).toEqual(["Before and after"]);
    expect(bench.rows[0]!.findings).toMatchObject({ accepted: 2 });
    const named = await loadAuditListPage(space, { state: "all", q: "GROUND", limit: 1 });
    expect(named.rows.map((r) => r.name)).toEqual(["Ground truth"]);
    expect((await loadAuditListPage(space, { state: "all", limit: 2 })).more).toBe(true);
    expect((await loadAuditListPage(space, { state: "finalized", limit: 50 })).rows).toEqual([]);
    const other = await createSpace(`audits-ui-empty-${Date.now()}`);
    expect(await loadAuditListPage(other, { state: "open", limit: 50 })).toMatchObject({ rows: [], any: false });
    expect(await db().select().from(audits).where(and(eq(audits.spaceId, other.id)))).toEqual([]);
  });
});
