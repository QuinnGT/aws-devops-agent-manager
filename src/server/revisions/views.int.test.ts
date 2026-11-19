import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useTempDataDir } from "@/server/assets/test-support/history-fixture";
import { db } from "@/server/db/client";
import { agentSpaces, assetIndex, auditItems, audits, findings, historyRepos, jobRuns, reviews, revisions } from "@/server/db/schema";
import { HistoryRepo, type HistoryRepoConfig } from "@/server/git/history-repo";
import { enqueue } from "@/server/jobs/enqueue";
import { testJobContext } from "@/server/jobs/registry";
import { getAppPolicy } from "@/server/policy";
import { createReleaseHandler, prepareCreateRelease } from "@/server/releases/create";
import { commitVersion, type TestAsset } from "@/server/releases/test-support";
import { getSpaceById, type Space } from "@/server/spaces/queries";
import { truncateAll } from "../../../test/helpers/db";
import { createRevisionHandler } from "./create";
import "./jobs";
import { saveRevisionHandler, type SaveRevisionInput } from "./save";
import { requestCreateRevision, requestSaveRevision } from "./service";
import { addTestLayouts } from "@/server/packages/test-support/policy";
import { GLOBAL_MD, PACKAGE_FILES, SAFETY } from "./test-support";
import { loadRevisionPage, loadSaveFindings, readRevisionFile } from "./views";

// Jobs run directly in this test; nothing is sent to pg-boss.
vi.mock("@/server/jobs/enqueue", () => ({ enqueue: vi.fn(async () => crypto.randomUUID()) }));

// The test layout strict-instructions carries the text checks the default layouts leave out.
const restoreLayouts = addTestLayouts();
const policy = getAppPolicy().policy;
const ALIAS = "view-space";
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
let space: Space;
let otherSpace: Space;
let releaseId = "";
let revId = "";
const F = { diag: "", fix: "", proposed: "" };
const ctx = () => testJobContext({ actor: { email: alex.email }, spaceId: space.id });

async function seedFinding(state: "accepted" | "proposed", kind: string, title: string, incidentId: string, records: number[]): Promise<string> {
  const [audit] = await db()
    .insert(audits)
    .values({ spaceId: space.id, name: "Late October low scores", profileId: "benchmark", profileSnapshot: policy.audits.profiles.benchmark!, policyDigest: "test", state: "reviewing", createdBy: alex.email })
    .returning();
  const [item] = await db().insert(auditItems).values({ auditId: audit!.id, spaceId: space.id, taskId: `task-${incidentId}-${kind}`, incidentId, state: "reviewed" }).returning();
  const [review] = await db().insert(reviews).values({ auditId: audit!.id, auditItemId: item!.id, spaceId: space.id, runner: "ai-sdk", modelId: "mock", promptDigest: "d", state: "succeeded", startedBy: alex.email }).returning();
  await db().update(auditItems).set({ currentReviewId: review!.id }).where(eq(auditItems.id, item!.id));
  const values = { owner: "Instruction and skill package", fix: title };
  const [f] = await db()
    .insert(findings)
    .values({
      auditId: audit!.id,
      auditItemId: item!.id,
      reviewId: review!.id,
      spaceId: space.id,
      incidentId,
      kind,
      ordinal: 0,
      title,
      proposed: values,
      current: values,
      citations: records.map((r) => ({ record: r, quote: "q", field: "near_miss", ok: true })),
      state,
      reviewedBy: state === "accepted" ? alex.email : null,
      reviewedAt: state === "accepted" ? new Date() : null,
    })
    .returning();
  return f!.id;
}

async function runSave(request: Parameters<typeof requestSaveRevision>[2]) {
  vi.mocked(enqueue).mockClear();
  await requestSaveRevision(space, revId, request, alex);
  return saveRevisionHandler(vi.mocked(enqueue).mock.calls[0]![1] as SaveRevisionInput, ctx());
}

