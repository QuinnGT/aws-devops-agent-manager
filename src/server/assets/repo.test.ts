import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRAILERS } from "@/lib/assets/types";
import { HistoryRepo } from "@/server/git/history-repo";
import { getAppPolicy } from "@/server/policy";
import { apiFixture } from "../../../test/helpers/fixtures";
import { diffAssetVersions } from "./diff";
import { mergeAssetHistory, type LiveVersion } from "./history";
import { isSafeAssetFilePath, listAssetCommits, openExistingHistoryRepo, parseAssetJson, readCommittedAsset, readCommittedFile, readNotes } from "./repo";
import { buildHistoryFixture, fixtureAssets, fixtureRepoConfig, IDS, useTempDataDir, type BuiltFixture } from "./test-support/history-fixture";

const policy = getAppPolicy().policy;
const layout = policy.historyLayout;
let tmp: Awaited<ReturnType<typeof useTempDataDir>>;
let repo: HistoryRepo;
let built: BuiltFixture;

const commitOf = (assetId: string, version: number, updatedAt?: string) =>
  built.byAsset.get(assetId)!.find((c) => c.version === version && (!updatedAt || c.updatedAt === updatedAt))!.commit;

beforeAll(async () => {
  tmp = await useTempDataDir();
  expect(await openExistingHistoryRepo(fixtureRepoConfig())).toBeNull();
  repo = await HistoryRepo.open(fixtureRepoConfig());
  built = await buildHistoryFixture(repo, fixtureAssets(), layout);
});
afterAll(async () => {
  await tmp.cleanup();
});

describe("history repository reads", () => {
  it("lays assets out per policy/history-layout.yaml", () => {
    expect(built.gitPaths.get(IDS.agentsMd)).toBe("spaces/test-space/agents_md/GENERIC");
    expect(built.gitPaths.get(IDS.overview)).toBe("spaces/test-space/memory/chat-tool-use-best-practices/overview");
    expect(built.gitPaths.get(IDS.testingMcp)).toBe("spaces/test-space/memory/chat-tool-use-best-practices/categories/testing-mcp-servers");
  });

  it("reads asset.json and committed files at HEAD and at an older commit", async () => {
    const dir = built.gitPaths.get(IDS.skill)!;
    const head = await readCommittedAsset(repo, dir, layout);
    expect(head?.assetJson.serviceVersion).toBe(14);
    const skillMd = apiFixture<{ file: { content: { text: string } } }>("GetAssetFile.skill").response.file.content.text;
    expect(head?.files.find((f) => f.path === "SKILL.md")?.content).toBe(skillMd);
    expect(head?.files.find((f) => f.path === "assets/diagram.png")).toMatchObject({ committed: false, content: null });
    const old = await readCommittedAsset(repo, dir, layout, commitOf(IDS.skill, 13));
    expect(old?.assetJson.serviceVersion).toBe(13);
    expect(old?.files.map((f) => f.path)).toEqual(["SKILL.md", "references/cross-region-privatelink-setup.md"]);
    expect(await readCommittedAsset(repo, "spaces/test-space/skill/missing", layout)).toBeNull();
  });

  it("reads single committed files and refuses paths outside the asset", async () => {
    const dir = built.gitPaths.get(IDS.skill)!;
    expect((await readCommittedFile(repo, dir, layout, "references/mcp-server-testing.md"))?.content).toBe("testing\n");
    expect(await readCommittedFile(repo, dir, layout, "assets/diagram.png")).toBeNull();
    expect(await readCommittedFile(repo, dir, layout, "../agents_md/GENERIC/AGENTS.md")).toBeNull();
    expect(await readCommittedFile(repo, dir, layout, "asset.json")).toBeNull();
  });

  it("lists an asset's commits newest first and drops commits of other assets", async () => {
    const dir = built.gitPaths.get(IDS.overview)!;
    const commits = await listAssetCommits(repo, dir, IDS.overview);
    expect(commits.map((c) => c.trailers[TRAILERS.serviceUpdatedAt])).toEqual([
      "2026-11-10T23:38:13.000Z",
      "2026-11-10T23:30:02.000Z",
      "2026-11-07T18:33:31.000Z",
      "2026-11-03T18:38:34.000Z",
    ]);
    expect(await listAssetCommits(repo, dir, IDS.testingMcp)).toEqual([]);
  });

  it("merges git commits with live versions from the fixture", async () => {
    const commits = await listAssetCommits(repo, built.gitPaths.get(IDS.overview)!, IDS.overview);
    const live = apiFixture<{ items: LiveVersion[] }>("ListAssetVersions.memory").response.items;
    const entries = mergeAssetHistory({ commits, changes: [], live, labels: policy.attribution.labels });
    expect(entries.slice(0, 4).map((e) => [e.version, e.state, e.source])).toEqual([
      [24, "recorded", "console"],
      [24, "superseded-in-place", "console"],
      [24, "superseded-in-place", "agent"],
      [23, "recorded", "agent"],
    ]);
    expect(entries.filter((e) => e.state === "not-synced")).toHaveLength(22);
  });

  it("diffs two recorded versions read from git", async () => {
    const dir = built.gitPaths.get(IDS.skill)!;
    const a = (await readCommittedAsset(repo, dir, layout, commitOf(IDS.skill, 13)))!;
    const b = (await readCommittedAsset(repo, dir, layout, commitOf(IDS.skill, 14)))!;
    const d = diffAssetVersions(a, b);
    expect(Object.fromEntries(d.files.map((f) => [f.path, f.status]))).toEqual({
      "SKILL.md": "modified",
      "assets/diagram.png": "added",
      "references/cross-region-privatelink-setup.md": "modified",
      "references/mcp-server-testing.md": "added",
    });
    expect(d.metadata.map((m) => m.key)).toEqual(["description"]);

    const odir = built.gitPaths.get(IDS.overview)!;
    const on = (await readCommittedAsset(repo, odir, layout, commitOf(IDS.overview, 24, "2026-11-07T18:33:31.000Z")))!;
    const off = (await readCommittedAsset(repo, odir, layout, commitOf(IDS.overview, 24, "2026-11-10T23:30:02.000Z")))!;
    const s = diffAssetVersions(on, off);
    expect(s.metadata).toEqual([{ key: "status", kind: "changed", before: "ACTIVE", after: "INACTIVE" }]);
    expect(s.files.every((f) => f.status === "unchanged")).toBe(true);
  });

  it("reads git notes under the configured notes ref", async () => {
    const c = commitOf(IDS.agentsMd, 5);
    await repo.addNote(c, "Reason: test", layout.notesRef, { author: { name: "t", email: "t@example.com" }, committer: policy.sync.committer });
    const notes = await readNotes(repo, [c, commitOf(IDS.agentsMd, 4)], layout.notesRef);
    expect([...notes.entries()]).toEqual([[c, "Reason: test"]]);
  });
});

describe("path and asset.json checks", () => {
  it("accepts only normalized relative paths", () => {
    for (const ok of ["SKILL.md", "references/x.md", "a/b/c.json"]) expect(isSafeAssetFilePath(ok)).toBe(true);
    for (const bad of ["", "/etc/passwd", "../x", "a/../../x", "a/./b", "a\\b", "a\u0000b", "a//b"]) expect(isSafeAssetFilePath(bad)).toBe(false);
  });

  it("rejects malformed asset.json", () => {
    expect(parseAssetJson(null)).toBeNull();
    expect(parseAssetJson("{not json")).toBeNull();
    expect(parseAssetJson(JSON.stringify({ assetId: "x" }))).toBeNull();
  });
});
