import { DevOpsAgentClient, GetAssetCommand, ListAssetTypesCommand, ListAssetVersionsCommand } from "@aws-sdk/client-devops-agent";
import { mockClient } from "aws-sdk-client-mock";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { agentSpaces, assetChanges, assetIndex, assetReasons, auditEvents, historyRepos, syncState } from "@/server/db/schema";
import { HistoryRepo } from "@/server/git/history-repo";
import { assetDisplayName } from "@/server/history/layout";
import { testJobContext } from "@/server/jobs/registry";
import { getAppPolicy } from "@/server/policy";
import type { SpaceRow } from "@/server/spaces/queries";
import { apiFixture } from "../../../test/helpers/fixtures";
import { truncateAll } from "../../../test/helpers/db";
import { loadAssetDetail, loadAssetList } from "./browse";
import { resetLiveCachesForTests, type LiveDeps } from "./live";
import {
  assetDirectory,
  countAssetsByType,
  distinctChangeSources,
  endOfDayExclusive,
  getAssetChangeByCommit,
  getSyncState,
  latestChangeByAsset,
  listAssetChanges,
  listIndexedAssets,
  listSpaceChanges,
  reasonsForCommits,
} from "./queries";
import { addReasonHandler, prepareAddReason, ReasonError } from "./reasons";
import { loadAssetDiff, loadAssetHistory, loadSpaceTimeline } from "./timeline";
import { buildHistoryFixture, fixtureAssets, fixtureRepoConfig, IDS, SPACE_FIXTURE, TEST_ALIAS, useTempDataDir, type BuiltFixture } from "./test-support/history-fixture";

const policy = getAppPolicy().policy;
const aws = mockClient(DevOpsAgentClient);
const DELETED_ID = "ki-11111111-2222-3333-4444-555555555555";

let tmp: Awaited<ReturnType<typeof useTempDataDir>>;
let repo: HistoryRepo;
let built: BuiltFixture;
let space: SpaceRow;
let live: LiveDeps;

const commitOf = (assetId: string, version: number, updatedAt?: string) =>
  built.byAsset.get(assetId)!.find((c) => c.version === version && (!updatedAt || c.updatedAt === updatedAt))!.commit;

beforeAll(async () => {
  await truncateAll();
  tmp = await useTempDataDir();
  const cfg = fixtureRepoConfig();
  repo = await HistoryRepo.open(cfg);
  built = await buildHistoryFixture(repo, fixtureAssets(), policy.historyLayout);

  const [repoRow] = await db().insert(historyRepos).values({ name: cfg.name }).returning();
  const [spaceRow] = await db()
    .insert(agentSpaces)
    .values({ alias: TEST_ALIAS, region: SPACE_FIXTURE.region, accountId: SPACE_FIXTURE.accountId, agentSpaceId: SPACE_FIXTURE.agentSpaceId, historyRepoId: repoRow!.id })
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
  await db()
    .insert(syncState)
    .values({ spaceId: space.id, status: "ok", lastSyncCompletedAt: new Date("2026-11-11T18:00:00Z"), baselineCompletedAt: new Date("2026-11-11T17:00:00Z") });

  live = {
    client: new DevOpsAgentClient({ region: "us-west-2", credentials: { accessKeyId: "test", secretAccessKey: "test" } }),
    agentSpaceId: SPACE_FIXTURE.agentSpaceId,
    spaceId: space.id,
  };
});

beforeEach(() => {
  aws.reset();
  resetLiveCachesForTests();
});

afterAll(async () => {
  aws.restore();
  await tmp.cleanup();
});

