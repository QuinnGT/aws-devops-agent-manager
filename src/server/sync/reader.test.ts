import { DevOpsAgentClient } from "@aws-sdk/client-devops-agent";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { apiFixture } from "../../../test/helpers/fixtures";
import { sha256Hex } from "./content";
import { planDelete, planMove, planWrite } from "./writer";
import { AssetGoneError, SpaceReader, unzipAssetContent } from "./reader";
import { fixtureSpace, type FakeSpace, skillZipFixture, TEST_SPACE_ID, versionMarker } from "./testing/fake-space";

const SKILL = "ki-6e6624f9-cca2-4545-8c89-3519caa36a0f";
const OVERVIEW = "ki-9184fa09-8e79-4a11-90fa-a6b81ab5fe6b";

function reader(zipMinFiles = 3) {
  return new SpaceReader(new DevOpsAgentClient({ region: "us-west-2", credentials: { accessKeyId: "test", secretAccessKey: "test" } }), {
    agentSpaceId: TEST_SPACE_ID,
    pageSize: 100,
    versionsPageSize: 50,
    concurrency: 4,
    zipMinFiles,
    maxCommittedFileBytes: 5 * 1024 * 1024,
  });
}

describe("SpaceReader against the fake test space", () => {
  let fake: FakeSpace;
  afterEach(() => fake?.restore());

  it("lists every asset across pages and filters by updatedAfter", async () => {
    fake = await fixtureSpace();
    fake.install();
    const all = await reader().listAssets();
    expect(all).toHaveLength(20);
    expect(fake.callsOf("ListAssets")).toHaveLength(3);
    const recent = await reader().listAssets(new Date("2026-11-07T18:33:32.000Z"));
    expect(recent.map((a) => a.assetId)).toContain(OVERVIEW);
    expect(recent.every((a) => a.updatedAt >= new Date("2026-11-07T18:33:32.000Z"))).toBe(true);
    expect(all.find((a) => a.assetId === OVERVIEW)).toMatchObject({ assetType: "memory", version: 24, metadata: { name: "overview" } });
  });

  it("reads all versions oldest first across pages", async () => {
    fake = await fixtureSpace();
    fake.install();
    const versions = await reader().listVersions(OVERVIEW);
    expect(versions.map((v) => v.version)).toEqual(Array.from({ length: 24 }, (_, n) => n + 1));
    expect(fake.callsOf("ListAssetVersions")).toHaveLength(3);
    await expect(reader().listVersions("ki-missing")).rejects.toBeInstanceOf(AssetGoneError);
  });

  it("reads a multi-file version through GetAssetContent and a single-file version through GetAssetFile", async () => {
    fake = await fixtureSpace();
    fake.install();
    const zip = await skillZipFixture();
    const v14 = { version: 14, createdAt: new Date("2026-07-07T18:43:41.000Z"), updatedAt: new Date("2026-09-26T18:42:37.000Z") };
    const skill = await reader().snapshot({ assetId: SKILL, assetType: "skill" }, v14);
    expect(skill.files.map((f) => f.path).sort()).toEqual([...zip.keys()].sort());
    for (const f of skill.files) expect(f.sha256).toBe(sha256Hex(zip.get(f.path)!));
    expect(fake.callsOf("GetAssetContent")).toEqual([{ command: "GetAssetContent", input: { agentSpaceId: TEST_SPACE_ID, assetId: SKILL, assetVersion: 14 } }]);
    expect(fake.callsOf("GetAssetFile")).toHaveLength(0);
    expect(skill.metadata).toEqual(apiFixture<{ asset: { metadata: unknown } }>("GetAsset.skill").response.asset.metadata);

    const v1 = { version: 1, createdAt: new Date("2026-08-13T18:37:05.000Z"), updatedAt: new Date("2026-08-13T18:37:05.000Z") };
    const mem = await reader().snapshot({ assetId: OVERVIEW, assetType: "memory" }, v1);
    expect(mem).toMatchObject({ version: 1, updatedAt: "2026-08-13T18:37:05.000Z", metadata: apiFixture<{ asset: { metadata: unknown } }>("GetAsset.memory.oldVersion").response.asset.metadata });
    expect(mem.files).toHaveLength(1);
    expect(mem.files[0]).toMatchObject({ path: "overview.md", encoding: "utf8", mimeType: "text/markdown" });
    expect(mem.files[0]!.content).toContain(versionMarker(1).trim());
    expect(fake.callsOf("GetAssetFile").map((c) => c.input.assetVersion)).toEqual([1]);
  });

  it("falls back to GetAssetFile when zip reads are off", async () => {
    fake = await fixtureSpace();
    fake.install();
    const v14 = { version: 14, createdAt: new Date(), updatedAt: new Date("2026-09-26T18:42:37.000Z") };
    const skill = await reader(0).snapshot({ assetId: SKILL, assetType: "skill" }, v14);
    expect(skill.files).toHaveLength(5);
    expect(fake.callsOf("GetAssetContent")).toHaveLength(0);
    expect(fake.callsOf("GetAssetFile")).toHaveLength(5);
  });
});

