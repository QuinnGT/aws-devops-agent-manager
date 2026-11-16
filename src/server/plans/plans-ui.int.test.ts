import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevOpsAgentClient } from "@aws-sdk/client-devops-agent";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Attribution, attributeChanges, attributionKey } from "@/server/attribution";
import { permissionsForRole } from "@/server/auth/roles";
import { db } from "@/server/db/client";
import { agentSpaces, auditEvents, drafts, historyRepos, jobRuns, planItems, plans, user } from "@/server/db/schema";
import { loadDraftEditorPage, loadDraftTable } from "@/server/drafts/loaders";
import { createDraftFromAsset, createPlanFromDrafts, discardDraft, getDraft, rebaseDraft, saveNewDraft, updateDraft } from "@/server/drafts/service";
import { resetEnvForTests } from "@/server/env";
import { getAppPolicy } from "@/server/policy";
import { getSpaceById } from "@/server/spaces/queries";
import { syncSpace } from "@/server/sync/engine";
import { type FakeSpace, fixtureSpace, TEST_SPACE_ID } from "@/server/sync/testing/fake-space";
import { truncateAll } from "../../../test/helpers/db";
import { runPlanCheck } from "./check";
import { countPlans, loadPlanList, loadPlanReview, WHAT_APPLY_DOES } from "./loaders";
import { checkDepsFor } from "./runtime";
import { createRetryPlan } from "./service";
import { settleIfApplyGaveUp } from "./stuck";
import { fakeReader, installWrites } from "./testing";
import type { PlanActor } from "./types";

// Jobs run directly in this test; nothing is sent to pg-boss.
vi.mock("@/server/jobs/enqueue", () => ({ enqueue: vi.fn(async () => crypto.randomUUID()) }));
vi.mock("@/server/attribution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/attribution")>();
  return { ...actual, attributeChanges: vi.fn(actual.attributeChanges) };
});

const policy = getAppPolicy().policy;
const AGENTS_MD = "ki-8578b1bb-b5ff-41d8-9368-4f106b846352";
const VERITY_SKILL = "ki-aa94f065-d420-4979-932c-41327da12ee3";
const author: PlanActor = { email: "editor@example.com", name: "Eda Editor", permissions: permissionsForRole(policy, "editor") };
const other: PlanActor = { email: "sam@example.com", name: "Sam Lee", permissions: permissionsForRole(policy, "editor") };

let dataDir: string;
let fake: FakeSpace;
let client: DevOpsAgentClient;
let spaceId: string;
const reader = () => fakeReader(fake, policy).reader;

async function check(planId: string, runId: string) {
  const space = (await getSpaceById(spaceId))!;
  return runPlanCheck(planId, { runId }, await checkDepsFor(space, author, client));
}

async function actions(): Promise<string[]> {
  return (await db().select({ action: auditEvents.action }).from(auditEvents).orderBy(asc(auditEvents.id))).map((r) => r.action);
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "dam-plans-ui-int-"));
  process.env.DAM_PROCESS = "worker";
  process.env.DAM_DATA_DIR = dataDir;
  resetEnvForTests();
  await truncateAll();
  fake = await fixtureSpace();
  fake.install();
  installWrites(fake, { createDefaults: { status: "ACTIVE" } });
  client = fakeReader(fake, policy).client;
  const [r] = await db().insert(historyRepos).values({ name: "plans-ui-history" }).returning();
  const [s] = await db()
    .insert(agentSpaces)
    .values({ alias: "test-space", displayName: "Customer Demo Space", region: "us-west-2", accountId: "111122223333", agentSpaceId: TEST_SPACE_ID, historyRepoId: r!.id })
    .returning();
  spaceId = s!.id;
  vi.mocked(attributeChanges).mockImplementation(async (changes) => {
    const out = new Map<string, Attribution>();
    for (const c of changes) out.set(attributionKey(c), { source: "console", label: "Operator Web App", principal: "alex", cloudTrailEventId: null, planId: null, matchedBy: "exact" });
    return out;
  });
  await syncSpace(spaceId, { actor: { email: "system:test" }, client, now: () => new Date("2026-11-11T12:00:00.000Z") });
}, 300_000);

