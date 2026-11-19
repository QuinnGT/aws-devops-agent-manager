import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useTempDataDir } from "@/server/assets/test-support/history-fixture";
import { db } from "@/server/db/client";
import { agentSpaces, assetIndex, auditEvents, auditItems, audits, findings, historyRepos, plans, reviews, revisionChanges, revisions } from "@/server/db/schema";
import { HistoryRepo, type HistoryRepoConfig } from "@/server/git/history-repo";
import { enqueue } from "@/server/jobs/enqueue";
import { testJobContext } from "@/server/jobs/registry";
import { notifyPlanApplied } from "@/server/plans";
import { getAppPolicy } from "@/server/policy";
import { createReleaseHandler } from "@/server/releases/create";
import { commitVersion, type TestAsset } from "@/server/releases/test-support";
import { getSpaceById, type Space } from "@/server/spaces/queries";
import { truncateAll } from "../../../test/helpers/db";
import { createRevisionHandler } from "./create";
import { addFindingsToRevision, createRevisionForFindings, findingRevisionLinks, listRevisionOptions, removeFindingFromRevision } from "./findings";
import "./jobs";
import { loadRevisionDetail, loadRevisionList } from "./loaders";
import { saveRevisionHandler, type SaveRevisionInput } from "./save";
import { abandonRevision, createPlanFromRevision, requestSaveRevision } from "./service";
import { GLOBAL_MD, PACKAGE_FILES } from "./test-support";
import { loadRevisionPage, loadSaveFindings } from "./views";

// Jobs run directly in this test; nothing is sent to pg-boss.
vi.mock("@/server/jobs/enqueue", () => ({ enqueue: vi.fn(async () => crypto.randomUUID()) }));

