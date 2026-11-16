import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from "@aws-sdk/client-bedrock";
import { mockClient } from "aws-sdk-client-mock";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModelCatalogCache } from "@/server/ai/catalog";
import { noCredentialsText } from "@/server/ai/error-kind";
import type { ModelCatalog } from "@/server/ai/models";
import { db } from "@/server/db/client";
import { agentSpaces, auditEvents, auditItems, audits, findings, reviews } from "@/server/db/schema";
import { testJobContext } from "@/server/jobs/registry";
import { runImport, saveUpload } from "@/server/journals/import";
import { getSpaceById, type Space } from "@/server/spaces/queries";
import { truncateAll } from "../../../test/helpers/db";
import type { ReviewRunInput, ReviewRunResult, RunReview } from "./contract";
import { uploadGroundTruth } from "./evidence";
import { acceptAllProposed, checkCitation } from "./finding-review";
import { enqueueReview } from "./jobs";
import { loadAuditDetail, loadAuditItem, loadAuditList } from "./loaders";
import { runAuditJob, runReviewItemJob, type RunDeps } from "./run";
import { createAudit, rerunFailedItems, startAudit } from "./service";
import { reachableCatalog } from "./testing";
import { loadDraftEvidence } from "./ui";

/**
 * The audits service: startAudit refuses to start
 * when the app has no AWS credentials for the space (the model catalogue is a
 * mock, never AWS), "I checked the record" on a failed citation, reruns only
 * where a rerun can help, and "same file again" uploads.
 */

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

const bedrock = mockClient(BedrockClient);
beforeEach(() => {
  bedrock.reset();
  resetModelCatalogCache();
});

const actor = { email: "auditor@example.com" };
const reviewer = { email: "reviewer@example.com" };
const ctxFor = (spaceId: string, runId?: string) => testJobContext({ actor, spaceId, ...(runId ? { runId } : {}) });

const journal = (n: number) => `# INCIDENT-${n} — Full DevOps Agent Investigation Journal

_Execution: exe-start-${n} · Retrieved from prod · 3 records across 1 pages_

## Record 1 — message (2026-10-19 07:00:00.000000+00:00)

**role: user**

TITLE: INCIDENT-${n}

## Record 2 — message (2026-10-19 07:01:00.000000+00:00)

**role: assistant**

Checking the consumer lag for INCIDENT-${n}: steady ~1,100–1,880/min, FLAT, pre-existing.

## Record 3 — investigation_summary_md (2026-10-19 07:05:00.000000+00:00)

The cause is a slow consumer.
`;

async function createSpace(alias: string): Promise<Space> {
  const [row] = await db()
    .insert(agentSpaces)
    .values({ alias, region: "us-west-2", accountId: "111122223333", agentSpaceId: crypto.randomUUID(), awsProfile: "dam-test-no-such-profile" })
    .returning({ id: agentSpaces.id });
  return (await getSpaceById(row!.id))!;
}

async function importJournal(space: Space, n: number): Promise<string> {
  const { importId } = await saveUpload(space, { fileName: `INCIDENT-${n}_full_journal.md`, bytes: Buffer.from(journal(n)) }, actor);
  const report = await runImport({ importId }, ctxFor(space.id));
  return report.files[0]!.taskId!;
}

const catalog = (o: Partial<ModelCatalog>) => async (_s: unknown, _a: unknown, region: string): Promise<ModelCatalog> => ({ region, models: [], error: null, errorKind: null, errorDetail: null, fetchedAt: new Date().toISOString(), ...o });
const NO_CREDS = catalog({ error: "This app has no AWS credentials for this space, so it can't reach AWS. You can still type a model ID.", errorKind: "no-credentials", errorDetail: "CredentialsProviderError: Could not resolve credentials" });
const DENIED = catalog({ error: "AWS refused the request", errorKind: "access-denied", errorDetail: "IAM actions refused: bedrock:ListInferenceProfiles" });

