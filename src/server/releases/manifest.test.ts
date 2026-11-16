import { describe, expect, it } from "vitest";
import { assetContentHash, metadataHash } from "@/server/history/content-hash";
import { getAppPolicy } from "@/server/policy";
import { buildManifest, manifestAssets, parseManifest, selectAssets, serializeManifest, type ScannedAsset } from "./manifest";
import { assetJsonOf, dirOf, type TestAsset } from "./test-support";

const policy = getAppPolicy().policy;
const layout = policy.historyLayout;
const ALIAS = "test-space";

const store: TestAsset = {
  assetId: "ki-store",
  assetType: "memory_store",
  metadata: { name: "runbooks", description: "Runbooks", agent_types: ["GENERIC"], status: "ACTIVE" },
  version: 3,
  updatedAt: "2026-10-01T00:00:00.000Z",
  files: { "README.md": "# Runbooks\n" },
};
const memory: TestAsset = {
  assetId: "ki-memory",
  assetType: "memory",
  metadata: { status: "ACTIVE", name: "db/failover", description: "Failover", memory_store_id: "ki-store" },
  version: 7,
  updatedAt: "2026-10-02T00:00:00.000Z",
  files: { "failover.md": "Fail over.\n" },
  storeName: "runbooks",
};
const skill: TestAsset = {
  assetId: "ki-skill",
  assetType: "skill",
  metadata: { name: "triage", description: "Triage", agent_types: ["GENERIC"], status: "INACTIVE", skill_type: "USER" },
  version: 2,
  updatedAt: "2026-10-03T00:00:00.000Z",
  files: { "SKILL.md": "---\nname: triage\n---\n", "references/asset.json": "{}" },
  uncommitted: { "assets/big.bin": Buffer.alloc(16, 7) },
};

function scanned(...assets: TestAsset[]): ScannedAsset[] {
  return assets.map((a) => ({ gitPath: dirOf(layout, ALIAS, a), assetJson: assetJsonOf(a) }));
}

const release = { id: "00000000-0000-4000-8000-0000000000aa", name: "v2.3", tag: "test-space/v2.3", createdBy: "alex@example.com", createdAt: "2026-11-11T00:00:00.000Z", note: null, planId: null };
const space = { alias: ALIAS, agentSpaceId: "space-1", region: "us-west-2" };

describe("manifest entries", () => {
  it("lists ID, type, identity, name, version, hashes and metadata (status included)", () => {
    const assets = manifestAssets(scanned(skill, memory, store), policy);
    expect(assets.map((a) => [a.assetType, a.key])).toEqual([
      ["memory", "runbooks/db/failover"],
      ["memory_store", "runbooks"],
      ["skill", "triage"],
    ]);
    const s = assets.find((a) => a.assetId === "ki-skill")!;
    expect(s).toMatchObject({ name: "triage", serviceVersion: 2, serviceUpdatedAt: skill.updatedAt, gitPath: "spaces/test-space/skill/triage" });
    expect(s.metadata.status).toBe("INACTIVE");
    // The content hash covers files that were too large to commit.
    expect(s.contentHash).toBe(assetContentHash(assetJsonOf(skill).files));
    expect(s.metadataHash).toBe(metadataHash(skill.metadata));
  });

  it("is deterministic: input order and metadata key order don't change the JSON", () => {
    const a = buildManifest({ scanned: scanned(store, memory, skill), policy, space, sourceCommit: "abc", release });
    const reordered = { ...skill, metadata: Object.fromEntries(Object.entries(skill.metadata).reverse()) };
    const b = buildManifest({ scanned: scanned(reordered, memory, store), policy, space, sourceCommit: "abc", release });
    expect(serializeManifest(b)).toBe(serializeManifest(a));
    expect(serializeManifest(a).endsWith("}\n")).toBe(true);
    expect(parseManifest(serializeManifest(a))).toEqual(JSON.parse(serializeManifest(a)));
    expect(parseManifest({ format: 2 })).toBeNull();
    expect(parseManifest("not json")).toBeNull();
  });
});

describe("selecting asset.json files", () => {
  it("skips an asset.json that is a committed file of another asset, invalid files and duplicates", () => {
    const skillDir = dirOf(layout, ALIAS, skill);
    const candidates = [
      { path: `${skillDir}/references/asset.json`, text: JSON.stringify(assetJsonOf(store)) },
      { path: `${skillDir}/asset.json`, text: JSON.stringify(assetJsonOf(skill)) },
      { path: "spaces/test-space/memory_store/broken/asset.json", text: "{" },
      { path: `${dirOf(layout, ALIAS, store)}/asset.json`, text: JSON.stringify(assetJsonOf(store)) },
      { path: "spaces/test-space/memory_store/zz-copy/asset.json", text: JSON.stringify(assetJsonOf(store)) },
    ];
    const { assets, problems } = selectAssets(candidates);
    expect(assets.map((a) => a.gitPath)).toEqual([dirOf(layout, ALIAS, store), skillDir]);
    expect(problems.map((p) => p.code)).toEqual(["manifest.asset-json-invalid", "manifest.asset-duplicate"]);
  });
});