afterAll(async () => {
  fake.restore();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the draft editor's first save", () => {
  it("starts the draft from live and saves only the changed files on it", async () => {
    const page = await loadDraftEditorPage(spaceId, AGENTS_MD, author, { reader: reader() });
    expect(page).toMatchObject({ editor: null, readOnly: false, fresh: { against: { source: "live", version: 5 }, mainFile: "AGENTS.md" } });
    const text = `${page!.fresh!.desired.files[0]!.content}\nName the runbook.\n`;

    await expect(saveNewDraft({ spaceId, assetId: AGENTS_MD, from: "live", expectedBaseVersion: 4, files: [{ path: "AGENTS.md", content: text }], metadata: page!.fresh!.desired.metadata, filesMode: "merge" }, author, { reader: reader() })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/Live moved to v5/),
    });
    // The refused save left a draft with no edits; the next save finds it.
    const [left] = await db().select().from(drafts).where(eq(drafts.createdBy, author.email));
    await db().delete(drafts).where(eq(drafts.id, left!.id));

    const saved = await saveNewDraft({ spaceId, assetId: AGENTS_MD, from: "live", expectedBaseVersion: 5, files: [{ path: "AGENTS.md", content: text }], metadata: page!.fresh!.desired.metadata, filesMode: "merge" }, author, { reader: reader() });
    const d = await getDraft(spaceId, saved.draftId);
    expect(d).toMatchObject({ baseVersion: 5, origin: "live" });
    expect(d!.desired.files.map((f) => f.content)).toEqual([text]);
    await expect(saveNewDraft({ spaceId, assetId: AGENTS_MD, from: "live", expectedBaseVersion: 5, files: [], metadata: {} }, author, { reader: reader() })).rejects.toMatchObject({ status: 409 });

    const audit = await actions();
    expect(audit.slice(-2)).toEqual(["draft.create", "draft.save"]);
    const [save] = await db().select().from(auditEvents).where(eq(auditEvents.action, "draft.save")).orderBy(asc(auditEvents.id));
    expect(save!.details).toMatchObject({ assetId: AGENTS_MD, baseVersion: 5, files: ["AGENTS.md"], metadataKeys: [] });
  });

  it("opens the viewer's own draft, and someone else's read only with ?draft=", async () => {
    const mine = await loadDraftEditorPage(spaceId, AGENTS_MD, author, { reader: reader() });
    expect(mine).toMatchObject({ readOnly: false, fresh: null, editor: { draft: { createdBy: author.email } }, others: [] });
    const sams = await loadDraftEditorPage(spaceId, AGENTS_MD, other, { reader: reader() });
    expect(sams!.editor).toBeNull();
    expect(sams!.others.map((o) => o.author)).toEqual([author.email]);
    const readOnly = await loadDraftEditorPage(spaceId, AGENTS_MD, other, { reader: reader(), draftId: mine!.editor!.draft.id });
    expect(readOnly).toMatchObject({ readOnly: true, editor: { canEdit: false, lockedReason: "Only the author of a draft can change it." } });
  });

  it("falls back to the last commit when live can't be read", async () => {
    const broken = { getAsset: async () => Promise.reject(new Error("CredentialsProviderError: Could not load credentials")), snapshot: async () => Promise.reject(new Error("no")) };
    const page = await loadDraftEditorPage(spaceId, VERITY_SKILL, author, { reader: broken as never });
    expect(page!.fresh!.against).toMatchObject({ source: "committed", version: 1, liveError: expect.stringMatching(/no AWS credentials/) });
  });

  it("Edit as draft starts from the last synced version when live can't be read, with that version as the base", async () => {
    const sdkError = Object.assign(new Error("Could not load credentials from any providers"), { name: "CredentialsProviderError" });
    const broken = { getAsset: async () => Promise.reject(sdkError), snapshot: async () => Promise.reject(sdkError) };
    const { draftId, existing } = await createDraftFromAsset({ spaceId, assetId: VERITY_SKILL }, other, { reader: broken as never });
    expect(existing).toBe(false);
    const d = (await getDraft(spaceId, draftId))!;
    expect(d).toMatchObject({ origin: "committed", baseVersion: 1, status: "open" });
    expect(d.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    await discardDraft({ spaceId, draftId }, other);
  });
});