beforeAll(async () => {
  await truncateAll();
  tmp = await useTempDataDir();
  const cfg: HistoryRepoConfig = { id: "00000000-0000-4000-8000-0000000000f2", name: "view-space-history", remoteUrl: null, deployKeyFile: null, defaultBranch: "main", pushEnabled: false };
  const repo = await HistoryRepo.open(cfg);
  const paths = new Map<string, string>();
  for (const a of ASSETS) paths.set(a.assetId, (await commitVersion(repo, policy.historyLayout, ALIAS, a)).gitPath);
  const [repoRow] = await db().insert(historyRepos).values({ name: cfg.name }).returning();
  const [row] = await db().insert(agentSpaces).values({ alias: ALIAS, region: "us-west-2", accountId: "111122223333", agentSpaceId: "space-view", historyRepoId: repoRow!.id }).returning();
  const [other] = await db().insert(agentSpaces).values({ alias: "view-other", region: "us-west-2", accountId: "111122223333", agentSpaceId: "space-view-other" }).returning();
  space = (await getSpaceById(row!.id))!;
  otherSpace = (await getSpaceById(other!.id))!;
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
        gitPath: paths.get(a.assetId)!,
        metadata: a.metadata,
      });
  }
  const input = await prepareCreateRelease({ spaceId: space.id, name: "v1" });
  await createReleaseHandler(input, ctx(), { sync: syncMock });
  releaseId = input.releaseId;
  F.diag = await seedFinding("accepted", "diagnosis", "INCIDENT-31808: Ruled out Redis too early", "INCIDENT-31808", [114, 121, 114]);
  F.fix = await seedFinding("accepted", "fix", "Record precedents only as hypotheses", "INCIDENT-31495", [12]);
  F.proposed = await seedFinding("proposed", "fix", "Not reviewed yet", "INCIDENT-31500", [3]);

  const created = await requestCreateRevision(space, { name: "v2", base: { kind: "release", releaseId }, layout: "strict-instructions" }, alex);
  revId = created.revisionId;
  await createRevisionHandler({ revisionId: revId }, ctx());
  await runSave({ message: "Add a triage step", edits: [{ path: "instructions/incident-triage.md", content: "# Triage\n\nTriage rules.\nCheck onset first.\n" }], findingIds: [F.diag] });
  // Drops a safety message: the build of this save fails on global.md.
  await runSave({ message: "Shorten the global rules", edits: [{ path: "instructions/global.md", content: GLOBAL_MD.replace(`${SAFETY[1]}\n`, "") }], findingIds: [F.fix] });
});

afterAll(async () => {
  await tmp.cleanup();
  restoreLayouts();
});

