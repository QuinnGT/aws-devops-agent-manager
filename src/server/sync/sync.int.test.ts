import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AssetJson } from "@/lib/assets/types";
import { type Attribution, attributeChanges, attributionKey } from "@/server/attribution";
import { db } from "@/server/db/client";
import { agentSpaces, assetChanges, assetIndex, historyRepos } from "@/server/db/schema";
import { resetEnvForTests } from "@/server/env";
import { HistoryRepo } from "@/server/git/history-repo";
import { toHistoryRepoConfig } from "@/server/spaces/queries";
import { apiFixture } from "../../../test/helpers/fixtures";
import { truncateAll } from "../../../test/helpers/db";
import { sha256Hex } from "./content";
import { syncSpace } from "./engine";
import { lastGoodSyncAt } from "./last-good";
import { getSyncStatus, listAssetChanges, listAssetIndex } from "./queries";
import { dueSpaces, enqueueDueSyncs } from "./schedule";
import { patchSyncState } from "./state";
import { type FakeAsset, FakeSpace, fixtureSpace, skillZipFixture, TEST_SPACE_ID, versionMarker } from "./testing/fake-space";

vi.mock("@/server/attribution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/attribution")>();
  return { ...actual, attributeChanges: vi.fn(actual.attributeChanges) };
});

const actor = { email: "system:test" };
const OVERVIEW = "ki-9184fa09-8e79-4a11-90fa-a6b81ab5fe6b";
const OVERVIEW_DIR = "spaces/test-space/memory/chat-tool-use-best-practices/overview";
const SKILL = "ki-6e6624f9-cca2-4545-8c89-3519caa36a0f";
const SKILL_DIR = "spaces/test-space/skill/chat-tool-use-best-practices";
const AGENTS_MD = "ki-8578b1bb-b5ff-41d8-9368-4f106b846352";
const SMALL_SKILL = "ki-bfc466c0-77ed-42e7-a5dc-7881ca27d6cc";
const VERITY_STORE = "ki-f7aad8aa-0449-4221-bd9d-bceee6f33d24";
const VERITY_MEMORY = "ki-b77513b3-2248-43cc-a063-1abec03216fb";
const ARTIFACT = "ki-e69ad174-2207-43d5-898a-86b605d93241";
const DAILY_SPACE_ID = "0f0e0d0c-0b0a-4908-8706-050403020100";

let dataDir: string;
const iso = (d: string) => new Date(d).toISOString();

/** Attribution stand-in: memories by the agent, everything else from the console. */
function fakeAttribution() {
  vi.mocked(attributeChanges).mockImplementation(async (changes) => {
    const out = new Map<string, Attribution>();
    for (const c of changes) {
      out.set(
        attributionKey(c),
        c.assetType === "memory"
          ? { source: "agent", label: "DevOps Agent (no API call recorded)", principal: null, cloudTrailEventId: null, planId: null, matchedBy: "none" }
          : {
              source: "console",
              label: "Operator Web App",
              principal: "DevOpsAgentRole-WebappAdmin-abc/alex-Admin",
              cloudTrailEventId: `evt-${c.assetId}-${c.serviceVersion}`,
              planId: null,
              matchedBy: "exact",
            },
      );
    }
    return out;
  });
}

function failingAttribution() {
  vi.mocked(attributeChanges).mockImplementation(async () => {
    throw new Error("attributeChanges is not implemented yet");
  });
}

async function createSpace(alias: string, repoName: string, agentSpaceId: string, settings: Record<string, unknown> = {}) {
  const [repo] = await db().insert(historyRepos).values({ name: repoName }).returning();
  const [space] = await db()
    .insert(agentSpaces)
    .values({ alias, displayName: alias, region: "us-west-2", accountId: "111122223333", agentSpaceId, historyRepoId: repo!.id, settings })
    .returning();
  return { space: space!, repo: await HistoryRepo.open(toHistoryRepoConfig(repo!)) };
}

async function committer(dir: string, hash: string): Promise<string> {
  return (await simpleGit({ baseDir: dir }).raw(["log", "-1", "--format=%cn <%ce>", hash])).trim();
}

async function assetJson(repo: HistoryRepo, dir: string): Promise<AssetJson> {
  return JSON.parse((await repo.readFile(`${dir}/asset.json`))!) as AssetJson;
}