describe("unzipAssetContent", () => {
  it("rejects archives with unsafe paths or symlinks", async () => {
    const ok = new JSZip();
    ok.file("SKILL.md", "x");
    expect([...(await unzipAssetContent(await ok.generateAsync({ type: "uint8array" })))!.keys()]).toEqual(["SKILL.md"]);
    const traversal = new JSZip();
    traversal.file("../evil.md", "x");
    expect(await unzipAssetContent(await traversal.generateAsync({ type: "uint8array" }))).toBeNull();
    const link = new JSZip();
    link.file("link", "SKILL.md", { unixPermissions: 0o120777 });
    expect(await unzipAssetContent(await link.generateAsync({ type: "uint8array", platform: "UNIX" }))).toBeNull();
  });
});

describe("writer plans", () => {
  const file = (p: string, content: string) => ({ path: p, sha256: sha256Hex(content), size: content.length, encoding: "utf8" as const, content });
  const snap = (name: string, files: ReturnType<typeof file>[]) => ({ assetId: "ki-1", assetType: "skill", version: 2, createdAt: "t", updatedAt: "t", metadata: { name }, files });

  it("writes asset.json and changed files, removes dropped files, and skips unchanged ones", () => {
    const first = planWrite({ snapshot: snap("a", [file("SKILL.md", "1"), file("references/x.md", "x")]), newDir: "s/skill/a", oldDir: null, previous: null, assetJsonName: "asset.json" });
    expect(first.changes.map((c) => [c.path, c.content === null])).toEqual([
      ["s/skill/a/asset.json", false],
      ["s/skill/a/SKILL.md", false],
      ["s/skill/a/references/x.md", false],
    ]);
    const second = planWrite({ snapshot: snap("a", [file("SKILL.md", "2")]), newDir: "s/skill/a", oldDir: "s/skill/a", previous: first.assetJson, assetJsonName: "asset.json" });
    expect(second.changes.map((c) => [c.path, c.content === null])).toEqual([
      ["s/skill/a/references/x.md", true],
      ["s/skill/a/asset.json", false],
      ["s/skill/a/SKILL.md", false],
    ]);
    const meta = planWrite({ snapshot: snap("a", [file("SKILL.md", "2")]), newDir: "s/skill/a", oldDir: "s/skill/a", previous: second.assetJson, assetJsonName: "asset.json" });
    expect(meta.changes.map((c) => c.path)).toEqual(["s/skill/a/asset.json"]);
  });

  it("moves every file on a rename and never commits a file named like asset.json", () => {
    const first = planWrite({ snapshot: snap("a", [file("SKILL.md", "1"), file("asset.json", "{}")]), newDir: "s/skill/a", oldDir: null, previous: null, assetJsonName: "asset.json" });
    expect(first.assetJson!.files.find((f) => f.path === "asset.json")!.committed).toBe(false);
    const moved = planWrite({ snapshot: snap("b", [file("SKILL.md", "1")]), newDir: "s/skill/b", oldDir: "s/skill/a", previous: first.assetJson, assetJsonName: "asset.json" });
    expect(moved.changes.map((c) => [c.path, c.content === null])).toEqual([
      ["s/skill/a/asset.json", true],
      ["s/skill/a/SKILL.md", true],
      ["s/skill/b/asset.json", false],
      ["s/skill/b/SKILL.md", false],
    ]);
    expect(planDelete({ oldDir: "s/skill/b", previous: moved.assetJson, assetJsonName: "asset.json" }).changes).toEqual([
      { path: "s/skill/b/asset.json", content: null },
      { path: "s/skill/b/SKILL.md", content: null },
    ]);
  });

  it("moves a memory directory with its committed bytes", async () => {
    const first = planWrite({ snapshot: snap("m", [file("m.md", "hello")]), newDir: "s/memory/old/m", oldDir: null, previous: null, assetJsonName: "asset.json" });
    const files = new Map(first.changes.map((c) => [c.path, Buffer.from(c.content as string)]));
    const changes = await planMove({ oldDir: "s/memory/old/m", newDir: "s/memory/new/m", previous: first.assetJson!, assetJsonName: "asset.json", read: async (p) => files.get(p) ?? null });
    expect(changes.map((c) => [c.path, c.content === null ? null : c.content.toString()])).toEqual([
      ["s/memory/old/m/asset.json", null],
      ["s/memory/old/m/m.md", null],
      ["s/memory/new/m/asset.json", files.get("s/memory/old/m/asset.json")!.toString()],
      ["s/memory/new/m/m.md", "hello"],
    ]);
  });
});