describe("Use v<b> as the base", () => {
  it("moves the draft's base to live and keeps its text", async () => {
    const { draftId } = await createDraftFromAsset({ spaceId, assetId: VERITY_SKILL }, author, { reader: reader() });
    const before = (await getDraft(spaceId, draftId))!;
    const edited = before.desired.files.map((f) => ({ ...f, content: `${f.content}\nMine.\n` }));
    await updateDraft({ spaceId, draftId, files: edited }, author);
    fake.addVersion(VERITY_SKILL, { updatedAt: "2026-11-12T08:00:00.000Z", files: fake.latest(VERITY_SKILL).files.map((f) => ({ ...f, text: `${f.text}\nTheirs.\n` })) });

    const editor = await loadDraftEditorPage(spaceId, VERITY_SKILL, author, { reader: reader() });
    expect(editor!.editor!.live).toMatchObject({ ok: true, exists: true, version: 2, movedPastBase: true });
    await expect(rebaseDraft({ spaceId, draftId }, other, { reader: reader() })).rejects.toMatchObject({ status: 403 });
    expect(await rebaseDraft({ spaceId, draftId }, author, { reader: reader() })).toMatchObject({ baseVersion: 2 });
    const after = (await getDraft(spaceId, draftId))!;
    expect(after).toMatchObject({ baseVersion: 2, origin: "live" });
    expect(after.desired.files.map((f) => f.content)).toEqual(edited.map((f) => f.content));
    expect((await actions()).at(-1)).toBe("draft.rebase");
  });
});

describe("drafts table", () => {
  it("orders, counts and describes the space's drafts", async () => {
    await db().insert(user).values({ id: "u-sam", name: "Sam Lee", email: other.email }).onConflictDoNothing();
    const sam = await createDraftFromAsset({ spaceId, assetId: AGENTS_MD }, other, { reader: reader() });
    const d = (await getDraft(spaceId, sam.draftId))!;
    await updateDraft({ spaceId, draftId: sam.draftId, metadata: { ...d.desired.metadata, status: "INACTIVE" } }, other);

    const all = await loadDraftTable(spaceId, author);
    expect(all.counts).toEqual({ mine: 2, all: 3 });
    expect(all.rows.map((r) => [r.name, r.mine, r.change.kind, r.alsoNote])).toEqual([
      ["Global instructions", true, "content", "Sam Lee also has a draft"],
      ["verity", true, "content", null],
      ["Global instructions", false, "status", "you also have a draft"],
    ]);
    expect(all.rows.map((r) => r.authorName)).toEqual([author.email, author.email, "Sam Lee"]);
    expect((await loadDraftTable(spaceId, author, { mine: true })).rows).toHaveLength(2);
  });
});