describe("asset queries", () => {
  it("lists, counts and resolves indexed assets", async () => {
    expect(await listIndexedAssets(space.id)).toHaveLength(5);
    expect(await listIndexedAssets(space.id, { includeDeleted: true })).toHaveLength(6);
    expect((await listIndexedAssets(space.id, { assetType: "memory" })).map((a) => a.name)).toEqual(["categories/testing-mcp-servers", "overview"]);
    expect(await countAssetsByType(space.id)).toEqual({ agents_md: 1, skill: 1, memory_store: 1, memory: 2 });
    const dir = await assetDirectory(space.id);
    expect(dir.size).toBe(6);
    expect(dir.get(IDS.overview)).toMatchObject({ name: "overview", assetType: "memory", parentAssetId: IDS.store });
  });

  it("returns the latest change per asset and one asset's changes", async () => {
    const latest = await latestChangeByAsset(space.id);
    expect(latest.get(IDS.overview)).toMatchObject({ serviceVersion: 24, changeSource: "console", changeKind: "metadata" });
    expect(latest.get(IDS.overview)!.serviceUpdatedAt.toISOString()).toBe("2026-11-10T23:38:13.000Z");
    expect((await latestChangeByAsset(space.id, [IDS.skill])).size).toBe(1);
    expect((await latestChangeByAsset(space.id, [])).size).toBe(0);
    const changes = await listAssetChanges(space.id, IDS.overview);
    expect(changes.map((c) => c.serviceUpdatedAt.toISOString())).toEqual([
      "2026-11-10T23:38:13.000Z",
      "2026-11-10T23:30:02.000Z",
      "2026-11-07T18:33:31.000Z",
      "2026-11-03T18:38:34.000Z",
    ]);
    expect(await getAssetChangeByCommit(space.id, IDS.skill, commitOf(IDS.skill, 14))).toMatchObject({ serviceVersion: 14 });
    expect(await getAssetChangeByCommit(space.id, IDS.overview, commitOf(IDS.skill, 14))).toBeNull();
  });

  it("filters the space timeline by type, source and date, and pages it", async () => {
    expect((await listSpaceChanges(space.id)).rows).toHaveLength(built.commits.length);
    const memory = await listSpaceChanges(space.id, { assetType: "memory" });
    expect(memory.rows).toHaveLength(5);
    expect(memory.rows.every((r) => r.assetType === "memory")).toBe(true);
    expect((await listSpaceChanges(space.id, { source: "console" })).rows.map((r) => r.assetName)).toEqual(["overview", "overview", "GENERIC"]);
    const week = await listSpaceChanges(space.id, { from: new Date("2026-11-01T00:00:00Z"), to: endOfDayExclusive(new Date("2026-11-07T00:00:00Z")) });
    expect(week.rows.map((r) => [r.assetName, r.serviceVersion])).toEqual([
      ["categories/testing-mcp-servers", 2],
      ["overview", 24],
      ["overview", 23],
    ]);
    const p1 = await listSpaceChanges(space.id, { limit: 4 });
    const p3 = await listSpaceChanges(space.id, { limit: 4, offset: 8 });
    expect([p1.hasMore, p1.rows.length, p3.hasMore, p3.rows.length]).toEqual([true, 4, false, built.commits.length - 8]);
    expect(await distinctChangeSources(space.id)).toEqual(["agent", "console", "unknown"]);
    expect(await getSyncState(space.id)).toMatchObject({ status: "ok" });
  });
});