const policy = getAppPolicy().policy;
const layout = policy.historyLayout;
const ALIAS = "find-space";
const alex = { email: "alex@example.com", name: "Alex" };
const syncMock = vi.fn(async (spaceId: string) => ({ spaceId, mode: "reconcile", status: "succeeded", listed: 0, changedAssets: 0, changes: 0, commits: 0, deferred: 0, deleted: 0, attributionFailed: false, pushed: false }) as never);
const id = (n: number) => `ki-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (d: number) => `2026-10-0${d}T01:00:00.000Z`;

const ASSETS: TestAsset[] = [
  { assetId: id(1), assetType: "agents_md", metadata: { agent_type: "GENERIC", status: "ACTIVE" }, version: 1, updatedAt: at(1), files: { "AGENTS.md": GLOBAL_MD } },
  { assetId: id(2), assetType: "agents_md", metadata: { agent_type: "INCIDENT_TRIAGE", status: "ACTIVE" }, version: 1, updatedAt: at(2), files: { "AGENTS.md": PACKAGE_FILES["instructions/incident-triage.md"]! } },
  {
    assetId: id(3),
    assetType: "skill",
    metadata: { name: "triage", description: "Triage steps", agent_types: ["INCIDENT_TRIAGE", "INCIDENT_RCA"], status: "ACTIVE", skill_type: "USER" },
    version: 1,
    updatedAt: at(3),
    files: { "SKILL.md": PACKAGE_FILES["skills/triage/SKILL.md"]! },
  },
  { assetId: id(4), assetType: "memory_store", metadata: { name: "runbooks", description: "Runbooks", agent_types: ["INCIDENT_TRIAGE", "INCIDENT_RCA"], status: "ACTIVE" }, version: 1, updatedAt: at(4), files: { "runbooks.md": "# Runbooks\n" } },
  {
    assetId: id(5),
    assetType: "memory",
    metadata: { name: "failover", description: "Database failover", memory_store_id: id(4), status: "ACTIVE" },
    version: 1,
    updatedAt: at(5),
    files: { "failover.md": PACKAGE_FILES["memory/runbooks/failover.md"]! },
    storeName: "runbooks",
  },
];

let tmp: Awaited<ReturnType<typeof useTempDataDir>>;
let repo: HistoryRepo;
let space: Space;
let otherSpace: Space;
const ctx = () => testJobContext({ actor: { email: alex.email }, spaceId: space.id });

type Seeded = { id: string; auditId: string; itemId: string };
const F = {} as Record<"fixA" | "fixB" | "fixC" | "fixD" | "diag" | "proposed" | "rejected" | "caseReview" | "otherSpace" | "superseded", Seeded>;
const AUDIT: { late: string; nov: string } = { late: "", nov: "" };

async function seedAudit(spaceId: string, name: string, profileId: "benchmark" | "before-after" = "benchmark"): Promise<string> {
  const [audit] = await db()
    .insert(audits)
    .values({ spaceId, name, profileId, profileSnapshot: policy.audits.profiles[profileId]!, policyDigest: "test", state: "reviewing", createdBy: alex.email })
    .returning();
  return audit!.id;
}

async function seedFinding(spaceId: string, auditId: string, o: { state: "accepted" | "proposed" | "rejected"; kind: string; title: string; incidentId: string; owner?: string }): Promise<Seeded> {
  const [item] = await db().insert(auditItems).values({ auditId, spaceId, taskId: `task-${o.incidentId}-${o.kind}-${o.state}`, incidentId: o.incidentId, state: "reviewed" }).returning();
  const [review] = await db().insert(reviews).values({ auditId, auditItemId: item!.id, spaceId, runner: "ai-sdk", modelId: "mock", promptDigest: "d", state: "succeeded", startedBy: alex.email }).returning();
  await db().update(auditItems).set({ currentReviewId: review!.id }).where(eq(auditItems.id, item!.id));
  const values = o.kind === "fix" ? { owner: o.owner ?? "instructions", fix: o.title } : { one_line: o.title };
  const [f] = await db()
    .insert(findings)
    .values({
      auditId,
      auditItemId: item!.id,
      reviewId: review!.id,
      spaceId,
      incidentId: o.incidentId,
      kind: o.kind,
      ordinal: 0,
      title: o.title,
      proposed: values,
      current: values,
      citations: [{ record: 12, quote: "root cause: monitor precedent", field: "fixes[0].evidence[0]", ok: true }],
      state: o.state,
      reviewedBy: o.state === "accepted" ? alex.email : null,
      reviewedAt: o.state === "accepted" ? new Date() : null,
    })
    .returning();
  return { id: f!.id, auditId, itemId: item!.id };
}

/** The item is reviewed again: its current review is a new one, so the finding belongs to an earlier review. */
async function supersede(f: Seeded): Promise<void> {
  const [review] = await db().insert(reviews).values({ auditId: f.auditId, auditItemId: f.itemId, spaceId: space.id, runner: "ai-sdk", modelId: "mock", promptDigest: "d2", state: "succeeded", startedBy: alex.email }).returning();
  await db().update(auditItems).set({ currentReviewId: review!.id }).where(eq(auditItems.id, f.itemId));
}

const setState = (f: Seeded, state: "accepted" | "proposed" | "rejected") => db().update(findings).set({ state }).where(eq(findings.id, f.id));

async function row(revisionId: string) {
  const [r] = await db().select().from(revisions).where(eq(revisions.id, revisionId));
  return r!;
}

async function events(action: string) {
  return db().select({ action: auditEvents.action, actor: auditEvents.actorEmail, targetId: auditEvents.targetId, details: auditEvents.details }).from(auditEvents).where(eq(auditEvents.action, action)).orderBy(asc(auditEvents.id));
}

async function runSave(revisionId: string, request: Parameters<typeof requestSaveRevision>[2]) {
  vi.mocked(enqueue).mockClear();
  await requestSaveRevision(space, revisionId, request, alex);
  return saveRevisionHandler(vi.mocked(enqueue).mock.calls[0]![1] as SaveRevisionInput, ctx());
}

beforeAll(async () => {
  await truncateAll();
  tmp = await useTempDataDir();
  const cfg: HistoryRepoConfig = { id: "00000000-0000-4000-8000-0000000000f3", name: "find-space-history", remoteUrl: null, deployKeyFile: null, defaultBranch: "main", pushEnabled: false };
  repo = await HistoryRepo.open(cfg);
  const gitPaths = new Map<string, string>();
  for (const a of ASSETS) gitPaths.set(a.assetId, (await commitVersion(repo, layout, ALIAS, a)).gitPath);
  const [repoRow] = await db().insert(historyRepos).values({ name: cfg.name }).returning();
  const [spaceRow] = await db().insert(agentSpaces).values({ alias: ALIAS, region: "us-west-2", accountId: "111122223333", agentSpaceId: "space-find", historyRepoId: repoRow!.id }).returning();
  const [otherRow] = await db().insert(agentSpaces).values({ alias: "find-other", region: "us-west-2", accountId: "111122223333", agentSpaceId: "space-find-other" }).returning();
  space = (await getSpaceById(spaceRow!.id))!;
  otherSpace = (await getSpaceById(otherRow!.id))!;
  for (const a of ASSETS) {
    await db()
      .insert(assetIndex)
      .values({
        spaceId: space.id,
        assetId: a.assetId,
        assetType: a.assetType,
        name: String(a.metadata.name ?? a.metadata.agent_type),
        parentAssetId: typeof a.metadata.memory_store_id === "string" ? a.metadata.memory_store_id : null,
        liveVersion: a.version,
        liveUpdatedAt: new Date(a.updatedAt),
        lastSyncedVersion: a.version,
        gitPath: gitPaths.get(a.assetId)!,
        metadata: a.metadata,
      });
  }

  AUDIT.late = await seedAudit(space.id, "Late October low scores");
  AUDIT.nov = await seedAudit(space.id, "November follow-up");
  const compare = await seedAudit(space.id, "Before and after v2", "before-after");
  const otherAudit = await seedAudit(otherSpace.id, "Other space audit");
  F.fixA = await seedFinding(space.id, AUDIT.late, { state: "accepted", kind: "fix", title: "Record precedents only as hypotheses", incidentId: "INCIDENT-31495" });
  F.diag = await seedFinding(space.id, AUDIT.late, { state: "accepted", kind: "diagnosis", title: "INCIDENT-31499: kept a resolved gap open", incidentId: "INCIDENT-31499" });
  F.fixB = await seedFinding(space.id, AUDIT.late, { state: "accepted", kind: "fix", title: "Add a seat-map service-map entry", incidentId: "INCIDENT-32336" });
  F.fixC = await seedFinding(space.id, AUDIT.nov, { state: "accepted", kind: "fix", title: "Check onset before the deploy log", incidentId: "INCIDENT-33001" });
  F.fixD = await seedFinding(space.id, AUDIT.nov, { state: "accepted", kind: "fix", title: "Add a rollback step to the triage skill", incidentId: "INCIDENT-33003" });
  F.proposed = await seedFinding(space.id, AUDIT.late, { state: "proposed", kind: "fix", title: "Not reviewed yet", incidentId: "INCIDENT-31500" });
  F.rejected = await seedFinding(space.id, AUDIT.late, { state: "rejected", kind: "fix", title: "Rejected on review", incidentId: "INCIDENT-31501" });
  F.caseReview = await seedFinding(space.id, compare, { state: "accepted", kind: "case", title: "INCIDENT-31502 (v2): improved", incidentId: "INCIDENT-31502" });
  F.otherSpace = await seedFinding(otherSpace.id, otherAudit, { state: "accepted", kind: "fix", title: "Another space's finding", incidentId: "INCIDENT-1" });
  F.superseded = await seedFinding(space.id, AUDIT.nov, { state: "accepted", kind: "fix", title: "Fix from an earlier review", incidentId: "INCIDENT-33002" });
  await supersede(F.superseded);
});

beforeEach(() => vi.mocked(enqueue).mockClear());

afterAll(async () => {
  await tmp.cleanup();
});

let fix1 = "";
let fix2 = "";

describe("creating a revision for findings", () => {
  it("refuses findings that are not accepted, not linkable or of another space, and queues nothing", async () => {
    const name = (n: string) => ({ name: n, findingIds: [F.fixA.id] });
    await expect(createRevisionForFindings(space, { ...name("fix-1"), findingIds: [F.proposed.id] }, alex)).rejects.toMatchObject({ code: "finding-not-linkable", message: "That finding can't go to a revision: it isn't accepted." });
    await expect(createRevisionForFindings(space, { ...name("fix-1"), findingIds: [F.rejected.id] }, alex)).rejects.toMatchObject({ code: "finding-not-linkable", message: "That finding can't go to a revision: it isn't accepted." });
    await expect(createRevisionForFindings(space, { ...name("fix-1"), findingIds: [F.otherSpace.id] }, alex)).rejects.toMatchObject({ code: "finding-not-linkable", message: "That finding can't go to a revision: it isn't a finding of this space." });
    await expect(createRevisionForFindings(space, { ...name("fix-1"), findingIds: [crypto.randomUUID()] }, alex)).rejects.toMatchObject({ code: "finding-not-linkable" });
    // Accepted, but its extractor ("case" in the before-after profile) is not linkable.
    await expect(createRevisionForFindings(space, { ...name("fix-1"), findingIds: [F.caseReview.id] }, alex)).rejects.toMatchObject({ code: "finding-not-linkable", message: "That finding can't go to a revision: its kind of finding can't be linked to a revision." });
    await expect(createRevisionForFindings(space, { ...name("fix-1"), findingIds: [F.fixA.id, F.proposed.id, F.rejected.id] }, alex)).rejects.toMatchObject({ code: "finding-not-linkable", fieldErrors: { findingIds: expect.any(String) }, message: expect.stringContaining("2 of the findings") });
    await expect(createRevisionForFindings(space, { ...name("fix-1"), findingIds: [] }, alex)).rejects.toMatchObject({ code: "bad-request" });
    await expect(createRevisionForFindings(space, { ...name("fix-1"), findingIds: ["not-an-id"] }, alex)).rejects.toMatchObject({ code: "bad-request" });
    // The name rules of a new revision apply.
    await expect(createRevisionForFindings(space, name("bad name"), alex)).rejects.toMatchObject({ code: "name-invalid" });
    expect(vi.mocked(enqueue)).not.toHaveBeenCalled();
    expect(await db().select().from(revisions)).toEqual([]);
    expect(await events("revision.create-for-findings")).toEqual([]);
  });

  it("creates a revision from the live space with the findings on its to-address list", async () => {
    const created = await createRevisionForFindings(space, { name: "fix-1", findingIds: [F.fixA.id, F.diag.id, F.fixA.id], note: "From the late October audit" }, alex);
    fix1 = created.revisionId;
    expect(created.branch).toBe("revision/find-space/fix-1");
    expect(vi.mocked(enqueue).mock.calls).toHaveLength(1);
    expect(vi.mocked(enqueue).mock.calls[0]![1]).toEqual({ revisionId: fix1 });
    expect(await row(fix1)).toMatchObject({ state: "creating", baseKind: "live", baseRef: "HEAD", note: "From the late October audit", toAddressFindingIds: [F.fixA.id, F.diag.id], createdBy: alex.email, createRunId: created.runId });
    expect(await events("revision.create-for-findings")).toEqual([{ action: "revision.create-for-findings", actor: alex.email, targetId: fix1, details: { name: "fix-1", branch: created.branch, findingIds: [F.fixA.id, F.diag.id], runId: created.runId } }]);

    // A revision that exists keeps its name, and the findings are not added a second time.
    await expect(createRevisionForFindings(space, { name: "FIX-1", findingIds: [F.fixB.id] }, alex)).rejects.toMatchObject({ code: "name-taken" });
    expect((await row(fix1)).toAddressFindingIds).toEqual([F.fixA.id, F.diag.id]);

    // While the create job runs, the revision already takes findings and is offered.
    expect(await listRevisionOptions(space)).toEqual([{ id: fix1, name: "fix-1", state: "creating", packageName: "fix-1", toAddress: 2, linked: 0, updatedAt: expect.any(Date) }]);
    const result = await createRevisionHandler({ revisionId: fix1 }, ctx(), { sync: syncMock });
    expect(result).toMatchObject({ revisionId: fix1, resumed: false });
    expect(await row(fix1)).toMatchObject({ state: "open", toAddressFindingIds: [F.fixA.id, F.diag.id] });
  });
});

describe("adding findings to a revision", () => {
  it("adds accepted findings once and counts the ones already there", async () => {
    expect(await addFindingsToRevision(space, { revisionId: fix1, findingIds: [F.fixB.id, F.fixA.id, F.diag.id, F.fixB.id] }, alex)).toEqual({ revisionId: fix1, added: 1, alreadyThere: 2 });
    expect((await row(fix1)).toAddressFindingIds).toEqual([F.fixA.id, F.diag.id, F.fixB.id]);
    expect(await events("revision.findings.add")).toEqual([{ action: "revision.findings.add", actor: alex.email, targetId: fix1, details: { name: "fix-1", findingIds: [F.fixB.id], added: 1, alreadyThere: 2 } }]);

    // Nothing new: nothing changes and nothing is recorded.
    const before = await row(fix1);
    expect(await addFindingsToRevision(space, { revisionId: fix1, findingIds: [F.fixA.id, F.fixB.id] }, alex)).toEqual({ revisionId: fix1, added: 0, alreadyThere: 2 });
    expect(await row(fix1)).toMatchObject({ toAddressFindingIds: before.toAddressFindingIds, updatedAt: before.updatedAt });
    expect(await events("revision.findings.add")).toHaveLength(1);

    // A finding whose item was reviewed again keeps its accepted decision and can be added.
    expect(await addFindingsToRevision(space, { revisionId: fix1, findingIds: [F.superseded.id] }, alex)).toMatchObject({ added: 1, alreadyThere: 0 });
    await removeFindingFromRevision(space, { revisionId: fix1, findingId: F.superseded.id }, alex);
  });

  it("refuses findings that are not accepted, not linkable or of another space, and changes nothing", async () => {
    const before = (await row(fix1)).toAddressFindingIds;
    const add = (findingIds: string[]) => addFindingsToRevision(space, { revisionId: fix1, findingIds }, alex);
    await expect(add([F.proposed.id])).rejects.toMatchObject({ code: "finding-not-linkable", message: "That finding can't go to a revision: it isn't accepted." });
    await expect(add([F.rejected.id])).rejects.toMatchObject({ code: "finding-not-linkable" });
    await expect(add([F.caseReview.id])).rejects.toMatchObject({ code: "finding-not-linkable", message: expect.stringContaining("its kind of finding") });
    await expect(add([F.otherSpace.id])).rejects.toMatchObject({ code: "finding-not-linkable", message: expect.stringContaining("isn't a finding of this space") });
    // One refused finding refuses the whole request.
    await expect(add([F.fixC.id, F.proposed.id])).rejects.toMatchObject({ code: "finding-not-linkable" });
    await expect(add([])).rejects.toMatchObject({ code: "bad-request" });
    await expect(addFindingsToRevision(space, { revisionId: "nope", findingIds: [F.fixC.id] }, alex)).rejects.toMatchObject({ code: "bad-request" });
    await expect(addFindingsToRevision(space, { revisionId: crypto.randomUUID(), findingIds: [F.fixC.id] }, alex)).rejects.toMatchObject({ code: "not-found" });
    // A revision of another space is not reachable with this space.
    await expect(addFindingsToRevision(otherSpace, { revisionId: fix1, findingIds: [F.otherSpace.id] }, alex)).rejects.toMatchObject({ code: "not-found" });
    expect((await row(fix1)).toAddressFindingIds).toEqual(before);
  });

  it("refuses a revision that is abandoned, applied or failed", async () => {
    const other = await createRevisionForFindings(space, { name: "fix-2", findingIds: [F.fixC.id] }, alex);
    fix2 = other.revisionId;
    await createRevisionHandler({ revisionId: fix2 }, ctx(), { sync: syncMock });
    await abandonRevision(space, fix2, alex);
    await expect(addFindingsToRevision(space, { revisionId: fix2, findingIds: [F.fixB.id] }, alex)).rejects.toMatchObject({ code: "not-open", message: "The revision is abandoned, so its to-address list can't change." });
    await expect(removeFindingFromRevision(space, { revisionId: fix2, findingId: F.fixC.id }, alex)).rejects.toMatchObject({ code: "not-open" });
    for (const state of ["applied", "failed"] as const) {
      await db().update(revisions).set({ state }).where(eq(revisions.id, fix2));
      await expect(addFindingsToRevision(space, { revisionId: fix2, findingIds: [F.fixB.id] }, alex)).rejects.toMatchObject({ code: "not-open" });
    }
    await db().update(revisions).set({ state: "abandoned" }).where(eq(revisions.id, fix2));
    expect((await row(fix2)).toAddressFindingIds).toEqual([F.fixC.id]);
    // Only revisions that take findings are offered.
    expect((await listRevisionOptions(space)).map((o) => o.name)).toEqual(["fix-1"]);
    expect(await listRevisionOptions(otherSpace)).toEqual([]);
  });
});

describe("saving a revision that links findings", () => {
  it("takes the linked findings off the to-address list with the save, and leaves the others", async () => {
    const r = await row(fix1);
    const result = await runSave(fix1, { message: "Record precedents only as hypotheses", edits: [{ path: "instructions/global.md", content: `${GLOBAL_MD}\nRecord precedents only as hypotheses.\n` }], findingIds: [F.fixA.id], expectedHead: r.headCommit });
    expect(result).toMatchObject({ build: "passed", resumed: false });
    const after = await row(fix1);
    // The change and the list change together.
    expect(after).toMatchObject({ headCommit: result.commit, toAddressFindingIds: [F.diag.id, F.fixB.id] });
    expect((await db().select().from(revisionChanges).where(eq(revisionChanges.revisionId, fix1))).map((c) => c.findingIds)).toEqual([[F.fixA.id]]);
    expect(await listRevisionOptions(space)).toMatchObject([{ name: "fix-1", toAddress: 2, linked: 1 }]);

    // A finding that is linked is counted, not added again.
    expect(await addFindingsToRevision(space, { revisionId: fix1, findingIds: [F.fixA.id, F.fixC.id] }, alex)).toEqual({ revisionId: fix1, added: 1, alreadyThere: 1 });
    expect((await row(fix1)).toAddressFindingIds).toEqual([F.diag.id, F.fixB.id, F.fixC.id]);

    // A save that links a finding that is not on the list leaves the list alone.
    const other = await runSave(fix1, { message: "Check onset first", edits: [{ path: "instructions/incident-triage.md", content: "# Triage\n\nTriage rules.\nCheck onset first.\n" }], findingIds: [], unlinkedReason: "The triage steps need an order." });
    expect(other.build).toBe("passed");
    expect((await row(fix1)).toAddressFindingIds).toEqual([F.diag.id, F.fixB.id, F.fixC.id]);

    // A retried job finds its own save and changes nothing more.
    const input = vi.mocked(enqueue).mock.calls[0]![1] as SaveRevisionInput;
    expect(await saveRevisionHandler(input, ctx())).toMatchObject({ resumed: true });
    expect((await row(fix1)).toAddressFindingIds).toEqual([F.diag.id, F.fixB.id, F.fixC.id]);
  });

  it("links two findings in one save and takes both off", async () => {
    await runSave(fix1, { message: "Seat-map entry and onset check", edits: [{ path: "instructions/incident-triage.md", content: "# Triage\n\nTriage rules.\nCheck onset first.\nSee the seat-map service map.\n" }], findingIds: [F.fixB.id, F.fixC.id] });
    expect((await row(fix1)).toAddressFindingIds).toEqual([F.diag.id]);
    expect(await listRevisionOptions(space)).toMatchObject([{ name: "fix-1", toAddress: 1, linked: 3 }]);
    // Put them back for the next checks.
    await db().update(revisions).set({ toAddressFindingIds: [F.diag.id] }).where(eq(revisions.id, fix1));
  });
});

describe("where a finding went", () => {
  it("lists the revisions of each finding, newest first, with linked findings told apart from to-address ones", async () => {
    const links = await findingRevisionLinks(space.id, [F.fixA.id, F.diag.id, F.fixC.id, F.proposed.id, crypto.randomUUID(), "not-an-id"]);
    const base = { revisionId: fix1, revisionName: "fix-1", revisionState: "open", planId: null, planState: null, releaseName: null };
    expect(links.get(F.fixA.id)).toEqual([{ ...base, kind: "linked" }]);
    expect(links.get(F.diag.id)).toEqual([{ ...base, kind: "to-address" }]);
    // A finding linked in one revision and sent to another shows in both, the most recently updated revision first.
    expect(links.get(F.fixC.id)).toEqual([
      { ...base, kind: "linked" },
      { ...base, revisionId: fix2, revisionName: "fix-2", revisionState: "abandoned", kind: "to-address" },
    ]);
    expect(links.get(F.proposed.id)).toEqual([]);
    expect([...links.keys()]).toHaveLength(6);
    expect([...links.values()].filter((v) => v.length === 0)).toHaveLength(3);
    // Another space's findings and revisions are never mixed in.
    expect((await findingRevisionLinks(otherSpace.id, [F.fixA.id])).get(F.fixA.id)).toEqual([]);
    expect(await findingRevisionLinks(space.id, [])).toEqual(new Map());
  });

  it("follows the revision's plan and its release", async () => {
    const plan = await createPlanFromRevision(space, fix1, alex);
    expect((await findingRevisionLinks(space.id, [F.diag.id])).get(F.diag.id)).toEqual([expect.objectContaining({ revisionId: fix1, planId: plan.planId, planState: "checking", releaseName: null })]);

    // Simulated apply: a commit on the default branch, then the plan ends "applied" and the revision's release is tagged.
    const applied = await commitVersion(repo, layout, ALIAS, { ...ASSETS[0]!, version: 2, updatedAt: "2026-11-13T01:00:00.000Z", files: { "AGENTS.md": "applied\n" } }, ASSETS[0]);
    await db().update(plans).set({ state: "applied", resultCommit: applied.commit, applyStartedBy: alex.email, finishedAt: new Date() }).where(eq(plans.id, plan.planId));
    vi.mocked(enqueue).mockClear();
    await notifyPlanApplied({ planId: plan.planId, spaceId: space.id, actor: { email: alex.email }, log: () => {} });
    // The release is requested but not made yet: no page to link to.
    expect((await findingRevisionLinks(space.id, [F.diag.id])).get(F.diag.id)).toEqual([expect.objectContaining({ revisionState: "applied", planState: "applied", releaseName: null })]);
    const call = vi.mocked(enqueue).mock.calls.find((c) => c[0].name === "releases.create")!;
    await createReleaseHandler(call[1] as never, testJobContext({ actor: { email: alex.email }, spaceId: space.id }));
    expect((await findingRevisionLinks(space.id, [F.diag.id])).get(F.diag.id)).toEqual([expect.objectContaining({ revisionState: "applied", planState: "applied", releaseName: "fix-1" })]);
    // An applied revision no longer takes findings.
    await expect(addFindingsToRevision(space, { revisionId: fix1, findingIds: [F.fixB.id] }, alex)).rejects.toMatchObject({ code: "not-open" });
    expect(await listRevisionOptions(space)).toEqual([]);
    // Back to open for the checks that follow.
    await db().update(revisions).set({ state: "open" }).where(eq(revisions.id, fix1));
  });
});

describe("a finding reopened or rejected on its audit", () => {
  it("stays on the list, is not counted and can't be linked until it is accepted again", async () => {
    await setState(F.diag, "proposed");
    expect(await listRevisionOptions(space)).toMatchObject([{ name: "fix-1", toAddress: 0 }]);
    expect((await loadRevisionList(space)).revisions.find((r) => r.name === "fix-1")!.toAddress).toBe(0);
    expect((await row(fix1)).toAddressFindingIds).toEqual([F.diag.id]);
    await expect(requestSaveRevision(space, fix1, { message: "x", edits: [{ path: "README.md", content: "x" }], findingIds: [F.diag.id] }, alex)).rejects.toMatchObject({ code: "finding-not-linkable" });
    // It can't be added again either, but it is on the list, so the refusal comes first.
    await expect(addFindingsToRevision(space, { revisionId: fix1, findingIds: [F.diag.id] }, alex)).rejects.toMatchObject({ code: "finding-not-linkable", message: "That finding can't go to a revision: it isn't accepted." });

    const page = (await loadRevisionPage(space, "fix-1"))!;
    expect(page.toAddress).toEqual([expect.objectContaining({ id: F.diag.id, accepted: false, state: "proposed", notAcceptedReason: expect.stringContaining("Reopened on its audit") })]);
    // The save dialog offers nothing to tick for it.
    expect((await loadSaveFindings(space, [], { toAddress: [F.diag.id] })).find((f) => f.id === F.diag.id)).toBeUndefined();

    await setState(F.diag, "rejected");
    expect((await loadRevisionPage(space, "fix-1"))!.toAddress[0]).toMatchObject({ accepted: false, state: "rejected", notAcceptedReason: expect.stringContaining("Rejected on its audit") });

    // Accepted again: it counts again and nothing was lost.
    await setState(F.diag, "accepted");
    expect(await listRevisionOptions(space)).toMatchObject([{ name: "fix-1", toAddress: 1 }]);
    expect((await loadRevisionPage(space, "fix-1"))!.toAddress[0]).toMatchObject({ accepted: true, notAcceptedReason: null });
  });

  it("can be removed by a person, once, and the removal is recorded", async () => {
    await setState(F.diag, "proposed");
    expect(await removeFindingFromRevision(space, { revisionId: fix1, findingId: F.diag.id }, alex)).toEqual({ revisionId: fix1, removed: true });
    expect((await row(fix1)).toAddressFindingIds).toEqual([]);
    expect(await removeFindingFromRevision(space, { revisionId: fix1, findingId: F.diag.id }, alex)).toEqual({ revisionId: fix1, removed: false });
    // One event per removal that changed the list (the earlier test removed the finding from an earlier review).
    expect((await events("revision.findings.remove")).map((e) => e.details)).toEqual([
      { name: "fix-1", findingId: F.superseded.id },
      { name: "fix-1", findingId: F.diag.id },
    ]);
    expect((await events("revision.findings.remove")).at(-1)).toMatchObject({ action: "revision.findings.remove", actor: alex.email, targetId: fix1 });
    await expect(removeFindingFromRevision(otherSpace, { revisionId: fix1, findingId: F.diag.id }, alex)).rejects.toMatchObject({ code: "not-found" });
    await expect(removeFindingFromRevision(space, { revisionId: fix1, findingId: "nope" }, alex)).rejects.toMatchObject({ code: "bad-request" });
    await setState(F.diag, "accepted");
  });
});

describe("page loaders", () => {
  it("lists the to-address count and offers the to-address findings first in the save dialog", async () => {
    await addFindingsToRevision(space, { revisionId: fix1, findingIds: [F.superseded.id, F.diag.id, F.fixD.id] }, alex);
    const list = await loadRevisionList(space);
    expect(list.revisions.find((r) => r.name === "fix-1")).toMatchObject({ toAddress: 3, linkedFindings: 3 });
    expect(list.revisions.find((r) => r.name === "fix-2")).toMatchObject({ toAddress: 1, state: "abandoned" });
    expect((await loadRevisionList(otherSpace)).revisions).toEqual([]);

    const detail = (await loadRevisionDetail(space, "fix-1"))!;
    expect(detail.revision).toMatchObject({ toAddress: 3, toAddressIds: [F.superseded.id, F.diag.id, F.fixD.id] });

    const offered = await loadSaveFindings(space, [F.fixA.id], { toAddress: [F.superseded.id, F.diag.id, F.fixD.id, F.proposed.id] });
    // The to-address findings come first in the order they were added (the one from an earlier review included), the rest follow.
    expect(offered.slice(0, 3).map((f) => [f.id, f.toAddress])).toEqual([[F.superseded.id, true], [F.diag.id, true], [F.fixD.id, true]]);
    expect(offered.slice(3).every((f) => !f.toAddress)).toBe(true);
    // A finding that isn't accepted is not offered even when it is named.
    expect(offered.map((f) => f.id)).not.toContain(F.proposed.id);
    expect(offered.find((f) => f.id === F.superseded.id)).toMatchObject({ owner: "Instruction and skill package", ownerLabel: "Owner", kindLabel: "Fix", auditName: "November follow-up" });
    expect(new Set(offered.map((f) => f.id)).size).toBe(offered.length);
    // Without the option nothing is marked.
    expect((await loadSaveFindings(space)).every((f) => !f.toAddress)).toBe(true);
  });

  it("gives the to-address card its labels and links, and names the audits the findings come from", async () => {
    const page = (await loadRevisionPage(space, "fix-1"))!;
    const base = `/spaces/${ALIAS}/audits`;
    expect(page.toAddress.map((f) => f.id)).toEqual([F.superseded.id, F.diag.id, F.fixD.id]);
    expect(page.toAddress[0]).toEqual({
      id: F.superseded.id,
      title: "Fix from an earlier review",
      incidentId: "INCIDENT-33002",
      kind: "fix",
      kindLabel: "Fix",
      owner: "Instruction and skill package",
      ownerLabel: "Owner",
      auditId: AUDIT.nov,
      auditName: "November follow-up",
      auditHref: `${base}/${AUDIT.nov}`,
      href: `${base}/${AUDIT.nov}/findings?finding=${F.superseded.id}`,
      state: "accepted",
      accepted: true,
      notAcceptedReason: null,
    });
    // A diagnosis has no owner.
    expect(page.toAddress[1]).toMatchObject({ kind: "diagnosis", kindLabel: "Diagnosis", owner: null, ownerLabel: null, title: "INCIDENT-31499: kept a resolved gap open" });
    // The linked findings (fixA, fixB, fixC) and the to-address ones come from two audits, each once.
    expect(page.sourceAudits).toEqual([
      { id: AUDIT.nov, name: "November follow-up", href: `${base}/${AUDIT.nov}` },
      { id: AUDIT.late, name: "Late October low scores", href: `${base}/${AUDIT.late}` },
    ]);
    expect((await loadRevisionPage(space, "fix-2"))!.sourceAudits).toEqual([{ id: AUDIT.nov, name: "November follow-up", href: `${base}/${AUDIT.nov}` }]);
  });

  it("keeps an ID whose finding no longer exists so it can still be removed", async () => {
    const gone = crypto.randomUUID();
    await db().update(revisions).set({ toAddressFindingIds: [gone, F.fixD.id] }).where(eq(revisions.id, fix1));
    const page = (await loadRevisionPage(space, "fix-1"))!;
    expect(page.toAddress[0]).toMatchObject({ id: gone, state: "missing", accepted: false, href: null, auditHref: null, notAcceptedReason: "This finding is no longer in the space." });
    expect(page.toAddress[1]).toMatchObject({ id: F.fixD.id, accepted: true });
    expect(page.sourceAudits.map((a) => a.id)).not.toContain("");
    expect(await removeFindingFromRevision(space, { revisionId: fix1, findingId: gone }, alex)).toMatchObject({ removed: true });
  });
});

describe("changes at the same time", () => {
  it("keeps every finding when several requests change the list at once", async () => {
    const extra: Seeded[] = [];
    for (let n = 0; n < 5; n++) extra.push(await seedFinding(space.id, AUDIT.nov, { state: "accepted", kind: "fix", title: `Extra fix ${n}`, incidentId: `INCIDENT-4000${n}` }));
    await db().update(revisions).set({ toAddressFindingIds: [F.diag.id] }).where(eq(revisions.id, fix1));
    await Promise.all(extra.map((f) => addFindingsToRevision(space, { revisionId: fix1, findingIds: [f.id] }, alex)));
    expect([...(await row(fix1)).toAddressFindingIds].sort()).toEqual([F.diag.id, ...extra.map((f) => f.id)].sort());

    // A removal and an add that overlap both land.
    const [first, second] = extra as [Seeded, Seeded];
    await Promise.all([removeFindingFromRevision(space, { revisionId: fix1, findingId: first.id }, alex), removeFindingFromRevision(space, { revisionId: fix1, findingId: second.id }, alex), addFindingsToRevision(space, { revisionId: fix1, findingIds: [F.fixD.id] }, alex)]);
    const list = (await row(fix1)).toAddressFindingIds;
    expect(list).toContain(F.fixD.id);
    expect(list).not.toContain(first.id);
    expect(list).not.toContain(second.id);
    expect(list).toHaveLength(1 + 3 + 1);
  });
});
