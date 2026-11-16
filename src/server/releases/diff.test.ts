import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { assetsNeedingContentHash, comparableFromIndex, diffManifests, type ComparableAsset, type IndexRowLike } from "./diff";

const policy = getAppPolicy().policy;

function asset(over: Partial<ComparableAsset> & Pick<ComparableAsset, "assetId">): ComparableAsset {
  return { assetType: "skill", key: over.assetId, name: over.assetId, serviceVersion: 1, contentHash: `c-${over.assetId}`, metadata: { status: "ACTIVE" }, ...over };
}

describe("diffManifests", () => {
  it("classifies added, removed, content changed, metadata only and unchanged", () => {
    const before = [
      asset({ assetId: "same" }),
      asset({ assetId: "content", contentHash: "old" }),
      asset({ assetId: "meta", metadata: { status: "ACTIVE", description: "a" } }),
      asset({ assetId: "gone" }),
    ];
    const after = [
      asset({ assetId: "same" }),
      asset({ assetId: "content", contentHash: "new", serviceVersion: 2 }),
      asset({ assetId: "meta", metadata: { status: "INACTIVE", description: "a" } }),
      asset({ assetId: "new" }),
    ];
    const d = diffManifests(before, after);
    expect(d.entries.map((e) => [e.key, e.kind])).toEqual([
      ["content", "content"],
      ["gone", "removed"],
      ["meta", "metadata"],
      ["new", "added"],
      ["same", "unchanged"],
    ]);
    expect(d.counts).toEqual({ added: 1, removed: 1, content: 1, metadata: 1, unchanged: 1 });
    const meta = d.entries.find((e) => e.key === "meta")!;
    expect(meta.metadataKeys).toEqual(["status"]);
    expect([meta.before?.status, meta.after?.status]).toEqual(["ACTIVE", "INACTIVE"]);
  });

  it("matches an asset deleted and created again under the same name", () => {
    const d = diffManifests([asset({ assetId: "old-id", key: "triage", contentHash: "h" })], [asset({ assetId: "new-id", key: "triage", contentHash: "h" })]);
    expect(d.entries).toEqual([expect.objectContaining({ kind: "unchanged", key: "triage", idChanged: true })]);
  });

  it("compares by version when a content hash is missing", () => {
    const before = [asset({ assetId: "a", serviceVersion: 3 }), asset({ assetId: "b", serviceVersion: 3 }), asset({ assetId: "c", key: "c", serviceVersion: 3 })];
    const after = [
      asset({ assetId: "a", serviceVersion: 3, contentHash: null }),
      asset({ assetId: "b", serviceVersion: 4, contentHash: null }),
      asset({ assetId: "c2", key: "c", serviceVersion: 3, contentHash: null }),
    ];
    const kinds = Object.fromEntries(diffManifests(before, after).entries.map((e) => [e.key, [e.kind, e.contentByVersion]]));
    expect(kinds).toEqual({ a: ["unchanged", true], b: ["content", true], c: ["content", true] });
  });
});

describe("drift against the index", () => {
  const row = (over: Partial<IndexRowLike> & Pick<IndexRowLike, "assetId">): IndexRowLike => ({
    assetType: "skill",
    name: over.assetId,
    parentAssetId: null,
    metadata: { name: over.assetId, status: "ACTIVE" },
    liveVersion: 1,
    liveUpdatedAt: "2026-11-01T00:00:00.000Z",
    lastSyncedVersion: 1,
    lastSyncedUpdatedAt: "2026-11-01T00:00:00.000Z",
    deletedAt: null,
    gitPath: `spaces/x/skill/${over.assetId}`,
    ...over,
  });

  it("builds identities with store names, drops deleted rows and flags pending syncs", () => {
    const rows = [
      row({ assetId: "s1", assetType: "memory_store", metadata: { name: "runbooks" } }),
      row({ assetId: "m1", assetType: "memory", name: "db/failover", metadata: { name: "db/failover", memory_store_id: "s1" }, parentAssetId: "s1" }),
      row({ assetId: "k1", liveVersion: 3, lastSyncedVersion: 2 }),
      row({ assetId: "k2", deletedAt: "2026-11-02T00:00:00.000Z" }),
    ];
    const current = comparableFromIndex(rows, policy, new Map([["k1", { serviceVersion: 2, contentHash: "h2" }]]));
    expect(current.map((c) => [c.assetId, c.key, c.contentHash, c.pendingSync])).toEqual([
      ["s1", "runbooks", null, false],
      ["m1", "runbooks/db/failover", null, false],
      // HEAD holds version 2 but live is at 3: the hash doesn't describe live
      ["k1", "k1", null, true],
    ]);
  });

  it("reads content hashes only where IDs or versions differ", () => {
    const manifest = [asset({ assetId: "a", serviceVersion: 2 }), asset({ assetId: "b", serviceVersion: 2 }), asset({ assetId: "c", key: "c" }), asset({ assetId: "d" })];
    const current = [asset({ assetId: "a", serviceVersion: 2 }), asset({ assetId: "b", serviceVersion: 5 }), asset({ assetId: "c-new", key: "c" })];
    expect(assetsNeedingContentHash(manifest, current)).toEqual(["b", "c-new"]);
  });
});