const eventsOf = async (targetId: string) => db().select().from(auditEvents).where(eq(auditEvents.targetId, targetId));

function result(input: ReviewRunInput, over: Partial<ReviewRunResult>): ReviewRunResult {
  return {
    state: "succeeded",
    runner: "fake",
    modelId: input.profile.review.modelId!,
    promptDigest: "f".repeat(64),
    output: null,
    schemaValid: true,
    schemaErrors: [],
    citationCheck: null,
    steps: 3,
    inputTokens: 1200,
    outputTokens: 300,
    durationMs: 42,
    error: null,
    modelCalls: [],
    ...over,
  };
}

/** Run the audit's queued jobs: its audits.run job, then its review jobs. */
async function runJobs(spaceId: string, auditId: string, deps: RunDeps) {
  const job = h.queued.find((q) => q.queue === "audits.run" && q.input.auditId === auditId && !q.done)!;
  job.done = true;
  await runAuditJob(job.input as { auditId: string }, ctxFor(spaceId, job.runId), deps);
  for (let i = 0; i < 20; i++) {
    const next = h.queued.find((q) => q.queue === "audits.review-item" && q.input.auditId === auditId && !q.done);
    if (!next) break;
    next.done = true;
    await runReviewItemJob(next.input as { auditId: string; itemId: string }, ctxFor(spaceId, next.runId), deps);
  }
}

const beforeAfter = (tasks: string[]) => ({
  profileId: "before-after",
  reviewModelId: "m.audit",
  selections: [
    { by: "tasks" as const, taskIds: [tasks[0]!], cohort: "before" },
    { by: "tasks" as const, taskIds: [tasks[1]!], cohort: "after" },
  ],
});

beforeAll(async () => {
  await truncateAll();
});

describe("starting an audit that can't reach Bedrock", () => {
  let space: Space;
  const tasks: string[] = [];

  beforeAll(async () => {
    space = await createSpace(`start-${Date.now()}`);
    for (const n of [9401, 9402]) tasks.push(await importJournal(space, n));
  });

  it("refuses with the shared sentence when the app has no AWS credentials, and leaves the draft as it was", async () => {
    const { auditId } = await createAudit(actor, space.id, { name: "No credentials", ...beforeAfter(tasks) });
    await expect(startAudit(actor, space.id, auditId, {}, { listCatalog: NO_CREDS })).rejects.toMatchObject({
      code: "not-ready",
      message: noCredentialsText(true),
      details: { bedrock: "no-credentials", region: "us-west-2" },
    });
    const [a] = await db().select().from(audits).where(eq(audits.id, auditId));
    expect(a!.state).toBe("draft");
    expect((await eventsOf(auditId)).map((e) => e.action)).not.toContain("audit.start");
    expect(h.queued.filter((q) => q.input.auditId === auditId)).toHaveLength(0);
  });

  it("classifies a missing profile through the real catalogue (Bedrock mocked) and refuses the same way", async () => {
    const { auditId } = await createAudit(actor, space.id, { name: "No credentials, default catalogue", ...beforeAfter(tasks) });
    const noProfile = Object.assign(new Error("Could not resolve credentials using profile: [dam-test-no-such-profile] in configuration/credentials file(s)."), { name: "CredentialsProviderError" });
    bedrock.on(ListInferenceProfilesCommand).rejects(noProfile);
    bedrock.on(ListFoundationModelsCommand).rejects(noProfile);
    await expect(startAudit(actor, space.id, auditId)).rejects.toMatchObject({ code: "not-ready", details: { bedrock: "no-credentials" } });
    expect(bedrock.commandCalls(ListInferenceProfilesCommand).length).toBeGreaterThan(0);
  });

  it("still starts when only the model list is refused: a typed ID is used as is", async () => {
    const { auditId } = await createAudit(actor, space.id, { name: "List refused", ...beforeAfter(tasks) });
    const r = await startAudit(actor, space.id, auditId, {}, { listCatalog: DENIED });
    expect(r).toMatchObject({ items: 2, skipped: 0 });
    expect((await eventsOf(auditId)).map((e) => e.action)).toContain("audit.start");
  });

  it("reruns failed reviews only where a rerun can help", async () => {
    const { auditId } = await createAudit(actor, space.id, { name: "Reviews failed", ...beforeAfter(tasks) });
    await startAudit(actor, space.id, auditId, {}, { listCatalog: reachableCatalog("m.audit") });
    const noCreds: RunReview = async (input) => result(input, { state: "failed", error: "The model call failed: CredentialsProviderError: Could not resolve credentials using profile: [dam-test-no-such-profile]" });
    await runJobs(space.id, auditId, { enqueueReview, runReview: noCreds });
    const items = await db().select().from(auditItems).where(eq(auditItems.auditId, auditId));
    expect(items.map((i) => i.state)).toEqual(["failed", "failed"]);

    const list = (await loadAuditList(space)).find((r) => r.id === auditId)!;
    expect(list).toMatchObject({ state: "reviewing", itemStates: { failed: 2, reviewed: 0 }, findings: { total: 0 } });

    // Still no credentials: nothing is queued.
    expect(await rerunFailedItems(actor, space.id, auditId, { listCatalog: NO_CREDS })).toEqual({ queued: 0, left: 2 });
    // Fixed: both go again.
    expect(await rerunFailedItems(actor, space.id, auditId, { listCatalog: reachableCatalog("m.audit") })).toEqual({ queued: 2, left: 0 });
    const again = await db().select().from(auditItems).where(eq(auditItems.auditId, auditId));
    expect(again.every((i) => i.state === "reviewing" || i.state === "pending")).toBe(true);
  });
});

