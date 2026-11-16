import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevOpsAgentClient } from "@aws-sdk/client-devops-agent";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Attribution, attributeChanges, attributionKey } from "@/server/attribution";
import { permissionsForRole } from "@/server/auth/roles";
import { db } from "@/server/db/client";
import { agentSpaces, applyRuns, assetChanges, assetReasons, auditEvents, drafts, historyRepos, planItems, plans } from "@/server/db/schema";
import { resetEnvForTests } from "@/server/env";
import { HistoryRepo } from "@/server/git/history-repo";
import { enqueue } from "@/server/jobs/enqueue";
import { getAppPolicy } from "@/server/policy";
import { getSpaceById, toHistoryRepoConfig } from "@/server/spaces/queries";
import { syncSpace } from "@/server/sync/engine";
import { type FakeSpace, fixtureSpace, TEST_SPACE_ID } from "@/server/sync/testing/fake-space";
import { truncateAll } from "../../../test/helpers/db";
import { createDraftFromAsset, createNewDraft, createPlanFromDrafts, discardDraft, listDrafts, updateDraft } from "@/server/drafts/service";
import { loadDraftEditor, loadDraftList } from "@/server/drafts/loaders";
import { runPlanApply } from "./apply";
import { findPlanItemByClientToken } from "./attribution";
import { runPlanCheck } from "./check";
import { createPlan } from "./index";
import { loadPlanList, loadPlanReview } from "./loaders";
import { applyDepsFor, checkDepsFor } from "./runtime";
import { approvePlan, discardPlan, rejectPlan, requestApproval, startApply } from "./service";
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
const OVERVIEW = "ki-9184fa09-8e79-4a11-90fa-a6b81ab5fe6b";
const MD_DIR = "spaces/test-space/agents_md/GENERIC";

const author: PlanActor = { email: "editor@example.com", name: "Eda Editor", permissions: permissionsForRole(policy, "editor") };
const publisher: PlanActor = { email: "pub@example.com", name: "Pat Publisher", permissions: permissionsForRole(policy, "publisher") };
const authorPub: PlanActor = { ...author, permissions: permissionsForRole(policy, "publisher") };

let dataDir: string;
let fake: FakeSpace;
let client: DevOpsAgentClient;
let spaceId: string;
let repo: HistoryRepo;

function consoleAttribution() {
  vi.mocked(attributeChanges).mockImplementation(async (changes) => {
    const out = new Map<string, Attribution>();
    for (const c of changes) out.set(attributionKey(c), { source: "console", label: "Operator Web App", principal: "alex", cloudTrailEventId: null, planId: null, matchedBy: "exact" });
    return out;
  });
}

async function setSettings(settings: Record<string, unknown>) {
  await db().update(agentSpaces).set({ settings }).where(eq(agentSpaces.id, spaceId));
}

async function checkPlan(planId: string, runId: string, actor = author) {
  const space = (await getSpaceById(spaceId))!;
  return runPlanCheck(planId, { runId }, await checkDepsFor(space, actor, client));
}

async function applyPlan(planId: string, runId: string, actor: PlanActor) {
  const space = (await getSpaceById(spaceId))!;
  return runPlanApply(planId, { runId, actor: { email: actor.email } }, await applyDepsFor(space, { email: actor.email }, { read: client, write: client }));
}

async function auditActions(): Promise<string[]> {
  return (await db().select({ action: auditEvents.action }).from(auditEvents).orderBy(asc(auditEvents.id))).map((r) => r.action);
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "dam-plans-int-"));
  process.env.DAM_PROCESS = "worker";
  process.env.DAM_DATA_DIR = dataDir;
  resetEnvForTests();
  await truncateAll();
  fake = await fixtureSpace();
  fake.updateInPlace(OVERVIEW, {}, "2026-11-07T18:33:31.000Z");
  fake.install();
  installWrites(fake, { createDefaults: { status: "ACTIVE" } });
  client = fakeReader(fake, policy).client;
  const [r] = await db().insert(historyRepos).values({ name: "plans-history" }).returning();
  const [s] = await db()
    .insert(agentSpaces)
    .values({ alias: "test-space", displayName: "Customer Demo Space", region: "us-west-2", accountId: "111122223333", agentSpaceId: TEST_SPACE_ID, historyRepoId: r!.id })
    .returning();
  spaceId = s!.id;
  repo = await HistoryRepo.open(toHistoryRepoConfig(r!));
  consoleAttribution();
  await syncSpace(spaceId, { actor: { email: "system:test" }, client, now: () => new Date("2026-11-11T12:00:00.000Z") });
}, 300_000);

