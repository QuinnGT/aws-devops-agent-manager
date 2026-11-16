import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { agentSpaces, assetChanges, assetIndex, historyRepos, syncState } from "@/server/db/schema";
import { HistoryRepo } from "@/server/git/history-repo";
import { assetDisplayName } from "@/server/history/layout";
import { getAppPolicy } from "@/server/policy";
import type { SpaceRow } from "@/server/spaces/queries";
import { truncateAll } from "../../../test/helpers/db";
import { loadAssetPage } from "./asset-page";
import { loadAssetSections, loadStoreMemories } from "./sections";
import { buildHistoryFixture, fixtureAssets, fixtureRepoConfig, IDS, SPACE_FIXTURE, useTempDataDir, type BuiltFixture } from "./test-support/history-fixture";

/** The page loaders (asset list sections and the asset page) against a test database and a temp history repository. */

const policy = getAppPolicy().policy;
const DELETED_ID = "ki-11111111-2222-3333-4444-555555555555";

let tmp: Awaited<ReturnType<typeof useTempDataDir>>;
let built: BuiltFixture;
let space: SpaceRow;

beforeAll(async () => {
  await truncateAll();
  tmp = await useTempDataDir();
  const cfg = fixtureRepoConfig();
  const repo = await HistoryRepo.open(cfg);
  built = await buildHistoryFixture(repo, fixtureAssets(), policy.historyLayout);
  const [repoRow] = await db().insert(historyRepos).values({ name: cfg.name }).returning();
  const [spaceRow] = await db()
    .insert(agentSpaces)
    .values({ alias: "pages-space", region: SPACE_FIXTURE.region, accountId: SPACE_FIXTURE.accountId, agentSpaceId: SPACE_FIXTURE.agentSpaceId, historyRepoId: repoRow!.id })
    .returning();
  space = spaceRow!;
  for (const a of fixtureAssets()) {
    const last = a.versions.at(-1)!;
    await db()
      .insert(assetIndex)
      .values({
        spaceId: space.id,
        assetId: a.assetId,
        assetType: a.assetType,
        name: assetDisplayName(policy.historyLayout, { assetId: a.assetId, assetType: a.assetType, metadata: last.metadata }),
        parentAssetId: a.parentAssetId ?? null,
        liveVersion: last.version,
        liveUpdatedAt: new Date(last.updatedAt),
        lastSyncedVersion: last.version,
        lastSyncedUpdatedAt: new Date(last.updatedAt),
        gitPath: built.gitPaths.get(a.assetId)!,
        lastCommit: built.byAsset.get(a.assetId)!.at(-1)!.commit,
        metadata: last.metadata,
        createdAt: new Date(last.createdAt),
      });
  }
  await db()
    .insert(assetIndex)
    .values({ spaceId: space.id, assetId: DELETED_ID, assetType: "skill", name: "retired-skill", metadata: { status: "INACTIVE" }, deletedAt: new Date("2026-10-01T00:00:00Z") });
  await db()
    .insert(assetChanges)
    .values(
      built.commits.map((c) => ({
        spaceId: space.id,
        assetId: c.assetId,
        serviceVersion: c.version,
        serviceUpdatedAt: new Date(c.updatedAt),
        changeKind: c.changeKind,
        commit: c.commit,
        changeSource: c.source,
        principal: c.principal,
      })),
    );
  await db().insert(syncState).values({ spaceId: space.id, status: "ok", lastSyncCompletedAt: new Date("2026-11-11T18:00:00Z") });
});

afterAll(async () => {
  await tmp.cleanup();
});

const commitOf = (assetId: string, version: number, updatedAt?: string) =>
  built.byAsset.get(assetId)!.find((c) => c.version === version && (!updatedAt || c.updatedAt === updatedAt))!.commit;

describe("asset list sections", () => {
  it("lists types in policy order with memories under their store, deleted assets hidden", async () => {
    const v = await loadAssetSections(space);
    expect(v.sections.map((s) => [s.assetType, s.heading, s.total])).toEqual([
      ["agents_md", "Instruction files", 1],
      ["skill", "Skills", 1],
      ["memory_store", "Memory stores", 1],
      ["memory", "Memories", 2],
    ]);
    expect(v.deletedCount).toBe(1);
    const memories = v.sections.find((s) => s.assetType === "memory")!;
    expect(memories.memoryGroups!.map((g) => [g.store?.name, g.count])).toEqual([["chat-tool-use-best-practices", 2]]);
    expect(memories.rows.map((r) => r.name)).toEqual(["categories/testing-mcp-servers", "overview"]);
    expect(memories.rows[1]).toMatchObject({ version: 24, managed: { managed: true, via: "store" }, lastChange: { source: "console" } });
  });

  it("filters to one type and shows deleted assets when asked", async () => {
    const v = await loadAssetSections(space, { assetType: "skill", includeDeleted: true });
    expect(v.selectedType).toBe("skill");
    expect(v.sections).toHaveLength(1);
    expect(v.sections[0]!.rows.map((r) => [r.name, r.deleted])).toEqual([
      ["chat-tool-use-best-practices", false],
      ["retired-skill", true],
    ]);
    expect((await loadAssetSections(space, { assetType: "nope" })).selectedType).toBeNull();
  });

  it("lists a store's memories", async () => {
    expect((await loadStoreMemories(space, IDS.store, policy)).map((m) => m.name)).toEqual(["categories/testing-mcp-servers", "overview"]);
  });
});

