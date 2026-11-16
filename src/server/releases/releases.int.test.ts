import { DevOpsAgentClient, GetAssetCommand, GetAssetContentCommand, ListAssetFilesCommand } from "@aws-sdk/client-devops-agent";
import { mockClient } from "aws-sdk-client-mock";
import { eq } from "drizzle-orm";
import JSZip from "jszip";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useTempDataDir } from "@/server/assets/test-support/history-fixture";
import { db } from "@/server/db/client";
import { agentSpaces, assetChanges, assetIndex, auditEvents, historyRepos, releases } from "@/server/db/schema";
import { HistoryRepo, type HistoryRepoConfig } from "@/server/git/history-repo";
import { testJobContext } from "@/server/jobs/registry";
import type { CreatePlan, CreatePlanInput } from "@/server/plans/contract";
import { getAppPolicy } from "@/server/policy";
import type { SpaceRow } from "@/server/spaces/queries";
import { truncateAll } from "../../../test/helpers/db";
import { RELEASE_TRAILERS } from "./config";
import { createReleaseHandler, prepareCreateRelease } from "./create";
import { ReleaseError } from "./errors";
import { loadReleaseCompare, loadReleaseDetail, loadReleaseList, loadRollbackPreview } from "./loaders";
import { parseManifest } from "./manifest";
import { createRollbackPlan } from "./rollback";
import { checkReleaseNameForSpace } from "./service";
import { commitDelete, commitVersion, dirOf, type TestAsset } from "./test-support";

// Releases of HEAD sync first (policy releases.syncBeforeCreate). The sync is mocked: it needs the service.
const sync = vi.hoisted(() => ({
  syncSpace: vi.fn(async (spaceId: string) => ({
    spaceId,
    mode: "incremental",
    status: "succeeded",
    listed: 0,
    changedAssets: 0,
    changes: 0,
    commits: 0,
    deferred: 0,
    deleted: 0,
    attributionFailed: false,
    pushed: false,
  })),
}));
vi.mock("@/server/sync/engine", () => sync);

const policy = getAppPolicy().policy;
const layout = policy.historyLayout;
const ALIAS = "rel-space";
const actor = { email: "alex@example.com" };
const aws = mockClient(DevOpsAgentClient);
const client = new DevOpsAgentClient({ region: "us-west-2", credentials: { accessKeyId: "test", secretAccessKey: "test" } });