describe("I checked the record", () => {
  let space: Space;
  const tasks: string[] = [];
  let auditId = "";
  let itemId = "";

  beforeAll(async () => {
    space = await createSpace(`check-${Date.now()}`);
    for (const n of [9411, 9412]) tasks.push(await importJournal(space, n));
    ({ auditId } = await createAudit(actor, space.id, { name: "Citations", ...beforeAfter(tasks) }));
    await startAudit(actor, space.id, auditId, {}, { listCatalog: reachableCatalog("m.audit") });
    const issue = (n: number, record: number, quote: string | null) => ({ area: "tool_use", priority: "P1", issue: `Issue ${n}`, detail: "d", action: "a", owner: "instructions", evidence: [{ record, quote }] });
    const fake: RunReview = async (input) =>
      result(input, {
        output: { cohort: input.cohort?.id ?? "before", verdict: "v", conclusion_support: "supported", supported: "s", improved: null, concerns: "c", next: "n", one_line: "o", issues: [issue(0, 3, null), issue(1, 2, "the seat-hold cluster timed out")], citations: [] },
        citationCheck: {
          ok: false,
          checked: 2,
          failed: 1,
          citations: [
            { record: 3, quote: null, field: "issues[0].evidence[0]", ok: true },
            { record: 2, quote: "the seat-hold cluster timed out", field: "issues[1].evidence[0]", ok: false, problem: "quote-not-found" },
          ],
        },
      });
    await runJobs(space.id, auditId, { enqueueReview, runReview: fake });
    const [rev] = await db().select().from(reviews).where(and(eq(reviews.auditId, auditId), eq(reviews.state, "succeeded")));
    itemId = rev!.auditItemId;
  });

  it("stores who checked, when and the note with the finding, keeps the failed check, records an audit event, and lets bulk accept take it", async () => {
    const before = (await loadAuditList(space)).find((r) => r.id === auditId)!;
    expect(before.flaggedProposed).toBe(2);
    const fs = await db().select().from(findings).where(eq(findings.auditItemId, itemId));
    const flagged = fs.find((f) => f.citations.some((c) => !c.ok))!;
    expect((await loadAuditDetail(space, auditId, { permissions: ["audits.read"] }))!.items.find((i) => i.id === itemId)!.flaggedProposed).toBe(1);

    await expect(checkCitation(reviewer, space.id, flagged.id, { record: 2, note: "  " })).rejects.toMatchObject({ code: "invalid", message: "Say what you found in the record." });
    await expect(checkCitation(reviewer, space.id, flagged.id, { record: 3, note: "x" })).rejects.toMatchObject({ code: "invalid" });
    await expect(checkCitation(reviewer, crypto.randomUUID(), flagged.id, { record: 2, note: "x" })).rejects.toMatchObject({ code: "not-found" });

    const r = await checkCitation(reviewer, space.id, flagged.id, { record: 2, note: "The lag numbers are in R2; the quote is a paraphrase." });
    expect(r).toEqual({ findingId: flagged.id, record: 2, checked: 1 });
    const [after] = await db().select().from(findings).where(eq(findings.id, flagged.id));
    const c = after!.citations.find((x) => x.record === 2)!;
    expect(c).toMatchObject({ ok: false, problem: "quote-not-found", checked: { by: reviewer.email, note: "The lag numbers are in R2; the quote is a paraphrase." } });
    expect(new Date(c.checked!.at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(after!.state).toBe("proposed");

    const ev = (await eventsOf(flagged.id)).find((e) => e.action === "finding.citation.check")!;
    expect(ev).toMatchObject({ actorEmail: reviewer.email, spaceId: space.id });
    expect(ev.details).toMatchObject({ auditId, itemId, record: 2, problems: ["quote-not-found"], note: "The lag numbers are in R2; the quote is a paraphrase." });

    // A second check keeps the first note.
    await expect(checkCitation(actor, space.id, flagged.id, { record: 2, note: "again" })).rejects.toMatchObject({ code: "state" });

    // The page sees it as checked; the item no longer needs care first, and bulk accept takes the finding.
    const view = await loadAuditItem(space, auditId, itemId, { permissions: ["audits.read", "findings.review"] });
    expect(view!.reviews[0]!.findings.find((f) => f.id === flagged.id)!.citations.find((x) => x.record === 2)!.checked?.by).toBe(reviewer.email);
    expect(view!.item.flaggedProposed).toBe(0);
    expect((await loadAuditList(space)).find((x) => x.id === auditId)!.flaggedProposed).toBe(1);
    const bulk = await acceptAllProposed(reviewer, space.id, auditId, itemId);
    expect(bulk.accepted).toBe(fs.filter((f) => f.state === "proposed").length);
  });
});

describe("the same ground-truth file again", () => {
  it("tells a document uploaded again to the draft from one that was already in the space", async () => {
    const space = await createSpace(`gt-${Date.now()}`);
    for (const n of [9421, 9422]) await importJournal(space, n);
    const rca = (n: number) => ({ fileName: `INCIDENT-${n}_actual_rca.md`, bytes: Buffer.from(`# RCA ${n}\nA slow consumer.\n`) });
    await uploadGroundTruth(actor, space.id, [rca(9421), rca(9422)]);
    const { auditId } = await createAudit(actor, space.id, { name: "Ground truth again", reviewModelId: "m.audit", selections: [{ by: "incidents", incidentIds: ["INCIDENT-9421", "INCIDENT-9422"] }] });
    const report = await uploadGroundTruth(actor, space.id, [rca(9421)], { auditId });
    expect(report.matched[0]!.outcome).toBe("unchanged");
    const [row] = await db().select().from(audits).where(eq(audits.id, auditId));
    const rows = await loadDraftEvidence(space.id, row!);
    const doc = (n: number) => rows.find((r) => r.incidentId === `INCIDENT-${n}`)!.inputs.find((i) => i.kind === "actual_rca")!.doc!;
    expect(doc(9421)).toMatchObject({ reused: true, uploadedAgain: true });
    expect(doc(9422)).toMatchObject({ reused: true, uploadedAgain: false });
  });
});
