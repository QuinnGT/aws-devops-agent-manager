import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import JSZip from "jszip";
import { BedrockClient } from "@aws-sdk/client-bedrock";
import { mockClient } from "aws-sdk-client-mock";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db/client";
import { normalizeBundle } from "@/server/analyzers/normalize";
import { loadJournalBundle } from "@/server/analyzers/store";
import { agentSpaces, auditEvents, auditItems, audits, findings, modelCalls, reviews } from "@/server/db/schema";
import { testJobContext } from "@/server/jobs/registry";
import { runImport, saveUpload } from "@/server/journals/import";
import { getAppPolicy } from "@/server/policy";
import { getSpaceById, type Space } from "@/server/spaces/queries";
import { BENCHMARK_AUDIT_DIR, BENCHMARK_JOURNALS_DIR } from "../../../test/helpers/fixtures";
import { truncateAll } from "../../../test/helpers/db";
import { AuditRequestError } from "./errors";
import { uploadGroundTruth } from "./evidence";
import { reviewFinding } from "./finding-review";
import { enqueueReview } from "./jobs";
import { exportReviewFiles, handoffManifestSchema } from "./handoff";
import { importReviews } from "./handoff-import";
import { loadAuditDetail, loadAuditItem } from "./loaders";
import { runAuditJob, type RunDeps } from "./run";
import { createAudit, rerunItem, startAudit } from "./service";
import { benchmarkFixture, benchmarkReviews } from "./testing";

// Jobs are recorded, not sent to pg-boss, as in audits.int.test.ts.
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
const decider = { email: "reviewer@example.com" };
const LABEL = "Claude Code, Opus 5.5";

// A hand-off audit never calls Bedrock. The mock makes any call visible instead of reaching AWS.
const bedrock = mockClient(BedrockClient);
beforeEach(() => bedrock.reset());
beforeAll(async () => {
  await truncateAll();
});

const policy = getAppPolicy().policy;
const profile = policy.audits.profiles.benchmark!;
const diagnosisFields = profile.findings.find((f) => f.kind === "diagnosis")!.fields;
const reference = new Map(benchmarkReviews(BENCHMARK_AUDIT_DIR).map((r) => [String(r.raw.incident), r.raw]));
const INCIDENTS = [...reference.keys()].sort().slice(0, 3);
const journalFile = (inc: string, name: string) => path.join(BENCHMARK_JOURNALS_DIR, inc, name);

/** A reference review as a reviewer would write it: the sample files cite records as "R76", the schema wants numbers. */
const reviewOf = (inc: string): Record<string, unknown> => benchmarkFixture(reference.get(inc)!, diagnosisFields).output;

async function createSpace(alias: string): Promise<Space> {
  const [row] = await db().insert(agentSpaces).values({ alias, region: "us-west-2", accountId: "111122223333", agentSpaceId: crypto.randomUUID() }).returning({ id: agentSpaces.id });
  return (await getSpaceById(row!.id))!;
}

async function importJournal(space: Space, fileName: string, bytes: Buffer): Promise<string> {
  const { importId } = await saveUpload(space, { fileName, bytes }, actor);
  const report = await runImport({ importId }, testJobContext({ actor, spaceId: space.id }));
  expect(report.totals.failed).toBe(0);
  return report.files[0]!.taskId!;
}

const eventsOf = async (targetId: string) => (await db().select().from(auditEvents).where(eq(auditEvents.targetId, targetId))).map((e) => e.action);
const zipFiles = async (zip: JSZip) => JSZip.loadAsync(await zip.generateAsync({ type: "nodebuffer" }));
const manifestOf = async (z: JSZip, folder: string) => handoffManifestSchema.parse(JSON.parse(await z.file(`${folder}/manifest.json`)!.async("string")));