const id = (n: number) => `ki-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ID = { store: id(1), memory: id(2), triage: id(3), big: id(4), agent: id(5), generic: id(6), newSkill: id(7) };
const BIG = Buffer.alloc(64, 0xff);
const ICON = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0a]);

const skill = (name: string, status = "ACTIVE") => ({ name, description: `${name} skill`, agent_types: ["GENERIC"], status, skill_type: "USER" });

const v1: Record<keyof typeof ID, TestAsset> = {
  store: { assetId: ID.store, assetType: "memory_store", metadata: { name: "runbooks", description: "Runbooks", agent_types: ["GENERIC"], status: "ACTIVE" }, version: 1, updatedAt: "2026-10-01T01:00:00.000Z", files: { "README.md": "# Runbooks\n" } },
  memory: {
    assetId: ID.memory,
    assetType: "memory",
    metadata: { name: "db/failover", description: "Failover", memory_store_id: ID.store, status: "ACTIVE" },
    version: 1,
    updatedAt: "2026-10-01T02:00:00.000Z",
    files: { "failover.md": "Failover v1\n" },
    storeName: "runbooks",
  },
  triage: { assetId: ID.triage, assetType: "skill", metadata: skill("triage"), version: 1, updatedAt: "2026-10-01T03:00:00.000Z", files: { "SKILL.md": "---\nname: triage\ndescription: triage skill\n---\nTriage\n" } },
  big: {
    assetId: ID.big,
    assetType: "skill",
    metadata: skill("big"),
    version: 1,
    updatedAt: "2026-10-01T04:00:00.000Z",
    files: { "SKILL.md": "---\nname: big\ndescription: big skill\n---\nBig\n", "assets/icon.png": ICON },
    uncommitted: { "assets/big.bin": BIG },
  },
  agent: {
    assetId: ID.agent,
    assetType: "custom_agent",
    metadata: { name: "oncall", skills: [ID.triage, ID.big], memory_stores: [ID.store] },
    version: 1,
    updatedAt: "2026-10-01T05:00:00.000Z",
    files: { "AGENT.md": "On call v1\n" },
  },
  generic: { assetId: ID.generic, assetType: "agents_md", metadata: { agent_type: "GENERIC", status: "ACTIVE" }, version: 1, updatedAt: "2026-10-01T06:00:00.000Z", files: { "AGENTS.md": "# Rules v1\n" } },
  newSkill: { assetId: ID.newSkill, assetType: "skill", metadata: skill("new-skill"), version: 1, updatedAt: "2026-11-01T04:00:00.000Z", files: { "SKILL.md": "---\nname: new-skill\ndescription: new-skill skill\n---\nNew\n" } },
};
const memoryV2: TestAsset = { ...v1.memory, version: 2, updatedAt: "2026-11-01T01:00:00.000Z", files: { "failover.md": "Failover v2\n" } };
const agentV2: TestAsset = { ...v1.agent, version: 2, updatedAt: "2026-11-01T03:00:00.000Z", metadata: { name: "oncall", skills: [ID.big], memory_stores: [ID.store], tools: ["aws"] }, files: { "AGENT.md": "On call v2\n" } };
const genericV2: TestAsset = { ...v1.generic, version: 2, updatedAt: "2026-11-01T05:00:00.000Z", files: { "AGENTS.md": "# Rules v2\n" } };

let tmp: Awaited<ReturnType<typeof useTempDataDir>>;
let repo: HistoryRepo;
let space: SpaceRow;
let t1: string;
let releaseV1: string;
const commits = new Map<string, string>();

function cfg(): HistoryRepoConfig {
  return { id: "00000000-0000-4000-8000-0000000000f1", name: "rel-space-history", remoteUrl: null, deployKeyFile: null, defaultBranch: "main", pushEnabled: false };
}

async function index(a: TestAsset, over: Partial<typeof assetIndex.$inferInsert> = {}) {
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
      lastSyncedUpdatedAt: new Date(a.updatedAt),
      gitPath: dirOf(layout, ALIAS, a),
      metadata: a.metadata,
      ...over,
    });
}

async function zipOf(files: Record<string, Buffer | string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [p, c] of Object.entries(files)) zip.file(p, c);
  return zip.generateAsync({ type: "uint8array" });
}

/** Mock the service's copy of one version: GetAsset, ListAssetFiles and GetAssetContent with assetVersion. */
async function serviceHas(a: TestAsset, files: Record<string, Buffer | string>) {
  const req = { assetId: a.assetId, assetVersion: a.version };
  aws.on(GetAssetCommand, req).resolves({ asset: { assetId: a.assetId, assetType: a.assetType, metadata: a.metadata as never, version: a.version, createdAt: new Date(a.updatedAt), updatedAt: new Date(a.updatedAt) } });
  const at = new Date(a.updatedAt);
  aws.on(ListAssetFilesCommand, req).resolves({ items: Object.keys(files).map((p) => ({ path: p, version: a.version, createdAt: at, updatedAt: at })) });
  aws.on(GetAssetContentCommand, req).resolves({ content: { zipFile: await zipOf(files) } });
}

function planMock() {
  return vi.fn<CreatePlan>(async () => ({ planId: "11111111-1111-4111-8111-111111111111", checkRunId: "22222222-2222-4222-8222-222222222222" }));
}

const itemFor = (input: CreatePlanInput, assetIdOrKey: string) => input.items.find((i) => i.desired.assetId === assetIdOrKey || (!i.desired.assetId && i.desired.key === assetIdOrKey))!;

beforeAll(async () => {
  await truncateAll();
  tmp = await useTempDataDir();
  repo = await HistoryRepo.open(cfg());
  for (const k of ["store", "memory", "triage", "big", "agent", "generic"] as const) {
    const c = await commitVersion(repo, layout, ALIAS, v1[k]);
    commits.set(`${k}@1`, c.commit);
  }
  t1 = (await repo.head())!;
  const [repoRow] = await db().insert(historyRepos).values({ name: cfg().name }).returning();
  const [spaceRow] = await db().insert(agentSpaces).values({ alias: ALIAS, region: "us-west-2", accountId: "111122223333", agentSpaceId: "space-rel", historyRepoId: repoRow!.id }).returning();
  space = spaceRow!;
});

afterEach(() => {
  aws.reset();
  vi.restoreAllMocks();
});

afterAll(async () => {
  aws.restore();
  await tmp.cleanup();
});

describe("creating a release", () => {
  it("commits the manifest, tags it, indexes it and records the audit event", async () => {
    const input = await prepareCreateRelease({ spaceId: space.id, name: "v1", note: "First release" });
    releaseV1 = input.releaseId;
    const ctx = testJobContext({ actor, spaceId: space.id });
    sync.syncSpace.mockClear();
    const res = await createReleaseHandler(input, ctx);
    expect(res).toMatchObject({ name: "v1", tag: "rel-space/v1", sourceCommit: t1, manifestPath: "releases/rel-space/v1.json", assetCount: 6, pushed: false, resumed: false });
    expect(ctx.progressCalls.at(-1)).toEqual([1, "Release created"]);
    // The space was synced first, as the sync job does it
    expect(sync.syncSpace).toHaveBeenCalledTimes(1);
    expect(sync.syncSpace.mock.calls[0]![0]).toBe(space.id);
    expect(ctx.progressCalls.map(([, m]) => m)).toContain("Syncing the space");

    expect(await repo.tags()).toContain("rel-space/v1");
    const [tagged] = await repo.log({ ref: "refs/tags/rel-space/v1", maxCount: 1 });
    expect(tagged).toMatchObject({ hash: res.commit, authorEmail: actor.email, message: "Release v1 of rel-space" });
    expect(tagged!.trailers[RELEASE_TRAILERS.releaseId]).toBe(input.releaseId);
    expect(tagged!.trailers[RELEASE_TRAILERS.sourceCommit]).toBe(t1);

    const committed = await repo.show(res.commit, res.manifestPath);
    const manifest = parseManifest(committed)!;
    expect(manifest.sourceCommit).toBe(t1);
    expect(manifest.release).toMatchObject({ id: input.releaseId, name: "v1", createdBy: actor.email, note: "First release", planId: null });
    expect(manifest.assets.map((a) => [a.assetType, a.key, a.serviceVersion])).toEqual([
      ["agents_md", "GENERIC", 1],
      ["custom_agent", "oncall", 1],
      ["memory", "runbooks/db/failover", 1],
      ["memory_store", "runbooks", 1],
      ["skill", "big", 1],
      ["skill", "triage", 1],
    ]);

    const [row] = await db().select().from(releases).where(eq(releases.id, input.releaseId));
    expect(row).toMatchObject({ name: "v1", tag: "rel-space/v1", commit: res.commit, sourceCommit: t1, assetCount: 6, note: "First release", createdBy: actor.email });
    expect(row!.manifest).toEqual(manifest);
    const audits = await db().select().from(auditEvents).where(eq(auditEvents.action, "release.create"));
    expect(audits).toEqual([expect.objectContaining({ actorEmail: actor.email, spaceId: space.id, targetId: input.releaseId, result: "ok" })]);

    // A retried job is a no-op
    const again = await createReleaseHandler(input, testJobContext({ actor, spaceId: space.id }));
    expect(again).toMatchObject({ commit: res.commit, resumed: true });
    expect((await repo.log({ path: res.manifestPath })).length).toBe(1);
  });

  it("refuses duplicate and invalid names, also when they differ only in case", async () => {
    await expect(prepareCreateRelease({ spaceId: space.id, name: "V1" })).rejects.toMatchObject({ fieldErrors: { name: "A release named V1 already exists in this space." } });
    await expect(prepareCreateRelease({ spaceId: space.id, name: "a/b" })).rejects.toBeInstanceOf(ReleaseError);
    await expect(prepareCreateRelease({ spaceId: space.id, name: "v2", commit: "abcdef1" })).rejects.toMatchObject({ fieldErrors: { commit: "The history repository has no commit abcdef1." } });
    expect(await checkReleaseNameForSpace(space.id, "v1")).toMatchObject({ ok: false });
    expect(await checkReleaseNameForSpace(space.id, "v2")).toEqual({ ok: true });

    // The job checks again: a tag made by another release
    const other = { spaceId: space.id, name: "v1", note: null, commit: null, planId: null, releaseId: "33333333-3333-4333-8333-333333333333" };
    await expect(createReleaseHandler(other, testJobContext({ actor, spaceId: space.id }))).rejects.toThrow(/already exists in the history repository/);
    const errors = await db().select().from(auditEvents).where(eq(auditEvents.result, "error"));
    expect(errors).toEqual([expect.objectContaining({ action: "release.create", targetId: other.releaseId })]);
  });

  it("doesn't create the release when the sync before it fails", async () => {
    const input = await prepareCreateRelease({ spaceId: space.id, name: "v1-unsynced" });
    const headBefore = await repo.head();
    sync.syncSpace.mockRejectedValueOnce(new Error("ListAssets timed out"));
    await expect(createReleaseHandler(input, testJobContext({ actor, spaceId: space.id }))).rejects.toThrow(
      "The release wasn't created because the sync of the space failed: ListAssets timed out",
    );
    expect(await repo.head()).toBe(headBefore);
    expect(await repo.tags()).not.toContain("rel-space/v1-unsynced");
    expect(await db().select().from(releases).where(eq(releases.id, input.releaseId))).toEqual([]);
    const [audit] = await db().select().from(auditEvents).where(eq(auditEvents.targetId, input.releaseId));
    expect(audit).toMatchObject({ action: "release.create", result: "error" });
  });

  it("finishes a release whose earlier attempt committed but failed to tag", async () => {
    const input = await prepareCreateRelease({ spaceId: space.id, name: "v1.1" });
    vi.spyOn(HistoryRepo.prototype, "tag").mockRejectedValueOnce(new Error("tag failed"));
    await expect(createReleaseHandler(input, testJobContext({ actor, spaceId: space.id }))).rejects.toThrow("tag failed");
    expect(await repo.tags()).not.toContain("rel-space/v1.1");
    const res = await createReleaseHandler(input, testJobContext({ actor, spaceId: space.id }));
    expect(res).toMatchObject({ resumed: true, tag: "rel-space/v1.1" });
    expect(await repo.tags()).toContain("rel-space/v1.1");
    expect((await repo.log({ path: "releases/rel-space/v1.1.json" })).length).toBe(1);
  });
});

describe("after changes since the release", () => {
  beforeAll(async () => {
    commits.set("memory@2", (await commitVersion(repo, layout, ALIAS, memoryV2, v1.memory)).commit);
    await commitDelete(repo, layout, ALIAS, v1.triage, "2026-11-01T02:00:00.000Z");
    await commitVersion(repo, layout, ALIAS, agentV2, v1.agent);
    await commitVersion(repo, layout, ALIAS, v1.newSkill);
    await commitVersion(repo, layout, ALIAS, genericV2, v1.generic);

    await index(v1.store);
    // Live has version 3 of the memory; git has version 2 (pending sync)
    await index(memoryV2, { liveVersion: 3, liveUpdatedAt: new Date("2026-11-02T00:00:00.000Z") });
    await index(v1.triage, { deletedAt: new Date("2026-11-01T02:00:00.000Z") });
    await index(v1.big);
    await index(agentV2);
    await index(v1.newSkill);
    await index(genericV2);
    await db()
      .insert(assetChanges)
      .values([
        { spaceId: space.id, assetId: ID.memory, serviceVersion: 1, serviceUpdatedAt: new Date(v1.memory.updatedAt), changeKind: "baseline", commit: commits.get("memory@1")!, gitPath: dirOf(layout, ALIAS, v1.memory) },
        { spaceId: space.id, assetId: ID.memory, serviceVersion: 2, serviceUpdatedAt: new Date(memoryV2.updatedAt), changeKind: "content", commit: commits.get("memory@2")!, gitPath: dirOf(layout, ALIAS, memoryV2) },
      ]);
  });

  it("tags an older commit (tag after apply) with a manifest of that commit", async () => {
    const input = await prepareCreateRelease({ spaceId: space.id, name: "v1-applied", commit: t1.slice(0, 12), planId: "plan-123" });
    expect(input.commit).toBe(t1);
    sync.syncSpace.mockClear();
    const res = await createReleaseHandler(input, testJobContext({ actor, spaceId: space.id }));
    expect(res.sourceCommit).toBe(t1);
    // A given commit is pinned as it is: no sync first
    expect(sync.syncSpace).not.toHaveBeenCalled();
    expect(res.commit).toBe(await repo.head());
    const [row] = await db().select().from(releases).where(eq(releases.id, input.releaseId));
    expect(row).toMatchObject({ planId: "plan-123", assetCount: 6 });
    const [tagged] = await repo.log({ ref: "refs/tags/rel-space/v1-applied", maxCount: 1 });
    expect(tagged!.trailers["Plan-Id"]).toBe("plan-123");
  });

  it("lists releases and shows a release's manifest with drift against the index", async () => {
    const list = await loadReleaseList(space);
    expect(list.releases.map((r) => r.name).sort()).toEqual(["v1", "v1-applied", "v1.1"]);
    expect(list.repo).toMatchObject({ ok: true });
    expect(list.nameRule.hint).toBe(policy.releases.name.hint);

    const detail = (await loadReleaseDetail(space, releaseV1))!;
    expect(detail.tagPresent).toBe(true);
    expect(detail.drift.counts).toEqual({ added: 1, removed: 1, content: 3, metadata: 0, unchanged: 2 });
    const drift = Object.fromEntries(detail.rows.map((r) => [r.key, r.drift]));
    expect(drift).toEqual({ GENERIC: "content", oncall: "content", "runbooks/db/failover": "content", runbooks: "unchanged", big: "unchanged", triage: "removed" });
    expect(detail.rows.find((r) => r.key === "runbooks/db/failover")).toMatchObject({ pendingSync: true, currentVersion: 3 });
    expect(detail.drift.entries.find((e) => e.kind === "added")).toMatchObject({ key: "new-skill" });
    // The custom agent's version differs, so its HEAD content hash was read
    expect(detail.drift.entries.find((e) => e.key === "oncall")).toMatchObject({ contentByVersion: false });
    expect(await loadReleaseDetail(space, "44444444-4444-4444-8444-444444444444")).toBeNull();

    const cmp = (await loadReleaseCompare(space, releaseV1, list.releases.find((r) => r.name === "v1-applied")!.id))!;
    expect(cmp.diff.counts).toEqual({ added: 0, removed: 0, content: 0, metadata: 0, unchanged: 6 });
  });

  it("plans a rollback to the release", async () => {
    await serviceHas(v1.big, { "SKILL.md": v1.big.files["SKILL.md"]!, "assets/icon.png": ICON, "assets/big.bin": BIG });
    const createPlan = planMock();
    const res = await createRollbackPlan({ spaceId: space.id, target: { kind: "release", releaseId: releaseV1 }, reason: "Back to v1" }, actor, { client, createPlan });
    expect(res).toMatchObject({ planId: "11111111-1111-4111-8111-111111111111", title: "Restore rel-space to release v1" });
    expect(res.counts).toEqual({ update: 5, create: 1, deactivate: 1, delete: 0, keep: 0, skip: 0 });
    expect(createPlan).toHaveBeenCalledTimes(1);
    const [input, planActor] = createPlan.mock.calls[0]!;
    expect(planActor).toEqual({ email: actor.email });
    expect(input).toMatchObject({ spaceId: space.id, origin: { kind: "rollback", target: { kind: "release", releaseId: releaseV1, name: "v1" } }, reason: "Back to v1" });
    expect(input.deletes).toBeUndefined();
    expect(input.items.map((i) => i.desired.assetType)).toEqual(["agents_md", "skill", "skill", "skill", "memory_store", "memory", "custom_agent"]);

    // Deleted since the release: created again, and the custom agent names it
    const triage = itemFor(input, "triage");
    expect(triage.desired.assetId).toBeUndefined();
    expect(triage.desired.files).toEqual([{ path: "SKILL.md", encoding: "utf8", content: v1.triage.files["SKILL.md"] }]);
    const agent = itemFor(input, ID.agent);
    expect(agent.desired.metadata).toEqual({ name: "oncall", skills: [ID.big], memory_stores: [ID.store] });
    expect(agent.desired.refs).toEqual({ skills: ["triage", "big"], memoryStores: ["runbooks"] });
    expect(agent.removeMetadataKeys).toEqual(["tools"]);
    expect(agent.desired.files).toEqual([{ path: "AGENT.md", encoding: "utf8", content: "On call v1\n" }]);

    // Binary files come from git byte for byte; the uncommitted one from the service
    const big = itemFor(input, ID.big);
    expect(big.desired.files.find((f) => f.path === "assets/icon.png")).toEqual({ path: "assets/icon.png", encoding: "base64", content: ICON.toString("base64") });
    expect(big.desired.files.find((f) => f.path === "assets/big.bin")).toEqual({ path: "assets/big.bin", encoding: "base64", content: BIG.toString("base64") });
    expect(big.note).toContain("assets/big.bin");
    expect(aws.commandCalls(GetAssetContentCommand)).toHaveLength(1);
    expect(aws.commandCalls(GetAssetContentCommand)[0]!.args[0].input).toMatchObject({ assetId: ID.big, assetVersion: 1 });

    // Added after the release: set Inactive from its current files, guarded by its base version
    const added = itemFor(input, ID.newSkill);
    expect(added).toMatchObject({ baseVersion: 1, baseUpdatedAt: v1.newSkill.updatedAt });
    expect(added.desired.metadata.status).toBe("INACTIVE");
    expect(itemFor(input, ID.memory).desired.files[0]!.content).toBe("Failover v1\n");

    const audits = await db().select().from(auditEvents).where(eq(auditEvents.action, "rollback.plan"));
    expect(audits).toEqual([expect.objectContaining({ actorEmail: actor.email, spaceId: space.id, targetId: res.planId, result: "ok" })]);
  });

  it("refuses a rollback when a file is in neither git nor the service", async () => {
    aws.on(GetAssetCommand).rejects(Object.assign(new Error("gone"), { name: "ResourceNotFoundException" }));
    const createPlan = planMock();
    await expect(createRollbackPlan({ spaceId: space.id, target: { kind: "release", releaseId: releaseV1 } }, actor, { client, createPlan })).rejects.toMatchObject({
      problems: [expect.objectContaining({ code: "rollback.content-missing", assetKey: "skill:big" })],
    });
    expect(createPlan).not.toHaveBeenCalled();
    const preview = await loadRollbackPreview(space, { kind: "release", releaseId: releaseV1 }, actor, { client });
    expect(preview).toMatchObject({ ok: true, preview: { blocked: true, itemCount: 6 } });
  });

  it("plans a rollback to a commit", async () => {
    await serviceHas(v1.big, { "assets/big.bin": BIG });
    const createPlan = planMock();
    await createRollbackPlan({ spaceId: space.id, target: { kind: "commit", commit: t1.slice(0, 10) } }, actor, { client, createPlan });
    const [input] = createPlan.mock.calls[0]!;
    expect(input.origin).toEqual({ kind: "rollback", target: { kind: "commit", commit: t1 } });
    expect(input.title).toBe(`Restore rel-space to commit ${t1.slice(0, 12)}`);
    expect(input.items).toHaveLength(7);
    await expect(createRollbackPlan({ spaceId: space.id, target: { kind: "commit", commit: "0000000000" } }, actor, { client, createPlan })).rejects.toThrow(/no commit/);
  });

  it("plans a rollback of one asset version from git, or from the service when git doesn't have it", async () => {
    const createPlan = planMock();
    await createRollbackPlan({ spaceId: space.id, target: { kind: "version", assetId: ID.memory, version: 1 } }, actor, { client, createPlan });
    const [fromGit] = createPlan.mock.calls[0]!;
    expect(fromGit.title).toBe("Restore db/failover to v1");
    expect(fromGit.origin).toEqual({ kind: "rollback", target: { kind: "version", assetId: ID.memory, version: 1 } });
    expect(fromGit.items).toHaveLength(1);
    expect(fromGit.items[0]!.desired).toMatchObject({ assetId: ID.memory, refs: { memoryStore: "runbooks" }, files: [{ path: "failover.md", content: "Failover v1\n" }] });
    expect(aws.commandCalls(GetAssetCommand)).toHaveLength(0);

    const memoryV3: TestAsset = { ...memoryV2, version: 3, files: { "failover.md": "Failover v3\n" } };
    await serviceHas(memoryV3, memoryV3.files);
    const preview = await loadRollbackPreview(space, { kind: "version", assetId: ID.memory, version: 3 }, actor, { client });
    expect(preview.ok && preview.preview.rows).toEqual([expect.objectContaining({ action: "update", fetchedPaths: ["failover.md"], expected: "unchanged" })]);
    expect(preview.ok && preview.preview.sourceCommit).toBeNull();

    aws.on(GetAssetCommand, { assetId: ID.triage, assetVersion: 9 }).rejects(Object.assign(new Error("gone"), { name: "ResourceNotFoundException" }));
    expect(await loadRollbackPreview(space, { kind: "version", assetId: ID.triage, version: 9 }, actor, { client })).toMatchObject({
      ok: false,
      message: "Version 9 of triage is not in the history repository, and the service doesn't have it.",
    });
  });
});