describe("loadRevisionPage", () => {
  it("marks the tree: edited against the base, build errors, and the files the build writes", async () => {
    const page = (await loadRevisionPage(space, "v2"))!;
    const m = page.marks;
    expect(m["instructions/global.md"]).toMatchObject({ edited: true, errors: 1, generated: false, instructions: true });
    expect(m["instructions/incident-triage.md"]).toMatchObject({ edited: true, errors: 0, instructions: true });
    expect(m["skills/triage/SKILL.md"]).toMatchObject({ edited: false, errors: 0, instructions: false });
    expect(m["reference/CHANGELOG.md"]).toMatchObject({ generated: true });
    expect(m["skills/triage.zip"]).toMatchObject({ generated: true });
    expect(m["memory/runbooks/INDEX.md"]).toMatchObject({ generated: true });
    expect(page.folders.map((f) => f.name)).toEqual(["instructions", "skills", "memory", "reference"]);
    expect(page.resultFiles[page.detail.build!.results.findIndex((r) => r.code === "package.safety-message")]).toBe("instructions/global.md");
    expect(page.rebuilt).toBe("1 skill zip and 1 memory index rebuilt");
    expect(page.branchMissing).toBe(false);
    expect(page.pendingRun).toBeNull();
    expect(page.baseRelease).toEqual({ id: releaseId, name: "v1" });
  });

  it("diffs the package against the base and each save against its parent, with +/− counts", async () => {
    const page = (await loadRevisionPage(space, revId))!;
    const global = page.baseDiff.files.find((f) => f.path === "instructions/global.md")!;
    expect(global).toMatchObject({ status: "modified", added: 0, removed: 1 });
    expect(page.baseDiff.files.find((f) => f.path === "reference/CHANGELOG.md")).toMatchObject({ status: "added" });
    expect(page.baseDiff.added).toBeGreaterThan(1);
    expect(page.saves.map((s) => [s.number, s.message, s.added, s.removed, s.buildStatus])).toEqual([
      [2, "Shorten the global rules", 0, 1, "failed"],
      [1, "Add a triage step", 1, 0, "passed"],
    ]);
    // A save lists the person's files, not the build's.
    expect(page.saves[1]!.files.map((f) => f.path)).toEqual(["instructions/incident-triage.md"]);
    expect(page.saves[1]!.files[0]!.hunks[0]!.lines.some((l) => l.kind === "add" && l.text === "Check onset first.")).toBe(true);
    expect(page.saves[0]!.findings).toEqual([{ id: F.fix, label: "INCIDENT-31495 · Fix", href: expect.stringMatching(new RegExp(`^/spaces/${ALIAS}/audits/[0-9a-f-]+/findings\\?finding=${F.fix}$`)) }]);
    expect(page.findingLinks[F.diag]).toMatchObject({ label: "INCIDENT-31808 · Diagnosis", kindLabel: "Diagnosis" });
  });

  it("says when a save of the revision is still building", async () => {
    const [run] = await db().insert(jobRuns).values({ queue: "revisions.save", actorEmail: alex.email, spaceId: space.id, input: {} }).returning();
    await db().update(revisions).set({ lastSaveRunId: run!.id }).where(eq(revisions.id, revId));
    expect((await loadRevisionPage(space, revId))!.pendingRun).toEqual({ kind: "save", runId: run!.id });
    await db().update(jobRuns).set({ status: "succeeded" }).where(eq(jobRuns.id, run!.id));
    expect((await loadRevisionPage(space, revId))!.pendingRun).toBeNull();
  });

  it("finds nothing for another space", async () => {
    expect(await loadRevisionPage(otherSpace, revId)).toBeNull();
  });
});

describe("readRevisionFile", () => {
  it("reads one file at the branch head by revision ID or name, and refuses unsafe or missing paths", async () => {
    const head = (await db().select().from(revisions).where(eq(revisions.id, revId)))[0]!.headCommit;
    const f = await readRevisionFile(space, "v2", "instructions/incident-triage.md");
    expect(f).toEqual({ path: "instructions/incident-triage.md", head, view: { kind: "text", text: "# Triage\n\nTriage rules.\nCheck onset first.\n", size: 43 } });
    expect((await readRevisionFile(space, revId, "skills/triage.zip"))!.view.kind).toBe("binary");
    expect(await readRevisionFile(space, revId, "../outside.md")).toBeNull();
    expect(await readRevisionFile(space, revId, "/etc/passwd")).toBeNull();
    expect(await readRevisionFile(space, revId, "instructions/nope.md")).toBeNull();
    expect(await readRevisionFile(otherSpace, revId, "instructions/global.md")).toBeNull();
  });
});

describe("loadSaveFindings", () => {
  it("offers accepted, linkable findings with their cited records, earlier links first", async () => {
    const list = await loadSaveFindings(space, [F.fix]);
    expect(list.map((f) => f.id)).toEqual([F.fix, F.diag]);
    expect(list[0]).toMatchObject({ kindLabel: "Fix", owner: "Instruction and skill package", records: [12], linkedBefore: true, acceptedBy: alex.email, auditName: "Late October low scores" });
    expect(list[1]).toMatchObject({ kindLabel: "Diagnosis", records: [114, 121], linkedBefore: false });
    expect(list.some((f) => f.id === F.proposed)).toBe(false);
    expect(await loadSaveFindings(otherSpace)).toEqual([]);
  });
});