describe("asset browser views", () => {
  it("builds tabs from ListAssetTypes and the GENERIC instructions view with a size meter", async () => {
    aws.on(ListAssetTypesCommand).resolves(apiFixture("ListAssetTypes").response as never);
    const v = await loadAssetList(space, { live });
    expect(v.tabSource).toBe("live");
    expect(v.selectedType).toBe("agents_md");
    expect(v.tabs.find((t) => t.assetType === "memory")?.count).toBe(2);
    const generic = v.instructions![0]!;
    expect(generic).toMatchObject({ agentType: "GENERIC", primary: true });
    const agentsMd = apiFixture<{ file: { content: { text: string } } }>("GetAssetFile.agents_md").response.file.content.text;
    expect(generic.assets[0]!.content).toBe(agentsMd);
    expect(generic.assets[0]!.meter).toMatchObject({ bytes: Buffer.byteLength(agentsMd), maxBytes: policy.limits.agentsMdMaxBytes });
    expect(generic.assets[0]!.row.lastChange).toMatchObject({ source: "console", label: policy.attribution.labels.console });
  });

  it("falls back to policy asset types and groups memories by store with Managed labels", async () => {
    aws.on(ListAssetTypesCommand).rejects(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    const v = await loadAssetList(space, { assetType: "memory", live });
    expect(v.tabSource).toBe("policy");
    expect(v.liveTypesError).toMatch(/refused the request/);
    const [store] = v.memoryStores!;
    expect(store!.store).toMatchObject({ name: "chat-tool-use-best-practices", managed: { managed: true, via: "self" } });
    expect(store!.tree.map((n) => n.name)).toEqual(["categories", "overview"]);
    expect(v.rows.every((r) => r.managed.managed)).toBe(true);
  });

  it("hides deleted assets unless asked, and shows skill fields", async () => {
    const skills = await loadAssetList(space, { assetType: "skill", live: null });
    expect(skills.rows.map((r) => r.name)).toEqual(["chat-tool-use-best-practices"]);
    expect(skills.skills!.get(IDS.skill)).toMatchObject({ agentTypes: ["GENERIC"], skillType: "LEARNED", status: "ACTIVE" });
    const all = await loadAssetList(space, { assetType: "skill", includeDeleted: true, live: null });
    expect(all.rows.find((r) => r.assetId === DELETED_ID)).toMatchObject({ deleted: true, lastChange: null });
  });

  it("shows committed files with the live version and an in-sync indicator", async () => {
    aws.on(GetAssetCommand, { assetId: IDS.skill }).resolves(apiFixture("GetAsset.skill").response as never);
    const v = (await loadAssetDetail(space, IDS.skill, { live }))!;
    expect(v.syncStatus).toEqual({ kind: "in-sync", version: 14 });
    expect(v.mainFile).toBe("SKILL.md");
    expect(v.frontmatter?.data?.name).toBe("chat-tool-use-best-practices");
    expect(v.fileTree.map((n) => n.name)).toEqual(["assets", "references", "SKILL.md"]);
    expect(v.skill).toMatchObject({ agentTypes: ["GENERIC"], status: "ACTIVE" });
  });

  it("flags an asset that changed in the space after the last commit", async () => {
    const res = apiFixture<{ asset: Record<string, unknown> }>("GetAsset.memory").response;
    aws.on(GetAssetCommand, { assetId: IDS.overview }).resolves({ asset: { ...res.asset, updatedAt: "2026-11-11T09:00:00.000Z" } } as never);
    const changed = (await loadAssetDetail(space, IDS.overview, { live }))!;
    expect(changed.syncStatus.kind).toBe("metadata-changed");
    expect(changed.managed).toMatchObject({ managed: true, via: "store" });
    expect(changed.store).toEqual({ assetId: IDS.store, name: "chat-tool-use-best-practices" });

    aws.on(GetAssetCommand, { assetId: IDS.agentsMd }).rejects(Object.assign(new Error("gone"), { name: "ResourceNotFoundException" }));
    const missing = (await loadAssetDetail(space, IDS.agentsMd, { live }))!;
    expect(missing.syncStatus.kind).toBe("live-missing");
    expect(missing.meter?.level).toBeDefined();
    expect(await loadAssetDetail(space, "ki-not-indexed", { live: null })).toBeNull();
  });

  it("merges git history with ListAssetVersions and diffs two recorded versions", async () => {
    aws.on(ListAssetVersionsCommand).resolves(apiFixture("ListAssetVersions.memory").response as never);
    const h = (await loadAssetHistory(space, IDS.overview, { live }))!;
    expect(h.liveError).toBeNull();
    expect(h.entries.slice(0, 4).map((e) => [e.version, e.state, e.source, e.canAddReason])).toEqual([
      [24, "recorded", "console", true],
      [24, "superseded-in-place", "console", true],
      [24, "superseded-in-place", "agent", true],
      [23, "recorded", "agent", true],
    ]);
    expect(h.entries[0]!.principal).toMatch(/WebappAdmin/);
    expect(h.entries.filter((e) => e.state === "not-synced")).toHaveLength(22);

    const d = await loadAssetDiff(space, IDS.overview, commitOf(IDS.overview, 24, "2026-11-10T23:30:02.000Z"), commitOf(IDS.overview, 24, "2026-11-10T23:38:13.000Z"));
    expect(d.ok && d.view.diff.metadata).toEqual([{ key: "status", kind: "changed", before: "INACTIVE", after: "ACTIVE" }]);
    const foreign = await loadAssetDiff(space, IDS.overview, commitOf(IDS.skill, 13), commitOf(IDS.overview, 23));
    expect(foreign).toMatchObject({ ok: false, status: 404 });
  });
});

describe("assets.add-reason job", () => {
  const actor = { email: "alex@example.com" };

  it("validates the change before queueing", async () => {
    const commit = commitOf(IDS.overview, 24, "2026-11-10T23:30:02.000Z");
    await expect(prepareAddReason({ spaceId: space.id, assetId: IDS.skill, commit, reason: "x" })).rejects.toBeInstanceOf(ReasonError);
    await expect(prepareAddReason({ spaceId: space.id, assetId: IDS.overview, commit, reason: "x", link: "javascript:x" })).rejects.toThrow();

    const agentsCommit = commitOf(IDS.agentsMd, 5);
    const where = and(eq(assetChanges.spaceId, space.id), eq(assetChanges.commit, agentsCommit));
    await db().update(assetChanges).set({ changeSource: "app" }).where(where);
    await expect(prepareAddReason({ spaceId: space.id, assetId: IDS.agentsMd, commit: agentsCommit, reason: "x" })).rejects.toThrow(/applied through the app/);
    await db().update(assetChanges).set({ changeSource: "console" }).where(where);
  });

  it("appends a git note, indexes it, audits it, and is a no-op when retried", async () => {
    const commit = commitOf(IDS.overview, 24, "2026-11-10T23:30:02.000Z");
    const input = await prepareAddReason({ spaceId: space.id, assetId: IDS.overview, commit, reason: "Switched off for the\n\nv2 audit", link: "https://example.com/audit" });
    const ctx = testJobContext({ actor, spaceId: space.id });
    const first = await addReasonHandler(input, ctx);
    expect(first).toMatchObject({ reasonId: input.reasonId, commit, noteAdded: true, pushed: false });
    expect(ctx.progressCalls.at(-1)).toEqual([1, "Reason added"]);

    const note = await repo.note(commit, policy.historyLayout.notesRef);
    expect(note).toContain(`Reason-Id: ${input.reasonId}`);
    expect(note).toContain("Added-By: alex@example.com");

    const again = await addReasonHandler(input, testJobContext({ actor, spaceId: space.id }));
    expect(again.noteAdded).toBe(false);
    expect((await repo.note(commit, policy.historyLayout.notesRef))?.match(/Reason-Id:/g)).toHaveLength(1);
    const rows = await db().select().from(assetReasons).where(eq(assetReasons.spaceId, space.id));
    expect(rows).toEqual([expect.objectContaining({ id: input.reasonId, assetId: IDS.overview, commit, link: "https://example.com/audit", addedBy: actor.email })]);
    const audits = await db().select().from(auditEvents).where(eq(auditEvents.action, "asset.reason.add"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorEmail: actor.email, targetId: IDS.overview, spaceId: space.id });

    const h = (await loadAssetHistory(space, IDS.overview, { live: null }))!;
    const entry = h.entries.find((e) => e.commitHash === commit)!;
    expect(entry.notes).toEqual([{ reason: "Switched off for the\n\nv2 audit", link: "https://example.com/audit", addedBy: actor.email, addedAt: expect.any(String) }]);
    expect(entry.pendingReasons).toEqual([]);
    expect((await reasonsForCommits(space.id, [commit])).get(commit)).toHaveLength(1);
  });

  it("finds changes by reason on the timeline", async () => {
    const r = await listSpaceChanges(space.id, { reason: "audit" });
    expect(r.rows.map((x) => [x.assetId, x.serviceUpdatedAt.toISOString()])).toEqual([[IDS.overview, "2026-11-10T23:30:02.000Z"]]);
    expect((await listSpaceChanges(space.id, { reason: "nothing-matches" })).rows).toEqual([]);
    const t = await loadSpaceTimeline(space, { reason: "audit" });
    expect(t.rows[0]!.reasons.map((x) => x.reason)).toEqual(["Switched off for the\n\nv2 audit"]);
    expect(t.sources.map((s) => s.value)).toEqual(expect.arrayContaining(["app", "console", "agent", "unknown"]));
  });

  it("refuses a commit that belongs to another asset", async () => {
    const skillCommit = commitOf(IDS.skill, 14);
    const row = { spaceId: space.id, assetId: IDS.overview, serviceVersion: 99, serviceUpdatedAt: new Date("2026-11-11T00:00:00Z"), changeKind: "content" as const, commit: skillCommit, changeSource: "agent" };
    await db().insert(assetChanges).values(row);
    try {
      const input = await prepareAddReason({ spaceId: space.id, assetId: IDS.overview, commit: skillCommit, reason: "wrong asset" });
      await expect(addReasonHandler(input, testJobContext({ actor }))).rejects.toThrow(/not in the history repository for this asset/);
    } finally {
      await db()
        .delete(assetChanges)
        .where(and(eq(assetChanges.spaceId, space.id), eq(assetChanges.serviceVersion, 99)));
    }
  });
});