describe("asset page", () => {
  it("loads the managed memory with its versions and the edit rules", async () => {
    const v = (await loadAssetPage(space, IDS.overview, { tab: "content" }))!;
    expect(v.points.map((p) => [p.version, p.source])).toEqual([
      [23, "agent"],
      [24, "console"],
    ]);
    expect(v.latest).toMatchObject({ version: 24, commitHash: commitOf(IDS.overview, 24, "2026-11-10T23:38:13.000Z") });
    expect(v.actions).toMatchObject({ contentLocked: null, supportsStatus: true, rules: { status: true } });
    expect(v.detail.store).toEqual({ assetId: IDS.store, name: "chat-tool-use-best-practices" });
    expect(v.viewing).toBeNull();
    expect(v.compare).toBeNull();
    expect(v.memories).toBeNull();
  });

  it("shows an older version's content from its commit", async () => {
    const v = (await loadAssetPage(space, IDS.overview, { tab: "content", version: "23" }))!;
    expect(v.viewing).toMatchObject({ version: 23 });
    expect(v.detail.committed?.files[0]?.content).toContain("Version 23 body");
    const current = (await loadAssetPage(space, IDS.overview, { tab: "content", version: "24" }))!;
    expect(current.viewing).toBeNull();
    expect((await loadAssetPage(space, IDS.overview, { tab: "content", version: "../../etc" }))!.viewing).toBeNull();
  });

  it("compares two versions oldest first and refuses versions the asset doesn't have", async () => {
    const v = (await loadAssetPage(space, IDS.overview, { tab: "versions", from: "24", to: "23" }))!;
    expect(v.compare?.ok).toBe(true);
    if (!v.compare?.ok) return;
    expect([v.compare.from.version, v.compare.to.version]).toEqual([23, 24]);
    const file = v.compare.diff.files.find((f) => f.path === "overview.md")!;
    expect(file.status).toBe("modified");
    expect(file.added).toBeGreaterThan(0);

    const inPlace = (await loadAssetPage(space, IDS.overview, { tab: "versions", from: commitOf(IDS.overview, 24, "2026-11-10T23:30:02.000Z"), to: "24" }))!;
    expect(inPlace.compare?.ok && inPlace.compare.diff.metadata).toEqual([{ key: "status", kind: "changed", before: "INACTIVE", after: "ACTIVE" }]);

    const bad = (await loadAssetPage(space, IDS.overview, { tab: "versions", from: "1", to: "24" }))!;
    expect(bad.compare).toEqual({ ok: false, message: "Pick two recorded versions of this asset." });
    const foreign = (await loadAssetPage(space, IDS.overview, { tab: "versions", from: commitOf(IDS.skill, 14), to: "24" }))!;
    expect(foreign.compare?.ok).toBe(false);
  });

  it("shows what changed in the newest version on the Metadata tab", async () => {
    const v = (await loadAssetPage(space, IDS.overview, { tab: "metadata" }))!;
    expect(v.latestChange).toMatchObject({ version: 24, diff: { metadata: [{ key: "status", before: "INACTIVE", after: "ACTIVE" }] } });
  });

  it("loads a store with its memories, an editable skill, and a deleted asset", async () => {
    const store = (await loadAssetPage(space, IDS.store, { tab: "content" }))!;
    expect(store.memories?.map((m) => m.name)).toEqual(["categories/testing-mcp-servers", "overview"]);
    // Managed memories and stores are editable by default.
    expect(store.actions.contentLocked).toBeNull();
    const skill = (await loadAssetPage(space, IDS.skill, { tab: "content" }))!;
    expect(skill.actions).toMatchObject({ typeEditable: true, contentLocked: null });
    expect(skill.cadence).toBeNull();
    const gone = (await loadAssetPage(space, DELETED_ID, { tab: "content" }))!;
    expect(gone.detail.asset.deletedAt).not.toBeNull();
    expect(gone.restoreVersion).toBeNull();
    expect(await loadAssetPage(space, "ki-not-indexed", { tab: "content" })).toBeNull();
  });
});