async function changesFor(spaceId: string, assetId: string) {
  return db()
    .select()
    .from(assetChanges)
    .where(and(eq(assetChanges.spaceId, spaceId), eq(assetChanges.assetId, assetId)))
    .orderBy(assetChanges.serviceUpdatedAt);
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "dam-sync-int-"));
  process.env.DAM_PROCESS = "worker";
  process.env.DAM_DATA_DIR = dataDir;
  resetEnvForTests();
  await truncateAll();
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("sync of the test space", () => {
  let fake: FakeSpace;
  let spaceId: string;
  let repo: HistoryRepo;
  const NOW = new Date("2026-11-11T12:00:00.000Z");
  const now = () => NOW;

  beforeAll(async () => {
    fake = await fixtureSpace();
    // Before the 2026-11-10 Active switch, version 24 still carried its content timestamp.
    fake.updateInPlace(OVERVIEW, {}, "2026-11-07T18:33:31.000Z");
    fake.install();
    const created = await createSpace("test-space", "test-history", TEST_SPACE_ID);
    spaceId = created.space.id;
    repo = created.repo;
  });

  afterAll(() => fake.restore());

  it("imports the full history of every asset on the first sync, oldest first", async () => {
    fakeAttribution();
    const totalVersions = [...fake.assets.values()].reduce((n, a) => n + a.versions.length, 0);
    expect(totalVersions).toBe(75);

    const r = await syncSpace(spaceId, { actor, now });
    expect(r).toMatchObject({ mode: "baseline", status: "succeeded", listed: 20, commits: totalVersions, changes: totalVersions, attributionFailed: false });
    expect(vi.mocked(attributeChanges)).toHaveBeenCalledTimes(1);

    const log = (await repo.log({ maxCount: 1000 })).reverse();
    expect(log).toHaveLength(totalVersions);
    const times = log.map((e) => new Date(e.date).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    for (const e of log) {
      expect(iso(e.date)).toBe(e.trailers["Service-Updated-At"]);
      expect(e.trailers).toMatchObject({ "Asset-Id": expect.any(String), "Asset-Type": expect.any(String), "Service-Version": expect.any(String), Space: "test-space" });
    }
    // space.json rides on the first commit; no credentials.
    const spaceJson = JSON.parse((await repo.show(log[0]!.hash, "spaces/test-space/space.json"))!);
    expect(spaceJson).toEqual({ alias: "test-space", displayName: "test-space", agentSpaceId: TEST_SPACE_ID, region: "us-west-2", accountId: "111122223333" });

    // Every one of the memory's 24 versions is a commit, with its own content.
    const overviewLog = (await repo.log({ path: OVERVIEW_DIR, maxCount: 100 })).reverse();
    expect(overviewLog.map((e) => Number(e.trailers["Service-Version"]))).toEqual(Array.from({ length: 24 }, (_, n) => n + 1));
    expect(await repo.show(overviewLog[0]!.hash, `${OVERVIEW_DIR}/overview.md`)).toContain(versionMarker(1).trim());
    const fileFx = apiFixture<{ file: { content: { text: string } } }>("GetAssetFile.memory").response.file.content.text;
    expect(await repo.readFile(`${OVERVIEW_DIR}/overview.md`)).toBe(fileFx);
    expect(overviewLog[0]!.message).toBe("Add memory overview (version 1)");
    expect(overviewLog[1]!.message).toBe("Update memory overview to version 2");

    // Authors from attribution, committer from policy.
    expect(overviewLog[0]).toMatchObject({ authorName: "DevOps Agent (no API call recorded)", authorEmail: "agent@devops-agent-manager.invalid" });
    expect(overviewLog[0]!.trailers["Change-Source"]).toBe("agent");
    const skillLog = await repo.log({ path: SKILL_DIR, maxCount: 1 });
    expect(skillLog[0]).toMatchObject({ authorName: "DevOpsAgentRole-WebappAdmin-abc/alex-Admin", authorEmail: "devopsagentrole-webappadmin-abc-alex-admin@devops-agent-manager.invalid" });
    expect(skillLog[0]!.trailers).toMatchObject({ "Change-Source": "console", Principal: "DevOpsAgentRole-WebappAdmin-abc/alex-Admin", "CloudTrail-Event-Id": `evt-${SKILL}-14` });
    expect(await committer(repo.dir, skillLog[0]!.hash)).toBe("DevOps Agent Manager sync <sync@devops-agent-manager.invalid>");

    // asset.json of the multi-file skill, read through GetAssetContent.
    const zip = await skillZipFixture();
    const skillJson = await assetJson(repo, SKILL_DIR);
    const skillMeta = apiFixture<{ asset: { metadata: Record<string, unknown> } }>("GetAsset.skill").response.asset.metadata;
    expect(skillJson).toMatchObject({ assetId: SKILL, assetType: "skill", serviceVersion: 14, serviceUpdatedAt: "2026-09-26T18:42:37.000Z", serviceCreatedAt: "2026-07-07T18:43:41.000Z" });
    expect(skillJson.metadata).toEqual(skillMeta);
    expect(Object.keys(skillJson.metadata)).toEqual(Object.keys(skillMeta).sort());
    expect(skillJson.files.map((f) => f.path)).toEqual([...zip.keys()].sort());
    for (const f of skillJson.files) {
      expect(f).toMatchObject({ sha256: sha256Hex(zip.get(f.path)!), size: Buffer.byteLength(zip.get(f.path)!), committed: true });
      expect(await repo.readFile(`${SKILL_DIR}/${f.path}`)).toBe(zip.get(f.path));
    }
    expect(fake.callsOf("GetAssetContent").filter((c) => c.input.assetId === SKILL)).toHaveLength(14);
    expect(fake.callsOf("GetAssetContent").every((c) => typeof c.input.assetVersion === "number")).toBe(true);
    // Version listing is paged (page cap 10, 24 versions).
    expect(fake.callsOf("ListAssetVersions").filter((c) => c.input.assetId === OVERVIEW)).toHaveLength(3);

    const index = await listAssetIndex(spaceId);
    expect(index).toHaveLength(20);
    for (const row of index) expect(row.lastSyncedVersion).toBe(row.liveVersion);
    expect(index.find((r) => r.assetId === OVERVIEW)).toMatchObject({ gitPath: OVERVIEW_DIR, parentAssetId: "ki-63edd778-1a7a-483f-8b18-479742a15a04", name: "overview" });
    const overviewChanges = await changesFor(spaceId, OVERVIEW);
    expect(overviewChanges.map((c) => c.changeKind)).toEqual(["created", ...Array(23).fill("content")]);
    expect(overviewChanges[0]).toMatchObject({ changeSource: "agent", attributionMatchedBy: "none", gitPath: OVERVIEW_DIR });

    const status = await getSyncStatus(spaceId);
    expect(status).toMatchObject({ status: "succeeded", liveAssets: 20, pendingAssets: 0, error: null });
    expect(status.baselineCompletedAt).not.toBeNull();
    expect(status.cursor?.toISOString()).toBe("2026-11-10T23:00:38.000Z");
  }, 300_000);

  it("is idempotent: a second sync adds no commits", async () => {
    const head = await repo.head();
    const before = (await db().select().from(assetChanges)).length;
    fake.calls.length = 0;
    const r = await syncSpace(spaceId, { actor, now });
    expect(r).toMatchObject({ mode: "incremental", commits: 0, changes: 0 });
    expect(await repo.head()).toBe(head);
    expect((await db().select().from(assetChanges)).length).toBe(before);
    const list = fake.callsOf("ListAssets")[0]!;
    expect((list.input.updatedAfter as Date).toISOString()).toBe("2026-11-10T22:55:38.000Z");
  });

  it("recovers a change that is in git but missing from Postgres without a duplicate commit", async () => {
    const head = await repo.head();
    const [last] = (await changesFor(spaceId, OVERVIEW)).slice(-1);
    await db()
      .delete(assetChanges)
      .where(and(eq(assetChanges.spaceId, spaceId), eq(assetChanges.assetId, OVERVIEW), eq(assetChanges.serviceVersion, 24)));
    await db()
      .update(assetIndex)
      .set({ lastSyncedVersion: 23, lastSyncedUpdatedAt: new Date("2026-11-03T18:38:34.000Z") })
      .where(and(eq(assetIndex.spaceId, spaceId), eq(assetIndex.assetId, OVERVIEW)));
    const r = await syncSpace(spaceId, { actor, now });
    expect(r.commits).toBe(0);
    expect(r.changes).toBe(1);
    expect(await repo.head()).toBe(head);
    const [restored] = (await changesFor(spaceId, OVERVIEW)).slice(-1);
    expect(restored).toMatchObject({ serviceVersion: 24, commit: last!.commit });
  });

  it("commits new versions in time order across assets, labeled unknown when attribution fails", async () => {
    failingAttribution();
    const head = await repo.head();
    fake.addVersion(AGENTS_MD, { updatedAt: "2026-11-11T10:00:00.000Z", files: [{ path: "AGENTS.md", text: "# v6\n", mimeType: "text/markdown" }] });
    const skillFiles = fake.latest(SKILL).files.filter((f) => f.path !== "references/mcp-server-testing.md").map((f) => ({ ...f }));
    skillFiles[0]!.text += "\nOne more line.\n";
    fake.addVersion(SKILL, { updatedAt: "2026-11-11T10:05:00.000Z", files: skillFiles });
    fake.addVersion(AGENTS_MD, { updatedAt: "2026-11-11T10:10:00.000Z", files: [{ path: "AGENTS.md", text: "# v7\n", mimeType: "text/markdown" }] });

    const r = await syncSpace(spaceId, { actor, now });
    expect(r).toMatchObject({ commits: 3, changes: 3, attributionFailed: true, status: "succeeded" });
    const log = (await repo.log({ maxCount: 3 })).reverse();
    expect(log.map((e) => [e.trailers["Asset-Id"], e.trailers["Service-Version"], iso(e.date)])).toEqual([
      [AGENTS_MD, "6", "2026-11-11T10:00:00.000Z"],
      [SKILL, "15", "2026-11-11T10:05:00.000Z"],
      [AGENTS_MD, "7", "2026-11-11T10:10:00.000Z"],
    ]);
    expect((await repo.log({ maxCount: 4 }))[3]!.hash).toBe(head);
    for (const e of log) {
      expect(e).toMatchObject({ authorName: "Unknown", authorEmail: "unknown@devops-agent-manager.invalid" });
      expect(e.trailers["Change-Source"]).toBe("unknown");
      expect(e.trailers.Principal).toBeUndefined();
    }
    expect(await repo.readFile("spaces/test-space/agents_md/GENERIC/AGENTS.md")).toBe("# v7\n");
    expect(await repo.readFile(`${SKILL_DIR}/references/mcp-server-testing.md`)).toBeNull();
    expect((await assetJson(repo, SKILL_DIR)).files).toHaveLength(4);
    const md = await changesFor(spaceId, AGENTS_MD);
    expect(md.slice(-2).map((c) => [c.serviceVersion, c.changeKind, c.changeSource, c.attributionMatchedBy, c.changeSourceLabel])).toEqual([
      [6, "content", "unknown", "error", "Unknown"],
      [7, "content", "unknown", "error", "Unknown"],
    ]);
  });

  it("records a status-only change as a metadata commit without a new version", async () => {
    fakeAttribution();
    const head = (await repo.head())!;
    fake.updateInPlace(OVERVIEW, { status: "INACTIVE" }, "2026-11-11T10:20:00.000Z");
    const r = await syncSpace(spaceId, { actor, now });
    expect(r).toMatchObject({ commits: 1, changes: 1 });
    const [e] = await repo.log({ maxCount: 1 });
    expect(e!.trailers).toMatchObject({ "Asset-Id": OVERVIEW, "Service-Version": "24", "Service-Updated-At": "2026-11-11T10:20:00.000Z" });
    expect(e!.message).toBe("Update metadata of memory overview (version 24)");
    expect(e!.body).toContain("Changed metadata: status.");
    expect((await repo.diff(head, e!.hash)).match(/^diff --git .*$/gm)).toEqual([`diff --git a/${OVERVIEW_DIR}/asset.json b/${OVERVIEW_DIR}/asset.json`]);
    expect(await assetJson(repo, OVERVIEW_DIR)).toMatchObject({ serviceVersion: 24, serviceUpdatedAt: "2026-11-11T10:20:00.000Z", metadata: { status: "INACTIVE" } });

    fake.updateInPlace(OVERVIEW, { status: "ACTIVE" }, "2026-11-11T10:25:00.000Z");
    expect((await syncSpace(spaceId, { actor, now })).commits).toBe(1);
    const changes = await changesFor(spaceId, OVERVIEW);
    expect(changes.slice(-2).map((c) => [c.serviceVersion, c.changeKind, c.serviceUpdatedAt.toISOString()])).toEqual([
      [24, "metadata", "2026-11-11T10:20:00.000Z"],
      [24, "metadata", "2026-11-11T10:25:00.000Z"],
    ]);
    expect((await listAssetChanges(spaceId, OVERVIEW, { limit: 1 }))[0]!.serviceUpdatedAt.toISOString()).toBe("2026-11-11T10:25:00.000Z");
  });

  it("moves the directory when an asset is renamed, and moves a renamed store's memories", async () => {
    fake.addVersion(SMALL_SKILL, { updatedAt: "2026-11-11T10:30:00.000Z", metadata: { name: "skip-maintenance-window" } });
    expect((await syncSpace(spaceId, { actor, now })).commits).toBe(1);
    const [e] = await repo.log({ maxCount: 1 });
    expect(e!.body).toContain("Moved from spaces/test-space/skill/sample-skip-scheduled-maintenance to spaces/test-space/skill/skip-maintenance-window.");
    expect(await repo.listFiles("spaces/test-space/skill/sample-skip-scheduled-maintenance")).toEqual([]);
    expect((await repo.listFiles("spaces/test-space/skill/skip-maintenance-window")).sort()).toEqual([
      "spaces/test-space/skill/skip-maintenance-window/asset.json",
      "spaces/test-space/skill/skip-maintenance-window/sample-skip-scheduled-maintenance.md",
    ]);
    expect((await listAssetIndex(spaceId, { assetType: "skill" })).find((r) => r.assetId === SMALL_SKILL)).toMatchObject({
      name: "skip-maintenance-window",
      gitPath: "spaces/test-space/skill/skip-maintenance-window",
    });

    fake.addVersion(VERITY_STORE, { updatedAt: "2026-11-11T10:35:00.000Z", metadata: { name: "verity-checks" } });
    expect((await syncSpace(spaceId, { actor, now })).commits).toBe(1);
    const oldMem = "spaces/test-space/memory/verity/verity-report-farm-bars-required";
    const newMem = "spaces/test-space/memory/verity-checks/verity-report-farm-bars-required";
    expect(await repo.listFiles(oldMem)).toEqual([]);
    expect((await repo.listFiles(newMem)).sort()).toEqual([`${newMem}/asset.json`, `${newMem}/verity-report-farm-bars-required.md`]);
    expect(await repo.listFiles("spaces/test-space/memory_store/verity-checks")).toContain("spaces/test-space/memory_store/verity-checks/asset.json");
    const [s] = await repo.log({ maxCount: 1 });
    expect(s!.body).toContain("Moved 1 memory to the renamed store's directory.");
    expect((await listAssetIndex(spaceId, { assetType: "memory" })).find((r) => r.assetId === VERITY_MEMORY)!.gitPath).toBe(newMem);
  });

  it("commits deletions found by the reconcile", async () => {
    fake.remove(ARTIFACT);
    const head = await repo.head();
    expect((await syncSpace(spaceId, { actor, now })).commits).toBe(0);
    expect(await repo.head()).toBe(head);

    const r = await syncSpace(spaceId, { actor, now }, { mode: "reconcile" });
    expect(r).toMatchObject({ mode: "reconcile", deleted: 1, commits: 1 });
    const [e] = await repo.log({ maxCount: 1 });
    expect(e!.message).toBe(`Delete artifact ${ARTIFACT}`);
    expect(e!.trailers).toMatchObject({ "Asset-Id": ARTIFACT, "Service-Version": "1", "Service-Updated-At": NOW.toISOString() });
    expect(iso(e!.date)).toBe(NOW.toISOString());
    expect(await repo.listFiles(`spaces/test-space/artifact/${ARTIFACT}`)).toEqual([]);
    const row = (await listAssetIndex(spaceId, { includeDeleted: true })).find((x) => x.assetId === ARTIFACT)!;
    expect(row.deletedAt?.toISOString()).toBe(NOW.toISOString());
    expect((await listAssetIndex(spaceId)).some((x) => x.assetId === ARTIFACT)).toBe(false);
    expect((await changesFor(spaceId, ARTIFACT)).at(-1)).toMatchObject({ changeKind: "deleted", commit: e!.hash });
    const status = await getSyncStatus(spaceId);
    expect(status.lastReconcileAt?.toISOString()).toBe(NOW.toISOString());
    expect(status.deletedAssets).toBe(1);

    expect((await syncSpace(spaceId, { actor, now }, { mode: "reconcile" })).commits).toBe(0);
  });

  it("refuses a reconcile that would delete most of the space", async () => {
    const head = await repo.head();
    const saved = new Map(fake.assets);
    fake.assets.clear();
    const later = new Date(NOW.getTime() + 3_600_000);
    // A row from before last_result.succeededAt existed keeps its good time through a failure too.
    await patchSyncState(spaceId, { lastResult: { changes: 0 } });
    try {
      await expect(syncSpace(spaceId, { actor, now: () => later }, { mode: "reconcile" })).rejects.toThrow(/Reconcile stopped: 19 of 19 known assets/);
      expect(await repo.head()).toBe(head);
      const failed = await getSyncStatus(spaceId);
      expect(failed.status).toBe("error");
      // The failure's time moves forward; the last good sync's time stays.
      expect(failed.lastSyncCompletedAt).toEqual(later);
      expect(lastGoodSyncAt(failed)).toEqual(NOW);
    } finally {
      for (const [k, v] of saved) fake.assets.set(k, v);
    }
    expect((await syncSpace(spaceId, { actor, now })).status).toBe("succeeded");
  });

  // Last in this group: it moves the space's clock 26 hours ahead.
  it("runs a sync as a reconcile when the last reconcile is overdue, and as incremental right after", async () => {
    const later = new Date(NOW.getTime() + 26 * 3_600_000);
    expect((await syncSpace(spaceId, { actor, now: () => later })).mode).toBe("reconcile");
    expect((await getSyncStatus(spaceId)).lastReconcileAt?.toISOString()).toBe(later.toISOString());
    const r = await syncSpace(spaceId, { actor, now: () => new Date(later.getTime() + 60_000) });
    expect(r).toMatchObject({ mode: "incremental", commits: 0 });
  });
});

describe("store commit policies and large files", () => {
  const D1 = "2026-11-01";
  const D2 = "2026-11-02";
  const D3 = "2026-11-03";
  let fake: FakeSpace;
  let spaceId: string;
  let repo: HistoryRepo;

  const file = (p: string, text: string) => ({ path: p, text, mimeType: "text/markdown" });
  const big = new Uint8Array(4096).map((_, n) => (n * 7) % 256);
  const small = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253]);

  beforeAll(async () => {
    fakeAttribution();
    fake = new FakeSpace(DAILY_SPACE_ID);
    const meta = (name: string, extra: Record<string, unknown> = {}) => ({ name, status: "ACTIVE", ...extra });
    fake.add({ assetId: "st-ops", assetType: "memory_store", versions: [{ version: 1, createdAt: `${D1}T08:00:00.000Z`, updatedAt: `${D1}T08:00:00.000Z`, metadata: meta("ops"), files: [file("ops.md", "# ops\n")] }] });
    fake.add({
      assetId: "mem-runbook",
      assetType: "memory",
      versions: [
        [1, `${D1}T09:00:00.000Z`],
        [2, `${D1}T15:00:00.000Z`],
        [3, `${D2}T10:00:00.000Z`],
        [4, `${D3}T08:00:00.000Z`],
        [5, `${D3}T09:00:00.000Z`],
      ].map(([v, t]) => ({ version: v as number, createdAt: `${D1}T09:00:00.000Z`, updatedAt: t as string, metadata: meta("runbook", { memory_store_id: "st-ops" }), files: [file("runbook.md", `# runbook v${v}\n`)] })),
    });
    fake.add({ assetId: "st-noisy", assetType: "memory_store", versions: [{ version: 1, createdAt: `${D1}T08:00:00.000Z`, updatedAt: `${D1}T08:00:00.000Z`, metadata: meta("noisy"), files: [file("noisy.md", "# noisy\n")] }] });
    fake.add({
      assetId: "mem-noise",
      assetType: "memory",
      versions: [1, 2, 3].map((v) => ({ version: v, createdAt: `${D1}T08:00:00.000Z`, updatedAt: `${D1}T1${v}:00:00.000Z`, metadata: meta("noise", { memory_store_id: "st-noisy" }), files: [file("noise.md", `${v}\n`)] })),
    });
    fake.add({
      assetId: "att-1",
      assetType: "attachment",
      versions: [{ version: 1, createdAt: `${D1}T07:00:00.000Z`, updatedAt: `${D1}T07:00:00.000Z`, metadata: { name: "dump" }, files: [{ path: "big.bin", bytes: big, mimeType: "application/octet-stream" }, { path: "small.bin", bytes: small, mimeType: "application/octet-stream" }] }],
    });
    fake.install();

    const created = await createSpace("daily-space", "daily-history", DAILY_SPACE_ID, { storeCommitPolicies: { ops: "daily", noisy: "ignore" } });
    spaceId = created.space.id;
    repo = created.repo;
    // The history repository's own policy lowers the committed-file threshold.
    await repo.writeAndCommit([{ path: "policy/history-layout.yaml", content: "maxCommittedFileBytes: 2048\n" }], {
      message: "Policy",
      author: { name: "t", email: "t@example.com" },
      committer: { name: "t", email: "t@example.com" },
      date: new Date("2026-10-01T00:00:00.000Z"),
    });
  });

  afterAll(() => fake.restore());

  it("commits only the last version of each finished UTC day for a daily store, and nothing for an ignored store", async () => {
    const r = await syncSpace(spaceId, { actor, now: () => new Date(`${D3}T12:00:00.000Z`) });
    expect(r.deferred).toBe(2);
    expect((await changesFor(spaceId, "mem-runbook")).map((c) => [c.serviceVersion, c.serviceUpdatedAt.toISOString()])).toEqual([
      [2, `${D1}T15:00:00.000Z`],
      [3, `${D2}T10:00:00.000Z`],
    ]);
    const memLog = (await repo.log({ path: "spaces/daily-space/memory/ops/runbook", maxCount: 10 })).reverse();
    expect(memLog.map((e) => iso(e.date))).toEqual([`${D1}T15:00:00.000Z`, `${D2}T10:00:00.000Z`]);
    expect(memLog[0]!.message).toBe("Import memory runbook at version 2");
    expect(await repo.readFile("spaces/daily-space/memory/ops/runbook/runbook.md")).toBe("# runbook v3\n");
    expect(await changesFor(spaceId, "mem-noise")).toEqual([]);
    expect(await changesFor(spaceId, "st-noisy")).toEqual([]);
    expect(await repo.listFiles("spaces/daily-space/memory/noisy")).toEqual([]);
    const index = await listAssetIndex(spaceId);
    expect(index.find((x) => x.assetId === "mem-noise")).toMatchObject({ liveVersion: 3, lastSyncedVersion: null, gitPath: null, name: "noise" });
    expect(index.find((x) => x.assetId === "mem-runbook")).toMatchObject({ liveVersion: 5, lastSyncedVersion: 3 });
    expect((await getSyncStatus(spaceId)).pendingAssets).toBe(3);

    // Next day: the deferred day is over, so version 5 (its last version) is committed and 4 is skipped.
    fake.calls.length = 0;
    const r2 = await syncSpace(spaceId, { actor, now: () => new Date("2026-11-04T01:00:00.000Z") });
    expect(r2).toMatchObject({ commits: 1, deferred: 0 });
    expect((await changesFor(spaceId, "mem-runbook")).map((c) => c.serviceVersion)).toEqual([2, 3, 5]);
    const [e] = await repo.log({ maxCount: 1 });
    expect(iso(e!.date)).toBe(`${D3}T09:00:00.000Z`);
    expect(e!.message).toBe("Update memory runbook to version 5");
  });

  it("keeps the hash of files above the size threshold without committing their content", async () => {
    const dir = "spaces/daily-space/attachment/att-1";
    const json = await assetJson(repo, dir);
    expect(json.files).toEqual([
      { path: "big.bin", sha256: sha256Hex(big), size: 4096, committed: false, mimeType: "application/octet-stream" },
      { path: "small.bin", sha256: sha256Hex(small), size: 8, committed: true, mimeType: "application/octet-stream" },
    ]);
    expect((await repo.listFiles(dir)).sort()).toEqual([`${dir}/asset.json`, `${dir}/small.bin`]);
    expect(new Uint8Array(await readFile(path.join(repo.dir, dir, "small.bin")))).toEqual(small);
  });
});