afterAll(async () => {
  fake.restore();
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(() => vi.mocked(enqueue).mockClear());

describe("drafts", () => {
  it("creates, saves, validates and discards drafts, one open draft per user and asset", async () => {
    const reader = fakeReader(fake, policy).reader;
    const first = await createDraftFromAsset({ spaceId, assetId: AGENTS_MD }, author, { reader });
    expect(first.existing).toBe(false);
    expect((await createDraftFromAsset({ spaceId, assetId: AGENTS_MD }, author, { reader })).draftId).toBe(first.draftId);

    const [row] = await db().select().from(drafts).where(eq(drafts.id, first.draftId));
    expect(row).toMatchObject({ assetType: "agents_md", assetKey: "GENERIC", origin: "live", baseVersion: 5, status: "open", validation: [] });

    const saved = await updateDraft({ spaceId, draftId: first.draftId, expectedUpdatedAt: row!.updatedAt.toISOString(), files: [{ path: "AGENTS.md", content: `${row!.desired.files[0]!.content}\nAlways name the runbook.\n` }] }, author);
    expect(saved.validation).toEqual([]);
    await expect(updateDraft({ spaceId, draftId: first.draftId, expectedUpdatedAt: row!.updatedAt.toISOString(), metadata: {} }, author)).rejects.toMatchObject({ status: 409 });
    await expect(updateDraft({ spaceId, draftId: first.draftId, files: [] }, publisher)).rejects.toMatchObject({ status: 403 });

    // A managed memory: content can be edited too (the API writes it).
    const managed = await createDraftFromAsset({ spaceId, assetId: OVERVIEW }, author, { reader });
    const edited = await updateDraft({ spaceId, draftId: managed.draftId, files: [{ path: "overview.md", content: "rewritten" }] }, author);
    expect(edited.validation.map((r) => r.code)).not.toContain("managed.content");
    await discardDraft({ spaceId, draftId: managed.draftId }, author);

    const created = await createNewDraft({ spaceId, assetType: "memory_store", metadata: { name: "runbooks", description: "Runbooks", agent_types: ["GENERIC"] }, files: [{ path: "README.md", content: "# Runbooks\n" }] }, author);
    expect((await listDrafts(spaceId, { createdBy: author.email })).map((d) => d.id).sort()).toEqual([first.draftId, created.draftId].sort());
    expect(await listDrafts(spaceId, { createdBy: publisher.email })).toEqual([]);

    const editor = await loadDraftEditor(spaceId, first.draftId, author, { reader });
    expect(editor).toMatchObject({ canEdit: true, live: { ok: true, exists: true, version: 5, movedPastBase: false }, sizeMeter: { level: "ok" } });
    expect(editor!.diff!.added).toBe(2);
    expect(editor!.type).toMatchObject({ label: "Instructions (AGENTS.md)", mainFile: "AGENTS.md" });
    expect((await loadDraftList(spaceId, author, { mine: true })).length).toBe(2);
    expect(await auditActions()).toEqual(["draft.create", "draft.save", "draft.create", "draft.save", "draft.discard", "draft.create"]);
  });
});

describe("plans", () => {
  let planId: string;

  it("creates a plan from drafts, checks it against live, and shows it for review", async () => {
    await setSettings({ approvalRequired: true });
    const mine = await listDrafts(spaceId, { createdBy: author.email });
    const result = await createPlanFromDrafts({ spaceId, draftIds: mine.map((d) => d.id), title: "Runbook rules", reason: null }, author);
    planId = result.planId;
    expect(vi.mocked(enqueue).mock.calls[0]![1]).toEqual({ planId, rebase: false });
    expect((await listDrafts(spaceId, { createdBy: author.email })).every((d) => d.status === "planned" && d.planId === planId)).toBe(true);
    await expect(createPlanFromDrafts({ spaceId, draftIds: mine.map((d) => d.id) }, author)).rejects.toThrow(/already in a plan/);

    expect(await checkPlan(planId, result.checkRunId)).toMatchObject({ status: "checked", summary: { creates: 1, contentUpdates: 1, writes: 2 } });
    const review = await loadPlanReview(spaceId, planId, author);
    expect(review!.plan).toMatchObject({ state: "ready", badge: { label: "Ready" }, draftCount: 2, author: author.email });
    expect(review!.tiles).toMatchObject({ contentUpdates: 1, creates: 1, deletes: null, skipped: 0, validation: { passed: true } });
    expect(review!.items.map((i) => [i.name, i.changeBadge.label, i.versionLabel])).toEqual(
      expect.arrayContaining([
        ["Global instructions", "Update content", "v5 → v6"],
        ["runbooks", "Create", "new"],
      ]),
    );
    expect(review!.selected).toMatchObject({ mainFile: "README.md", sizeMeter: null });
    const mdItem = review!.items.find((i) => i.name === "Global instructions")!;
    const picked = await loadPlanReview(spaceId, planId, author, { selectedItemId: mdItem.id });
    expect(picked!.selected).toMatchObject({ id: mdItem.id, mainFile: "AGENTS.md", added: 2, sizeMeter: { level: "ok" }, writes: "Apply will replace AGENTS.md." });
    expect(picked!.items.filter((i) => i.selected).map((i) => i.id)).toEqual([mdItem.id]);
    expect(review!.actions.primary).toMatchObject({ action: "request-approval", enabled: true });
    expect(review!.approval).toMatchObject({ approvalRequired: true, reasonRequired: true, requested: null });
    expect(review!.confirm.title).toBe("Apply 2 changes to Customer Demo Space?");
    expect((await loadPlanList(spaceId)).map((p) => [p.title, p.state, p.items, p.writes])).toEqual([["Runbook rules", "ready", 2, 2]]);
  });

  it("needs a second person to approve, and a reason to apply", async () => {
    await requestApproval({ spaceId, planId }, author);
    await expect(approvePlan({ spaceId, planId }, authorPub)).rejects.toThrow("The plan author can't approve their own plan.");
    await expect(startApply({ spaceId, planId, reason: "x" }, publisher)).rejects.toThrow("Apply unlocks after approval.");
    await approvePlan({ spaceId, planId }, publisher);
    expect((await loadPlanReview(spaceId, planId, publisher))!.approval.approved).toMatchObject({ by: publisher.email, name: "Pat Publisher" });
    await expect(startApply({ spaceId, planId }, author)).rejects.toThrow("You need the Publisher role to apply.");
    await expect(startApply({ spaceId, planId, reason: "  " }, publisher)).rejects.toMatchObject({ fieldErrors: { reason: expect.any(String) } });
    const started = await startApply({ spaceId, planId, reason: "v2 audit" }, publisher);
    expect(started.writes).toBe(2);
    expect(vi.mocked(enqueue).mock.calls.at(-1)![1]).toEqual({ planId });
    const [p] = await db().select().from(plans).where(eq(plans.id, planId));
    expect(p).toMatchObject({ state: "applying", applyStartedBy: publisher.email, reason: "v2 audit", applyRunId: started.applyRunId });
  });

  it("applies, records each version in git as an app change with the plan and reason, and the next sync adds nothing", async () => {
    const [p] = await db().select().from(plans).where(eq(plans.id, planId));
    expect(await applyPlan(planId, p!.applyRunId!, publisher)).toMatchObject({ status: "applied", written: 2, failed: 0 });

    const items = await db().select().from(planItems).where(eq(planItems.planId, planId)).orderBy(asc(planItems.position));
    const md = items.find((i) => i.assetId === AGENTS_MD)!;
    const store = items.find((i) => i.assetType === "memory_store")!;
    expect(md).toMatchObject({ progress: "done", writtenVersion: 6, commit: expect.stringMatching(/^[0-9a-f]{40}$/) });

    const [last] = await repo.log({ path: MD_DIR, maxCount: 1 });
    expect(last!.hash).toBe(md.commit);
    expect(last!.trailers).toMatchObject({ "Asset-Id": AGENTS_MD, "Service-Version": "6", "Change-Source": "app", Principal: publisher.email, "Plan-Id": planId });
    expect(last).toMatchObject({ authorName: publisher.email, authorEmail: publisher.email });
    expect(last!.body).toContain('Applied by plan "Runbook rules"');
    expect(last!.body).toContain("Approved by Pat Publisher.");
    const note = await repo.note(md.commit!, policy.historyLayout.notesRef);
    expect(note).toContain("Reason: v2 audit");
    expect(note).toContain(`Reason-Id: ${md.id}`);
    expect(await repo.readFile(`${MD_DIR}/AGENTS.md`)).toContain("Always name the runbook.");
    expect(await repo.readFile("spaces/test-space/memory_store/runbooks/README.md")).toBe("# Runbooks\n");

    const changes = await db().select().from(assetChanges).where(and(eq(assetChanges.spaceId, spaceId), eq(assetChanges.planId, planId)));
    expect(changes.map((c) => [c.assetId, c.serviceVersion, c.changeSource, c.principal, c.attributionMatchedBy]).sort()).toEqual(
      [
        [AGENTS_MD, 6, "app", publisher.email, "clientToken"],
        [store.assetId, 1, "app", publisher.email, "clientToken"],
      ].sort(),
    );
    expect(await db().select().from(assetReasons).where(eq(assetReasons.id, md.id))).toHaveLength(1);
    expect(await findPlanItemByClientToken(md.id)).toEqual({ planId, appUser: publisher.email });
    expect(await findPlanItemByClientToken(`${md.id}-1`)).toEqual({ planId, appUser: publisher.email });
    expect(await findPlanItemByClientToken("7c1761ca-b256-4f44-a4a9-2865380f0f8d")).toBeNull();

    const head = await repo.head();
    const again = await syncSpace(spaceId, { actor: { email: "system:test" }, client, now: () => new Date("2026-11-12T12:00:00.000Z") });
    expect(again).toMatchObject({ commits: 0, changes: 0 });
    expect(await repo.head()).toBe(head);

    expect((await db().select().from(plans).where(eq(plans.id, planId)))[0]).toMatchObject({ state: "applied", resultCommit: head });
    expect((await db().select().from(applyRuns).where(eq(applyRuns.planId, planId)))[0]).toMatchObject({ status: "succeeded", finalCommit: head, pushed: false });
    expect((await db().select().from(drafts).where(eq(drafts.planId, planId))).map((d) => d.status)).toEqual(["applied", "applied"]);
    const review = await loadPlanReview(spaceId, planId, publisher);
    expect(review!.callouts.map((c) => c.kind)).toEqual(["applied"]);
    expect(review!.actions.primary).toBeNull();
    expect((await auditActions()).slice(6)).toEqual(["plan.create", "plan.approval.request", "plan.approve", "plan.apply.start", "plan.apply.finish"]);
  });

  it("returns a rejected plan to its author, and discarding keeps its drafts", async () => {
    const reader = fakeReader(fake, policy).reader;
    const d = await createDraftFromAsset({ spaceId, assetId: OVERVIEW }, author, { reader });
    await updateDraft({ spaceId, draftId: d.draftId, metadata: { ...(await listDrafts(spaceId, { createdBy: author.email }))[0]!.desired.metadata, status: "INACTIVE" } }, author);
    const { planId: id, checkRunId } = await createPlanFromDrafts({ spaceId, draftIds: [d.draftId] }, author);
    await checkPlan(id, checkRunId);
    const review = await loadPlanReview(spaceId, id, author);
    expect(review!.items[0]).toMatchObject({ changeBadge: { label: "Set Inactive" }, versionLabel: "v24, status only" });
    await requestApproval({ spaceId, planId: id }, author);
    await expect(rejectPlan({ spaceId, planId: id, note: "" }, publisher)).rejects.toMatchObject({ fieldErrors: { note: expect.any(String) } });
    await rejectPlan({ spaceId, planId: id, note: "Not during the freeze." }, publisher);
    expect((await loadPlanReview(spaceId, id, author))!.approval.rejected).toMatchObject({ by: publisher.email, note: "Not during the freeze." });
    await discardPlan({ spaceId, planId: id }, author);
    expect((await db().select().from(drafts).where(eq(drafts.id, d.draftId)))[0]).toMatchObject({ status: "open", planId: null });
    expect((await auditActions()).slice(-6)).toEqual(["draft.create", "draft.save", "plan.create", "plan.approval.request", "plan.reject", "plan.discard"]);
  });

  it("createPlan (the contract other modules call) refuses deletes unless the space allows them", async () => {
    await expect(createPlan({ spaceId, title: "Delete", origin: { kind: "package", importId: "i", fileName: "p.zip" }, items: [], deletes: [{ assetId: AGENTS_MD }] }, author)).rejects.toThrow(/Deletes are off/);
    await setSettings({ deletesEnabled: true });
    const r = await createPlan({ spaceId, title: "Delete", origin: { kind: "package", importId: "i", fileName: "p.zip" }, items: [], deletes: [{ assetId: AGENTS_MD }], notes: ["Kept as it is: verity (unchanged since the release)"] }, author);
    expect((await loadPlanReview(spaceId, r.planId, author))!.plan.notes).toEqual(["Kept as it is: verity (unchanged since the release)"]);
    expect((await db().select().from(planItems).where(eq(planItems.planId, r.planId)))[0]).toMatchObject({ kind: "delete", assetId: AGENTS_MD, assetType: "agents_md" });
  });
});