/** A zip of review folders: each folder's files from an export, plus its review.json when one is given. */
async function reviewZip(exported: JSZip, reviewsByFolder: Record<string, unknown | string>, opts: { manifests?: boolean } = {}): Promise<Buffer> {
  const out = new JSZip();
  for (const [folder, review] of Object.entries(reviewsByFolder)) {
    if (opts.manifests !== false) out.file(`${folder}/manifest.json`, await exported.file(`${folder}/manifest.json`)!.async("string"));
    out.file(`${folder}/review.json`, typeof review === "string" ? review : JSON.stringify(review));
  }
  return out.generateAsync({ type: "nodebuffer" });
}

describe("hand-off audit over three benchmark journals", () => {
  let space: Space;
  let auditId = "";
  const taskOf = new Map<string, string>();
  let exported: JSZip;
  const folders: Record<string, string> = {};
  const itemOf = async (inc: string) => (await db().select().from(auditItems).where(and(eq(auditItems.auditId, auditId), eq(auditItems.incidentId, inc))))[0]!;
  const reviewCount = async () => (await db().select().from(reviews).where(eq(reviews.auditId, auditId))).length;
  const deps: RunDeps = {
    enqueueReview,
    runReview: async () => {
      throw new Error("a hand-off audit makes no model review");
    },
  };

  beforeAll(async () => {
    expect(INCIDENTS, "the sample data needs three reference reviews").toHaveLength(3);
    space = await createSpace(`handoff-${Date.now()}`);
    for (const inc of INCIDENTS) taskOf.set(inc, await importJournal(space, `${inc}_full_journal.md`, readFileSync(journalFile(inc, `${inc}_full_journal.md`))));
    const num = (inc: string) => inc.replace("INCIDENT-", "");
    await uploadGroundTruth(
      actor,
      space.id,
      INCIDENTS.flatMap((inc) => [
        { fileName: `${num(inc)}_actual_rca.md`, bytes: readFileSync(journalFile(inc, `${num(inc)}_actual_rca.md`)) },
        { fileName: `${inc}_scorecard.md`, bytes: readFileSync(journalFile(inc, `${inc}_scorecard.md`)) },
      ]),
    );
  });

  it("stores the chosen reviewer in the audit, and refuses what policy does not offer", async () => {
    const sel = [{ by: "incidents" as const, incidentIds: INCIDENTS }];
    await expect(createAudit(actor, space.id, { name: "x", selections: sel, runner: "claude-agent-sdk" })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("is not offered") });
    await expect(createAudit(actor, space.id, { name: "x", selections: sel, runner: "handoff", runnerOptions: { modelTier: "smart" } })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining('has no option "modelTier"') });
    await expect(createAudit(actor, space.id, { name: "x", selections: sel, runner: "devops-agent-chat", runnerOptions: { modelTier: "turbo" } })).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("is not a choice for Model tier") });

    const chat = await createAudit(actor, space.id, { name: "chat", selections: sel, runner: "devops-agent-chat", reviewModelId: "typed-model" });
    const [c] = await db().select().from(audits).where(eq(audits.id, chat.auditId));
    expect((c!.profileSnapshot as { review: Record<string, unknown> }).review).toMatchObject({ runner: "devops-agent-chat", runnerOptions: { modelTier: "smart" } });
    expect((c!.profileSnapshot as { review: Record<string, unknown> }).review.modelId).toBeUndefined();

    ({ auditId } = await createAudit(actor, space.id, { name: "Hand-off audit", selections: sel, runner: "handoff", reviewModelId: "typed-model" }));
    const [a] = await db().select().from(audits).where(eq(audits.id, auditId));
    const review = (a!.profileSnapshot as { review: Record<string, unknown> }).review;
    expect(review).toMatchObject({ runner: "handoff", runnerOptions: {} });
    // Review files use no Bedrock model, so a typed model is not kept.
    expect(review.modelId).toBeUndefined();
    const created = (await db().select().from(auditEvents).where(and(eq(auditEvents.targetId, auditId), eq(auditEvents.action, "audit.create"))))[0]!;
    expect(created.details).toMatchObject({ runner: "handoff", runnerOptions: {}, reviewModelId: null });
  });

  it("starts without a review model and without any Bedrock call, and its items wait for a review file", async () => {
    await expect(startAudit(actor, space.id, auditId)).resolves.toMatchObject({ items: 3, skipped: 0 });
    const job = h.queued.find((q) => q.queue === "audits.run" && !q.done)!;
    job.done = true;
    const res = await runAuditJob(job.input as { auditId: string }, testJobContext({ actor, spaceId: space.id, runId: job.runId }), deps);
    expect(res).toMatchObject({ status: "analyzed", analyzed: 3, failed: 0, reviewsQueued: 0 });
    expect(h.queued.filter((q) => q.queue === "audits.review-item")).toHaveLength(0);
    expect(bedrock.calls()).toHaveLength(0);

    const items = await db().select().from(auditItems).where(eq(auditItems.auditId, auditId));
    for (const i of items) {
      expect(i).toMatchObject({ state: "pending", reviewJobRunId: null });
      expect(i.analyzedAt).toBeTruthy();
      expect(i.journalSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect((await db().select().from(audits).where(eq(audits.id, auditId)))[0]!.state).toBe("running");

    const viewer = { permissions: ["audits.read", "audits.run", "journals.export"] as const };
    const detail = (await loadAuditDetail(space, auditId, viewer))!;
    expect(detail.profile).toMatchObject({ runner: "handoff", runnerOptions: {} });
    expect(detail.items.map((i) => i.stateLabel)).toEqual(["Waiting for a review file", "Waiting for a review file", "Waiting for a review file"]);
    expect(detail.progress.waitingForReview).toBe(3);
    expect(detail.filesEligible).toBe(3);
    expect(detail.actions.reviewFiles).toMatchObject({ visible: true, download: { enabled: true }, import: { enabled: true } });
    const reader = (await loadAuditDetail(space, auditId, { permissions: ["audits.read"] }))!;
    expect(reader.actions.reviewFiles.download).toMatchObject({ enabled: false, disabledReason: expect.stringContaining("export journals") });
    expect(reader.actions.reviewFiles.import).toMatchObject({ enabled: false, disabledReason: "Your role can't run audits in this space." });

    const item = (await loadAuditItem(space, auditId, items[0]!.id, viewer))!;
    expect(item.runner).toBe("handoff");
    expect(item.actions.rerun).toMatchObject({ enabled: false, disabledReason: expect.stringContaining("Import a new review file") });
    await expect(rerunItem(actor, space.id, auditId, items[0]!.id)).rejects.toMatchObject({ code: "state" });
  });

  it("exports a folder of review files for each investigation, and records the export", async () => {
    const out = await exportReviewFiles(actor, space.id, auditId, { now: new Date("2026-11-19T16:00:00Z") });
    expect(out.left).toEqual([]);
    expect(out.fileName).toBe("Hand-off_audit-review-files.zip");
    expect(out.items.map((i) => i.folder).sort()).toEqual([...INCIDENTS].sort());
    exported = await zipFiles(out.zip);
    expect(Object.keys(exported.files).filter((n) => !n.endsWith("/")).sort()).toEqual(
      INCIDENTS.flatMap((inc) => ["README.md", "brief.md", "manifest.json", "records.md", "schema.json", "system.md"].map((f) => `${inc}/${f}`)).sort(),
    );

    for (const inc of INCIDENTS) {
      folders[inc] = inc;
      const item = await itemOf(inc);
      const m = await manifestOf(exported, inc);
      expect(m).toMatchObject({ auditId, itemId: item.id, taskId: taskOf.get(inc), incidentId: inc, journalSha256: item.journalSha256, profileId: "benchmark", runner: "handoff", createdAt: "2026-11-19T16:00:00.000Z" });
      const brief = await exported.file(`${inc}/brief.md`)!.async("string");
      expect(brief).toContain("records.md");
      expect(brief).not.toContain("{{");
      expect(brief).toContain(inc);
      const records = await exported.file(`${inc}/records.md`)!.async("string");
      expect(records).toMatch(/^## R1 /);
      const bundle = normalizeBundle((await loadJournalBundle(space.id, taskOf.get(inc)!))!);
      expect((records.match(/^## R\d+ /gm) ?? []).length).toBe(bundle.records.length);
      expect(bundle.records.length).toBeGreaterThan(0);
      expect(JSON.parse(await exported.file(`${inc}/schema.json`)!.async("string")).type).toBe("object");
      expect(await exported.file(`${inc}/system.md`)!.async("string")).toContain("records.md");
      const readme = await exported.file(`${inc}/README.md`)!.async("string");
      expect(readme).toContain(`# Review files for ${inc}`);
      expect(readme).toContain("Hand-off audit");
    }
    const ev = (await db().select().from(auditEvents).where(and(eq(auditEvents.targetId, auditId), eq(auditEvents.action, "audit.review-files.export"))))[0]!;
    expect(ev).toMatchObject({ actorEmail: actor.email, result: "ok" });
    expect(ev.details).toMatchObject({ scope: "audit", investigations: 3, incidents: expect.arrayContaining(INCIDENTS) });
  });

  it("exports one investigation, and refuses an item that is not in the audit", async () => {
    const item = await itemOf(INCIDENTS[1]!);
    const one = await exportReviewFiles(actor, space.id, auditId, { itemId: item.id });
    expect(one.fileName).toBe(`${INCIDENTS[1]}-review-files.zip`);
    const z = await zipFiles(one.zip);
    expect(Object.keys(z.files).filter((n) => !n.endsWith("/")).every((n) => n.startsWith(`${INCIDENTS[1]}/`))).toBe(true);
    await expect(exportReviewFiles(actor, space.id, auditId, { itemId: crypto.randomUUID() })).rejects.toMatchObject({ code: "not-found" });
    await expect(exportReviewFiles(actor, crypto.randomUUID(), auditId)).rejects.toMatchObject({ code: "not-found" });
  });

  it("refuses review files for an audit that is not a hand-off audit or not yet started", async () => {
    const other = await createAudit(actor, space.id, { name: "Bedrock audit", selections: [{ by: "incidents", incidentIds: [INCIDENTS[0]!] }], reviewModelId: "m" });
    await expect(exportReviewFiles(actor, space.id, other.auditId)).rejects.toMatchObject({ code: "state", message: expect.stringContaining("Amazon Bedrock model, not from review files") });
    await expect(importReviews(actor, space.id, other.auditId, [{ fileName: "review.json", bytes: Buffer.from("{}") }], { reviewer: LABEL })).rejects.toMatchObject({ code: "state" });
    const draft = await createAudit(actor, space.id, { name: "Draft hand-off", selections: [{ by: "incidents", incidentIds: [INCIDENTS[0]!] }], runner: "handoff" });
    await expect(exportReviewFiles(actor, space.id, draft.auditId)).rejects.toMatchObject({ code: "state", message: expect.stringContaining("The audit is draft") });
  });

  it("imports one review.json for an investigation, stores it as a hand-off review and keeps the audit running", async () => {
    const inc = INCIDENTS[0]!;
    const item = await itemOf(inc);
    const records = await exported.file(`${inc}/records.md`)!.async("string");
    // A quote copied from records.md under its heading passes the citation check.
    const section = records.slice(records.indexOf("## R2 ")).split(/^## R3 /m)[0]!.split("\n").slice(2).join(" ").replace(/\s+/g, " ").trim();
    const quote = section.slice(0, 40);
    const review = reviewOf(inc);
    (review.citations as unknown[]).push({ record: 2, quote, supports: "agent_final_answer" });
    (review.citations as unknown[]).push({ record: 2, quote: "text that is not in the record at all", supports: "near_miss" });

    const manifest = await exported.file(`${inc}/manifest.json`)!.async("string");
    const report = await importReviews(
      actor,
      space.id,
      auditId,
      [
        { fileName: "review.json", bytes: Buffer.from(JSON.stringify(review)) },
        { fileName: "manifest.json", bytes: Buffer.from(manifest) },
      ],
      { reviewer: `  ${LABEL} `, itemId: item.id },
    );
    expect(report.totals).toEqual({ files: 1, imported: 1, refused: 0, replaced: 0 });
    expect(report.results[0]).toMatchObject({ status: "imported", incidentId: inc, itemId: item.id, findings: 4, reason: null, note: null, replaced: false });
    expect(report.results[0]!.citations!.failed).toBe(1);

    const after = await itemOf(inc);
    expect(after).toMatchObject({ state: "reviewed", stateReason: null });
    const [row] = await db().select().from(reviews).where(eq(reviews.id, after.currentReviewId!));
    expect(row).toMatchObject({ runner: "handoff", modelId: LABEL, state: "succeeded", schemaValid: true, startedBy: actor.email, jobRunId: null, steps: 0 });
    expect(row!.promptDigest).toBe((await manifestOf(exported, inc)).promptDigest);
    const check = row!.citationCheck!;
    expect(check.citations.find((c) => c.quote === quote)).toMatchObject({ ok: true });
    expect(check.citations.find((c) => c.quote === "text that is not in the record at all")).toMatchObject({ ok: false, problem: "quote-not-found" });
    const fs = await db().select().from(findings).where(eq(findings.reviewId, row!.id));
    expect(fs.map((f) => f.kind).sort()).toEqual(["diagnosis", "fix", "fix", "fix"]);
    expect(fs.every((f) => f.state === "proposed" && f.incidentId === inc)).toBe(true);
    expect(await db().select().from(modelCalls).where(eq(modelCalls.auditId, auditId))).toHaveLength(0);
    expect((await db().select().from(audits).where(eq(audits.id, auditId)))[0]!.state).toBe("running");

    const ev = (await db().select().from(auditEvents).where(and(eq(auditEvents.targetId, auditId), eq(auditEvents.action, "audit.review-files.import"))))[0]!;
    expect(ev.details).toMatchObject({ scope: "investigation", reviewer: LABEL, files: 1, imported: 1, refused: 0, replaced: 0, incidents: [inc] });
    expect(bedrock.calls()).toHaveLength(0);

    const detail = (await loadAuditDetail(space, auditId, { permissions: ["audits.read"] }))!;
    expect(detail.items.map((i) => [i.incidentId, i.stateLabel]).sort()).toEqual(INCIDENTS.map((i) => [i, i === inc ? "Reviewed" : "Waiting for a review file"]).sort());
    const view = (await loadAuditItem(space, auditId, item.id, { permissions: ["audits.read"] }))!;
    expect(view.reviews[0]).toMatchObject({ runner: "handoff", modelId: LABEL, current: true });
  });

  it("refuses a review made from an older journal, another audit, another investigation or a wrong file, and stores nothing", async () => {
    const [inc1, inc2] = [INCIDENTS[1]!, INCIDENTS[2]!];
    const before = await reviewCount();
    const good = (inc: string) => JSON.stringify(reviewOf(inc));
    const manifest = async (inc: string, over: Record<string, unknown> = {}) => JSON.stringify({ ...JSON.parse(await exported.file(`${inc}/manifest.json`)!.async("string")), ...over });

    const zip = new JSZip();
    zip.file(`${inc1}/review.json`, good(inc1));
    zip.file(`${inc1}/manifest.json`, await manifest(inc1, { journalSha256: "f".repeat(64) }));
    zip.file(`${inc2}/review.json`, good(inc2));
    zip.file(`${inc2}/manifest.json`, await manifest(inc2, { auditId: crypto.randomUUID() }));
    zip.file("INCIDENT-99999/review.json", good(inc1));
    // The review in this folder says it is for another incident.
    const wrongFolder = new JSZip();
    wrongFolder.file(`${inc2}/review.json`, good(inc1));

    const report = await importReviews(
      actor,
      space.id,
      auditId,
      [
        { fileName: "reviews.zip", bytes: await zip.generateAsync({ type: "nodebuffer" }) },
        { fileName: "wrong.zip", bytes: await wrongFolder.generateAsync({ type: "nodebuffer" }) },
      ],
      { reviewer: LABEL },
    );
    expect(report.totals).toMatchObject({ imported: 0, refused: 4 });
    const reason = (needle: string) => report.results.find((r) => r.path.includes(needle))!.reason;
    expect(reason(`reviews.zip: ${inc1}/review.json`)).toContain("The journal changed after these review files were made");
    expect(reason(`reviews.zip: ${inc2}/review.json`)).toContain("different audit");
    expect(reason("INCIDENT-99999")).toContain('No investigation in this audit matches the folder "INCIDENT-99999"');
    expect(reason("wrong.zip")).toContain(`The review says it is for ${inc1}, but it was matched to ${inc2}`);
    expect(await reviewCount()).toBe(before);
    expect((await itemOf(inc1)).state).toBe("pending");
  });

  it("refuses a review that is not JSON or does not match the schema, with the reason", async () => {
    const inc = INCIDENTS[1]!;
    const notJson = await reviewZip(exported, { [inc]: "this is not json" });
    const r1 = await importReviews(actor, space.id, auditId, [{ fileName: "r.zip", bytes: notJson }], { reviewer: LABEL });
    expect(r1.results[0]).toMatchObject({ status: "refused", incidentId: inc, reason: expect.stringContaining("not a JSON object") });
    const wrong = await reviewZip(exported, { [inc]: { ...reviewOf(inc), primary_failure_mode: "Z_not_a_mode", extra: 1 } });
    const r2 = await importReviews(actor, space.id, auditId, [{ fileName: "r.zip", bytes: wrong }], { reviewer: LABEL });
    expect(r2.results[0]!.reason).toMatch(/does not match schema\.json \(\d+ errors?\): .*primary_failure_mode must be one of/);
    expect((await itemOf(inc)).state).toBe("pending");
  });

  it("refuses an unsafe zip as a whole, and a missing reviewer label", async () => {
    const before = await reviewCount();
    const z = new JSZip();
    z.file("xx/review.json", JSON.stringify(reviewOf(INCIDENTS[1]!)));
    // JSZip will not write ".." in a name, so write a safe name of the same length and patch the bytes.
    const evil = Buffer.from(await z.generateAsync({ type: "nodebuffer" }));
    for (let i = evil.indexOf("xx/review.json"); i >= 0; i = evil.indexOf("xx/review.json", i + 1)) evil.write("../review.json", i, "latin1");
    const rep = await importReviews(actor, space.id, auditId, [{ fileName: "evil.zip", bytes: evil }], { reviewer: LABEL });
    expect(rep.results).toHaveLength(1);
    expect(rep.results[0]).toMatchObject({ status: "refused", path: "evil.zip" });
    expect(rep.results[0]!.reason).toMatch(/"\.\." segment/);
    await expect(importReviews(actor, space.id, auditId, [{ fileName: "review.json", bytes: Buffer.from("{}") }], { reviewer: "  " })).rejects.toMatchObject({ code: "invalid", details: { field: "reviewer" } });
    await expect(importReviews(actor, space.id, auditId, [], { reviewer: LABEL })).rejects.toBeInstanceOf(AuditRequestError);
    expect(await reviewCount()).toBe(before);
  });

  it("imports a zip of folders, matching by manifest or by folder name, and settles the audit", async () => {
    const [a, b] = [INCIDENTS[1]!, INCIDENTS[2]!];
    // One folder keeps its manifest; the other has none and is matched by its name.
    const zip = new JSZip();
    zip.file(`${a}/manifest.json`, await exported.file(`${a}/manifest.json`)!.async("string"));
    zip.file(`${a}/review.json`, JSON.stringify(reviewOf(a)));
    zip.file(`${a}/records.md`, "x".repeat(1000));
    zip.file(`${b}/review.json`, JSON.stringify(reviewOf(b)));
    zip.file(`${INCIDENTS[0]}/manifest.json`, await exported.file(`${INCIDENTS[0]}/manifest.json`)!.async("string"));
    zip.file("__MACOSX/._x", "junk");
    const report = await importReviews(actor, space.id, auditId, [{ fileName: "reviews.zip", bytes: await zip.generateAsync({ type: "nodebuffer" }) }], { reviewer: LABEL });
    expect(report.withoutReview).toBe(1);
    expect(report.totals).toEqual({ files: 2, imported: 2, refused: 0, replaced: 0 });
    const byInc = new Map(report.results.map((r) => [r.incidentId, r]));
    expect(byInc.get(a)).toMatchObject({ status: "imported", note: null });
    expect(byInc.get(b)).toMatchObject({ status: "imported", note: expect.stringContaining("No manifest.json came with this review") });

    expect((await db().select().from(audits).where(eq(audits.id, auditId)))[0]!.state).toBe("reviewing");
    expect(await eventsOf(auditId)).toContain("audit.run.completed");
    const detail = (await loadAuditDetail(space, auditId, { permissions: ["audits.read"] }))!;
    expect(detail.items.every((i) => i.state === "reviewed" && i.findings.proposed === 4)).toBe(true);
    expect(detail.actions.reviewFiles).toMatchObject({ visible: true });
  });

  it("replaces a review when it is imported again, carrying decisions that propose the same values", async () => {
    const inc = INCIDENTS[0]!;
    const item = await itemOf(inc);
    const oldReview = item.currentReviewId!;
    const [diag] = await db().select().from(findings).where(and(eq(findings.reviewId, oldReview), eq(findings.kind, "diagnosis")));
    await reviewFinding(decider, space.id, diag!.id, { action: "accept", note: "Agreed" });

    const report = await importReviews(
      actor,
      space.id,
      auditId,
      [{ fileName: "r.zip", bytes: await reviewZip(exported, { [inc]: reviewOf(inc) }) }],
      { reviewer: "Kiro CLI" },
    );
    expect(report.totals).toEqual({ files: 1, imported: 1, refused: 0, replaced: 1 });
    expect(report.results[0]).toMatchObject({ replaced: true, carried: 1 });
    const now = await itemOf(inc);
    expect(now.currentReviewId).not.toBe(oldReview);
    expect((await db().select().from(reviews).where(eq(reviews.id, now.currentReviewId!)))[0]).toMatchObject({ modelId: "Kiro CLI", runner: "handoff" });
    const carried = (await db().select().from(findings).where(and(eq(findings.reviewId, now.currentReviewId!), eq(findings.kind, "diagnosis"))))[0]!;
    expect(carried).toMatchObject({ state: "accepted", reviewedBy: decider.email, carriedFromId: diag!.id });
    expect(await eventsOf(item.id)).toContain("audit.item.review-replaced");
    // The earlier review and its decision stay with it.
    expect((await db().select().from(findings).where(eq(findings.id, diag!.id)))[0]!.state).toBe("accepted");
    expect((await db().select().from(audits).where(eq(audits.id, auditId)))[0]!.state).toBe("reviewing");
    expect(bedrock.calls()).toHaveLength(0);
  });

  it("refuses to export or import once the audit is cancelled or finalized", async () => {
    await db().update(audits).set({ state: "finalized" }).where(eq(audits.id, auditId));
    await expect(exportReviewFiles(actor, space.id, auditId)).rejects.toMatchObject({ code: "state", message: expect.stringContaining("The audit is finalized") });
    await expect(importReviews(actor, space.id, auditId, [{ fileName: "review.json", bytes: Buffer.from("{}") }], { reviewer: LABEL })).rejects.toMatchObject({ code: "state" });
    await db().update(audits).set({ state: "reviewing" }).where(eq(audits.id, auditId));
  });
});
