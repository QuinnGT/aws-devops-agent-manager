import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { comparableFromIndex, comparableFromManifest, diffManifests, type IndexRowLike } from "@/server/releases/diff";
import type { ManifestAsset } from "@/server/releases/manifest";
import type { ChangeRowLike } from "@/server/releases/views";
import { compareLive, liveOutcomeOf } from "./live";

const policy = getAppPolicy().policy;

function asset(over: Partial<ManifestAsset> & Pick<ManifestAsset, "assetId" | "name">): ManifestAsset {
  return {
    assetType: "skill",
    key: over.name,
    serviceVersion: 3,
    serviceUpdatedAt: "2026-11-01T00:00:00.000Z",
    contentHash: `c-${over.assetId}`,
    metadataHash: "m",
    metadata: { name: over.name, status: "ACTIVE", description: `${over.name} skill` },
    gitPath: `spaces/s/skill/${over.name}`,
    ...over,
  };
}

function row(a: ManifestAsset, over: Partial<IndexRowLike> = {}): IndexRowLike & { name: string } {
  return {
    assetId: a.assetId,
    assetType: a.assetType,
    name: a.name,
    parentAssetId: null,
    metadata: a.metadata,
    liveVersion: a.serviceVersion,
    liveUpdatedAt: a.serviceUpdatedAt,
    lastSyncedVersion: a.serviceVersion,
    lastSyncedUpdatedAt: a.serviceUpdatedAt,
    deletedAt: null,
    gitPath: a.gitPath,
    ...over,
  };
}

function compare(assets: ManifestAsset[], index: (IndexRowLike & { name: string })[], heads: [string, number, string][] = [], latest: [string, ChangeRowLike][] = []) {
  const hashes = new Map(heads.map(([id, v, h]) => [id, { serviceVersion: v, contentHash: h }]));
  const drift = diffManifests(comparableFromManifest(assets), comparableFromIndex(index, policy, hashes), { statusKey: policy.releases.rollback.statusKey });
  return compareLive({ assets, drift, index, latest: new Map(latest), policy });
}

describe("check 1: the live space against a release", () => {
  const same = asset({ assetId: "ki-same", name: "same" });
  const content = asset({ assetId: "ki-content", name: "content" });
  const status = asset({ assetId: "ki-status", name: "status" });
  const meta = asset({ assetId: "ki-meta", name: "meta" });
  const gone = asset({ assetId: "ki-gone", name: "gone" });
  const bumped = asset({ assetId: "ki-bumped", name: "bumped" });
  const recreated = asset({ assetId: "ki-old", name: "recreated" });

  it("reports matches, changes with what changed, missing and added assets, changed first", () => {
    const result = compare(
      [same, content, status, meta, gone, bumped, recreated],
      [
        row(same),
        row(content, { liveVersion: 4, lastSyncedVersion: 4, liveUpdatedAt: "2026-11-05T00:00:00.000Z", lastSyncedUpdatedAt: "2026-11-05T00:00:00.000Z" }),
        row(status, { metadata: { ...status.metadata, status: "INACTIVE" } }),
        row(meta, { metadata: { ...meta.metadata, description: "edited in the console", agent_types: ["GENERIC"] } }),
        row(gone, { deletedAt: "2026-11-06T00:00:00.000Z" }),
        row(bumped, { liveVersion: 5, lastSyncedVersion: 5 }),
        row(asset({ assetId: "ki-new", name: "recreated" })),
        row(asset({ assetId: "ki-added", name: "added" })),
      ],
      // HEAD's asset.json: the content asset has new content, the bumped one the same content
      [
        ["ki-content", 4, "c-new"],
        ["ki-bumped", 5, "c-ki-bumped"],
        ["ki-new", 3, "c-ki-old"],
      ],
      [["ki-content", { assetId: "ki-content", serviceUpdatedAt: "2026-11-05T00:00:00.000Z", changeSource: "console", changeSourceLabel: "Operator Web App", principal: "alex", attributionProvisional: false }]],
    );
    const by = Object.fromEntries(result.rows.map((r) => [r.name, r]));
    expect(by.same).toMatchObject({ outcome: "matches", changes: [], newerVersion: false, lastChange: null });
    expect(by.content).toMatchObject({ outcome: "changed", changes: ["content"], newerVersion: true, release: { version: 3 }, live: { version: 4 } });
    expect(by.content!.lastChange).toMatchObject({ source: "console", principal: "alex" });
    expect(by.status).toMatchObject({ outcome: "changed", changes: ["status"], release: { status: "ACTIVE" }, live: { status: "INACTIVE" } });
    expect(by.meta).toMatchObject({ outcome: "changed", changes: ["metadata"] });
    expect(by.meta!.metadataChanges).toEqual([
      { key: "agent_types", change: "added" },
      { key: "description", change: "changed" },
    ]);
    expect(by.gone).toMatchObject({ outcome: "missing", live: null });
    // A newer version with the same content hash still matches the release
    expect(by.bumped).toMatchObject({ outcome: "matches", newerVersion: true });
    expect(by.recreated).toMatchObject({ outcome: "changed", changes: ["recreated"], release: { assetId: "ki-old" }, live: { assetId: "ki-new" }, newerVersion: false });
    expect(by.added).toMatchObject({ outcome: "added", release: null });

    expect(result.counts).toEqual({ changed: 4, missing: 1, added: 1, matches: 2 });
    expect(result.matches).toBe(false);
    expect(result.rows.map((r) => r.outcome)).toEqual(["changed", "changed", "changed", "changed", "missing", "added", "matches", "matches"]);
  });

  it("says the space matches when every asset does", () => {
    const result = compare([same], [row(same)]);
    expect(result).toMatchObject({ matches: true, counts: { matches: 1, changed: 0, missing: 0, added: 0 } });
  });

  it("names several changes on one asset", () => {
    expect(liveOutcomeOf({ kind: "content", metadataKeys: ["status", "description"], idChanged: false }, "status")).toBe("changed");
    const result = compare(
      [content],
      [row(content, { liveVersion: 4, lastSyncedVersion: 4, metadata: { ...content.metadata, status: "INACTIVE", description: "new" } })],
      [["ki-content", 4, "c-new"]],
    );
    expect(result.rows[0]!.changes).toEqual(["content", "status", "metadata"]);
    expect(result.rows[0]!.metadataChanges).toEqual([{ key: "description", change: "changed" }]);
  });

  it("flags live changes the history repository doesn't have yet", () => {
    const result = compare([same], [row(same, { liveVersion: 4 })]);
    expect(result.rows[0]).toMatchObject({ outcome: "changed", changes: ["content"], pendingSync: true });
  });
});