describe("sync.tick scheduling", () => {
  it("enqueues spaces whose interval has elapsed and records the enqueue time", async () => {
    const spaces = await db().select().from(agentSpaces);
    const t0 = new Date("2026-11-11T12:00:00.000Z");
    for (const s of spaces) await patchSyncState(s.id, { lastEnqueuedAt: null, lastSyncStartedAt: t0 });
    await db().update(agentSpaces).set({ settings: { syncIntervalMinutes: 5 } }).where(eq(agentSpaces.alias, "daily-space"));

    expect(await dueSpaces(new Date("2026-11-11T12:04:00.000Z"))).toEqual([]);
    const due = await dueSpaces(new Date("2026-11-11T12:06:00.000Z"));
    expect(due.map((d) => [d.alias, d.intervalMinutes])).toEqual([["daily-space", 5]]);

    const sent: string[] = [];
    const at = new Date("2026-11-11T12:16:00.000Z");
    const out = await enqueueDueSyncs(
      at,
      { email: "system:sync.tick" },
      async (spaceId) => {
        sent.push(spaceId);
        return `run-${sent.length}`;
      },
      (spaceId, when) => patchSyncState(spaceId, { lastEnqueuedAt: when }),
    );
    expect(out).toHaveLength(2);
    expect((await dueSpaces(new Date("2026-11-11T12:20:00.000Z"))).map((d) => d.alias)).toEqual([]);
    expect((await dueSpaces(new Date("2026-11-11T12:21:00.000Z"))).map((d) => d.alias)).toEqual(["daily-space"]);
  });
});