describe("plan list and review additions", () => {
  let failedPlan: string;

  it("filters by origin and title, and counts", async () => {
    const mine = (await loadDraftTable(spaceId, author, { mine: true })).rows;
    const p = await createPlanFromDrafts({ spaceId, draftIds: mine.map((r) => r.id), title: "Runbook rules" }, author);
    await check(p.planId, p.checkRunId);
    failedPlan = p.planId;
    expect((await loadPlanList(spaceId, { q: "runbook", orderBy: "updated" })).map((r) => [r.title, r.originLine])).toEqual([["Runbook rules", "From 2 drafts"]]);
    expect(await loadPlanList(spaceId, { q: "%" })).toEqual([]);
    expect(await loadPlanList(spaceId, { originKinds: ["rollback"] })).toEqual([]);
    expect(await countPlans(spaceId, { states: ["ready", "checking"] })).toBe(1);

    const review = (await loadPlanReview(spaceId, p.planId, author))!;
    expect(review.whatApplyDoes).toEqual([
      "Re-reads each asset and skips any that changed since this check.",
      "Each change is sent once, even if apply is retried.",
      "Reads every asset back and checks it matches the plan.",
      "Saves the result in the history repository with your reason.",
    ]);
    expect(review.whatApplyDoes).toEqual([...WHAT_APPLY_DOES]);
    expect(review.selected).toMatchObject({ checked: true, writes: expect.stringMatching(/^Apply will (replace|change) /) });

    // A plan that didn't store its author's name (a restore plan) shows the name the sign-in table knows.
    await db().update(plans).set({ createdBy: other.email, createdByName: null }).where(eq(plans.id, p.planId));
    expect((await loadPlanList(spaceId, { q: "runbook" }))[0]!.authorName).toBe("Sam Lee");
    expect((await loadPlanReview(spaceId, p.planId, author))!.plan.authorName).toBe("Sam Lee");
    await db().update(plans).set({ createdBy: author.email, createdByName: author.name }).where(eq(plans.id, p.planId));
  });

  it("says the diff isn't ready before the check", async () => {
    const { draftId } = await createDraftFromAsset({ spaceId, assetId: AGENTS_MD }, other, { reader: reader() });
    const p = await createPlanFromDrafts({ spaceId, draftIds: [draftId], title: "Unchecked" }, other);
    const review = (await loadPlanReview(spaceId, p.planId, other))!;
    expect(review.plan.state).toBe("checking");
    expect(review.selected).toMatchObject({ checked: false, writes: null });
    expect(review.jobs.check).toBeNull();
    await db().update(plans).set({ state: "discarded" }).where(eq(plans.id, p.planId));
    await db().update(drafts).set({ status: "discarded", planId: null }).where(eq(drafts.id, draftId));
  });

  it("after a failed check, compares with the last synced version and says Check failed", async () => {
    const { draftId } = await createDraftFromAsset({ spaceId, assetId: VERITY_SKILL }, other, { reader: reader() });
    const d = (await getDraft(spaceId, draftId))!;
    const main = d.desired.files.find((f) => f.encoding === "utf8")!;
    await updateDraft({ spaceId, draftId, files: [{ path: main.path, content: `${main.content}One more line.\n` }], expectedUpdatedAt: d.updatedAt.toISOString() }, other);
    const p = await createPlanFromDrafts({ spaceId, draftIds: [draftId], title: "Synced compare" }, other);
    await db().update(plans).set({ state: "ready", checkedAt: new Date(), checkError: "CredentialsProviderError: Could not load credentials from any providers" }).where(eq(plans.id, p.planId));
    const r = (await loadPlanReview(spaceId, p.planId, other))!;
    expect(r.plan).toMatchObject({ checkFailed: true, comparedWith: "synced" });
    expect(r.tiles.contentUpdates).toBe(1);
    expect(r.items[0]).toMatchObject({ change: "content", versionLabel: "v1 → v2" });
    // Validation needs no live read: it runs against the last synced version and index.
    expect(r.items[0]!.validation.status).not.toBeNull();
    expect(r.tiles.validation).toMatchObject({ checks: 1 });
    // The count depends on what earlier tests left in the fake space; any added line shows the diff is filled.
    expect(r.selected).toMatchObject({ checked: true, comparedWith: "synced", removed: 0, writes: null });
    expect(r.selected!.added).toBeGreaterThan(0);
    expect(r.actions.primary).toMatchObject({ enabled: false });
    expect((await loadPlanList(spaceId, { q: "Synced compare" }))[0]).toMatchObject({ checkFailed: true, writes: 1, writesSynced: true });
    await db().update(plans).set({ state: "discarded" }).where(eq(plans.id, p.planId));
    await db().update(drafts).set({ status: "discarded", planId: null }).where(eq(drafts.id, draftId));
  });

  it("settles a plan whose apply job gave up, and shows the retry's origin", async () => {
    const [job] = await db().insert(jobRuns).values({ queue: "plans.apply", actorEmail: author.email, spaceId, input: {}, status: "failed", error: "Error: boom", bossJobId: "boss-1" }).returning();
    await db().update(plans).set({ state: "applying", applyRunId: job!.id }).where(eq(plans.id, failedPlan));
    const plan = (await db().select().from(plans).where(eq(plans.id, failedPlan)))[0]!;

    // pg-boss still retries: nothing changes, and the review shows the job's failure.
    expect(await settleIfApplyGaveUp(plan, { bossState: async () => "retry" })).toBe(false);
    const applying = await loadPlanReview(spaceId, failedPlan, author);
    expect(applying!.applyJob).toMatchObject({ status: "failed", error: "boom." });

    expect(await settleIfApplyGaveUp(plan, { bossState: async () => "failed" })).toBe(true);
    expect((await db().select({ state: plans.state }).from(plans).where(eq(plans.id, failedPlan)))[0]!.state).toBe("failed");
    const items = await db().select().from(planItems).where(eq(planItems.planId, failedPlan));
    expect(items.every((i) => i.progress === "failed" && i.progressMessage?.includes("Error: boom"))).toBe(true);
    expect((await db().select().from(drafts).where(and(eq(drafts.spaceId, spaceId), eq(drafts.createdBy, author.email)))).every((d) => d.status === "open" && d.planId === null)).toBe(true);
    expect((await actions()).at(-1)).toBe("plan.apply.fail");
    expect(await settleIfApplyGaveUp({ ...plan, state: "failed" }, { bossState: async () => "failed" })).toBe(false);

    const review = await loadPlanReview(spaceId, failedPlan, author);
    expect(review!.callouts.map((c) => c.kind)).toContain("apply-failed");
    expect(review!.actions.retryFailed).toMatchObject({ enabled: true });
    const retry = await createRetryPlan({ spaceId, planId: failedPlan }, author);
    const r = await loadPlanReview(spaceId, retry.planId, author);
    expect(r!.plan).toMatchObject({ originLine: "Retry of Runbook rules", retryOf: { id: failedPlan, title: "Runbook rules" } });
  });
});