describe("review attachments", () => {
  const SPACE = "0f0e0d0c-0b0a-4908-8706-0504030201aa";
  const T = "2026-11-05T10:00:00.000Z";
  const attachment = (assetId: string, filename: string, text: string): FakeAsset => ({
    assetId,
    assetType: "attachment",
    versions: [{ version: 1, createdAt: T, updatedAt: T, metadata: { filename, extension: "md", size: text.length }, files: [{ path: filename, text, mimeType: "text/markdown" }] }],
  });
  let fake: FakeSpace;
  let spaceId: string;
  let repo: HistoryRepo;

  beforeAll(async () => {
    fakeAttribution();
    fake = new FakeSpace(SPACE);
    fake.add(attachment("att-notes", "notes.md", "# notes\n"));
    fake.add(attachment("att-review-records", "dam-review-INCIDENT-1-0a1b2c3d-records.md", "## R1 MESSAGE 2026-11-05 10:00:00\n"));
    fake.install();
    const created = await createSpace("review-space", "review-history", SPACE);
    spaceId = created.space.id;
    repo = created.repo;
  });

  afterAll(() => fake.restore());

  it("leaves a chat review's temporary attachment out of history, the index and the version reads", async () => {
    const r = await syncSpace(spaceId, { actor, now: () => new Date("2026-11-06T00:00:00.000Z") });
    expect(r).toMatchObject({ status: "succeeded", listed: 1, commits: 1, changes: 1 });
    expect((await listAssetIndex(spaceId)).map((x) => x.assetId)).toEqual(["att-notes"]);
    expect(await changesFor(spaceId, "att-review-records")).toEqual([]);
    expect(fake.callsOf("ListAssetVersions").map((c) => c.input.assetId)).toEqual(["att-notes"]);
    expect((await repo.log({ maxCount: 10 })).map((e) => e.message)).toEqual(["Add attachment att-notes (version 1)"]);
  });

  it("does not record the attachment's deletion, and a reconcile after it is gone changes nothing", async () => {
    fake.remove("att-review-records");
    const r = await syncSpace(spaceId, { actor, now: () => new Date("2026-11-06T01:00:00.000Z") }, { mode: "reconcile" });
    expect(r).toMatchObject({ status: "succeeded", listed: 1, commits: 0, deleted: 0 });
    expect((await repo.log({ maxCount: 10 })).map((e) => e.message)).toEqual(["Add attachment att-notes (version 1)"]);
  });
});
