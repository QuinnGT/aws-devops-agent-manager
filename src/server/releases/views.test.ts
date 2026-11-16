import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { comparableFromIndex, comparableFromManifest, diffManifests, type IndexRowLike } from "./diff";
import type { ManifestAsset } from "./manifest";
import type { RollbackRow } from "./rollback-plan";
import { buildReleaseTable, connectionBlocksRelease, countAfter, groupRollbackRows, metadataKeyChanges, releaseAnchor, type ChangeRowLike, type ReleaseTableRow } from "./views";

const policy = getAppPolicy().policy;

function manifestAsset(over: Partial<ManifestAsset> & Pick<ManifestAsset, "assetId" | "name">): ManifestAsset {
  return {
    assetType: "skill",
    key: over.name,
    serviceVersion: 1,
    serviceUpdatedAt: "2026-11-01T00:00:00.000Z",
    contentHash: `c-${over.assetId}`,
    metadataHash: "m",
    metadata: { name: over.name, status: "ACTIVE" },
    gitPath: `skills/${over.name}`,
    ...over,
  };
}

function indexRow(a: ManifestAsset, over: Partial<IndexRowLike> = {}): IndexRowLike & { name: string } {
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

function change(assetId: string, at: string, source = "agent"): ChangeRowLike {
  return { assetId, serviceUpdatedAt: at, changeSource: source, changeSourceLabel: null, principal: null, attributionProvisional: false };
}

// The release: a store with one memory, four skills
const store = manifestAsset({ assetId: "store", name: "verity", assetType: "memory_store", key: "verity", metadata: { name: "verity", status: "ACTIVE" } });
const memory = manifestAsset({ assetId: "mem", name: "report", assetType: "memory", key: "verity/report", metadata: { name: "report", memory_store_id: "store", status: "ACTIVE" } });
const sample = manifestAsset({ assetId: "sample", name: "sample", metadata: { name: "sample", status: "INACTIVE" } });
const verity = manifestAsset({ assetId: "verity", name: "verity-skill", metadata: { name: "verity-skill", status: "ACTIVE" } });
const gone = manifestAsset({ assetId: "gone", name: "privatelink", serviceVersion: 3 });
const same = manifestAsset({ assetId: "same", name: "same" });
const agent = manifestAsset({ assetId: "agent", name: "oncall", assetType: "custom_agent", key: "oncall", metadata: { name: "oncall", skills: ["gone", "same"] } });
const assets = [store, memory, sample, verity, gone, same, agent];

const added = manifestAsset({ assetId: "rds", name: "rds-runbook", serviceUpdatedAt: "2026-11-05T00:00:00.000Z" });
const index = [
  indexRow(store),
  indexRow(memory, { parentAssetId: "store", liveVersion: 2, lastSyncedVersion: 2, liveUpdatedAt: "2026-11-04T00:00:00.000Z", lastSyncedUpdatedAt: "2026-11-04T00:00:00.000Z" }),
  indexRow(sample, { metadata: { name: "sample", status: "ACTIVE" } }),
  indexRow(verity, { metadata: { name: "verity-skill", status: "ACTIVE", enable_tools: true } }),
  indexRow(gone, { deletedAt: "2026-11-03T00:00:00.000Z" }),
  indexRow(same),
  indexRow(agent),
  indexRow(added),
];

function table() {
  // The memory's live version is 2 with a different hash at HEAD
  const heads = new Map([["mem", { serviceVersion: 2, contentHash: "c-mem-2" }]]);
  const drift = diffManifests(comparableFromManifest(assets), comparableFromIndex(index, policy, heads), { statusKey: "status" });
  const latest = new Map<string, ChangeRowLike>([
    ["mem", change("mem", "2026-11-04T00:00:00.000Z")],
    ["sample", change("sample", "2026-11-02T00:00:00.000Z", "console")],
    ["verity", change("verity", "2026-11-02T01:00:00.000Z", "cli")],
    ["gone", change("gone", "2026-11-03T00:00:00.000Z", "cli")],
    ["rds", change("rds", "2026-11-05T00:00:00.000Z", "cli")],
    // Last changed before the release: not shown
    ["same", change("same", "2026-10-01T00:00:00.000Z")],
  ]);
  return buildReleaseTable({ assets, drift, index, latest, policy });
}

describe("changes since a release", () => {
  it("anchors on the newest asset in the manifest and counts later changes", () => {
    const anchor = releaseAnchor([{ serviceUpdatedAt: "2026-11-01T00:00:00.000Z" }, { serviceUpdatedAt: "2026-11-03T00:00:00.000Z" }]);
    expect(anchor?.toISOString()).toBe("2026-11-03T00:00:00.000Z");
    const times = ["2026-11-02T00:00:00.000Z", "2026-11-03T00:00:00.000Z", "2026-11-04T00:00:00.000Z", "2026-11-05T00:00:00.000Z"].map((t) => Date.parse(t));
    expect(countAfter(times, anchor)).toBe(2);
    expect(countAfter(times, null)).toBe(0);
    expect(releaseAnchor([])).toBeNull();
  });
});

describe("buildReleaseTable", () => {
  it("gives each asset its change word, versions, status and last change, changed rows first", () => {
    const { rows, counts } = table();
    expect(rows.map((r) => [r.name, r.change])).toEqual([
      ["report", "content"],
      ["sample", "status"],
      ["verity-skill", "metadata"],
      ["privatelink", "removed"],
      ["rds-runbook", "added"],
      // Same change: console order of types (skills, memory stores, custom agents)
      ["same", "unchanged"],
      ["verity", "unchanged"],
      ["oncall", "unchanged"],
    ]);
    expect(counts).toEqual({ unchanged: 3, changed: 3, content: 1, status: 1, metadata: 1, removed: 1, added: 1 });

    const byName = Object.fromEntries(rows.map((r) => [r.name, r])) as Record<string, ReleaseTableRow>;
    expect(byName.report).toMatchObject({ parentName: "verity", typeLabel: policy.assetTypes.assetTypes.memory!.label, inRelease: { version: 1, status: "ACTIVE", contentHash: "c-mem" }, live: { version: 2, status: "ACTIVE" } });
    expect(byName.report!.lastChange).toMatchObject({ source: "agent", at: "2026-11-04T00:00:00.000Z" });
    expect(byName.sample).toMatchObject({ inRelease: { status: "INACTIVE" }, live: { status: "ACTIVE" }, metadataChanges: [] });
    expect(byName["verity-skill"]!.metadataChanges).toEqual([{ key: "enable_tools", change: "added" }]);
    expect(byName.privatelink).toMatchObject({ live: null, liveAssetId: null, releaseAssetId: "gone", lastChange: { source: "cli" } });
    expect(byName["rds-runbook"]).toMatchObject({ inRelease: null, releaseAssetId: null, liveAssetId: "rds", lastChange: { source: "cli" } });
    expect(byName.same!.lastChange).toBeNull();
  });

  it("names added, removed and changed metadata keys, leaving out the status key", () => {
    expect(metadataKeyChanges(["status", "tools", "old", "description"], { old: 1, description: "a", status: "ACTIVE" }, { tools: [], description: "b", status: "INACTIVE" }, "status")).toEqual([
      { key: "description", change: "changed" },
      { key: "old", change: "removed" },
      { key: "tools", change: "added" },
    ]);
  });
});

function previewRow(over: Partial<RollbackRow> & Pick<RollbackRow, "name" | "action">): RollbackRow {
  return {
    assetType: "skill",
    key: over.name,
    assetId: null,
    targetAssetId: null,
    expected: null,
    targetVersion: null,
    currentVersion: null,
    removeMetadataKeys: [],
    refs: {},
    fetchedPaths: [],
    note: null,
    ...over,
  };
}

describe("groupRollbackRows", () => {
  it("groups preview rows by what the plan does, as on the page", () => {
    const { rows: tableRows } = table();
    const rows: RollbackRow[] = [
      previewRow({ name: "report", assetType: "memory", key: "verity/report", action: "update", assetId: "mem", targetAssetId: "mem", targetVersion: 1, currentVersion: 2, expected: "changes" }),
      previewRow({ name: "sample", action: "update", assetId: "sample", targetAssetId: "sample", targetVersion: 1, currentVersion: 1, expected: "changes" }),
      previewRow({ name: "verity-skill", action: "update", assetId: "verity", targetAssetId: "verity", targetVersion: 1, currentVersion: 1, removeMetadataKeys: ["enable_tools"], note: "Removes metadata keys added after the target: enable_tools." }),
      previewRow({ name: "privatelink", action: "create", targetAssetId: "gone", targetVersion: 3, note: "Deleted since the target: created again, with a new asset ID." }),
      previewRow({ name: "rds-runbook", action: "deactivate", assetId: "rds", currentVersion: 1, note: "Added after the target: set Inactive instead of deleting." }),
      previewRow({ name: "verity", assetType: "memory_store", key: "verity", action: "skip", assetId: "store", targetAssetId: "store", targetVersion: 1, skipReason: "managed" }),
      previewRow({ name: "same", action: "update", assetId: "same", targetAssetId: "same", targetVersion: 1, currentVersion: 1, expected: "unchanged" }),
      previewRow({ name: "oncall", assetType: "custom_agent", key: "oncall", action: "update", assetId: "agent", targetAssetId: "agent", targetVersion: 1, currentVersion: 1, expected: "unchanged" }),
    ];
    const g = groupRollbackRows({ rows, table: tableRows, assets, policy });
    expect(g.groups.map((x) => [x.key, x.rows.map((r) => r.name)])).toEqual([
      ["restore-content", ["report"]],
      ["restore-status", ["sample"]],
      ["recreate", ["privatelink"]],
      ["deactivate", ["rds-runbook"]],
      ["remove-keys", ["verity-skill"]],
    ]);
    // The managed store already matches the release, so it isn't listed as left out
    expect(g.matching.map((r) => r.name)).toEqual(["verity", "same", "oncall"]);
    expect(g).toMatchObject({ changes: 5, total: 8, cantRestore: [] });

    const by = Object.fromEntries(g.groups.flatMap((x) => x.rows).map((r) => [r.name, r]));
    expect(by.report).toMatchObject({ live: { version: 2, status: "ACTIVE" }, after: { kind: "content", releaseVersion: 1, writtenAs: 3 }, parentName: "verity", lastChange: { source: "agent" } });
    expect(by.sample).toMatchObject({ after: { kind: "status", version: 1, status: "INACTIVE" } });
    expect(by["verity-skill"]).toMatchObject({ after: { kind: "keys-removed", keys: ["enable_tools"] }, note: "Removes metadata keys added after the target: enable_tools." });
    expect(by.privatelink).toMatchObject({ live: null, after: { kind: "recreate", releaseVersion: 3 }, referencedBy: ["oncall"] });
    expect(by["rds-runbook"]).toMatchObject({ live: { version: 1, status: "ACTIVE" }, after: { kind: "status", version: 1, status: "INACTIVE" }, fromRelease: false });
  });

  it("lists managed or non-editable release assets that differ from live as left out and can't restore", () => {
    const { rows: tableRows } = table();
    const rows = [
      previewRow({ name: "report", assetType: "memory", key: "verity/report", action: "skip", assetId: "mem", targetAssetId: "mem", targetVersion: 1, skipReason: "managed", note: "Managed by the service, so a rollback leaves it as it is." }),
      previewRow({ name: "rds-runbook", action: "keep", assetId: "rds", currentVersion: 1, note: "Added after the target and left as it is." }),
    ];
    const g = groupRollbackRows({ rows, table: tableRows, assets, policy });
    expect(g.groups.map((x) => [x.key, x.rows.map((r) => r.name)])).toEqual([["left-out", ["report", "rds-runbook"]]]);
    expect(g.cantRestore.map((r) => r.name)).toEqual(["report"]);
    expect(g.changes).toBe(0);
    expect(g.groups[0]!.rows[0]).toMatchObject({ after: { kind: "unchanged", version: 2 }, live: { version: 2 } });
  });
});

describe("display names in the release table", () => {
  it("names instruction files and untitled artifacts for people", () => {
    const md = manifestAsset({ assetId: "md", name: "GENERIC", assetType: "agents_md", key: "GENERIC", metadata: { agent_type: "GENERIC", status: "ACTIVE" } });
    const art = manifestAsset({ assetId: "ki-art", name: "ki-art", assetType: "artifact", key: "ki-art", metadata: { title: "Agent Space Summary Report" } });
    const both = [md, art];
    const drift = diffManifests(comparableFromManifest(both), comparableFromIndex(both.map((a) => indexRow(a)), policy, new Map()), { statusKey: "status" });
    const { rows } = buildReleaseTable({ assets: both, drift, index: both.map((a) => indexRow(a)), latest: new Map(), policy });
    expect(rows.map((r) => r.name).sort()).toEqual(["Agent Space Summary Report", "Global instructions"]);
  });
});

describe("Create release while the app can't reach the space", () => {
  const down = { status: "failed", cause: "This app has no AWS credentials for this space, so it can't reach AWS." };
  it("is disabled up front with the cause when the release would sync first", () => {
    expect(connectionBlocksRelease(down, { syncFirst: true, commit: null })).toBe(
      "A release starts with a sync, and the app can't reach the space. This app has no AWS credentials for this space, so it can't reach AWS.",
    );
    expect(connectionBlocksRelease({ status: "rejected", cause: null }, { syncFirst: true, commit: null })).toBe("A release starts with a sync, and the app can't reach the space.");
  });
  it("stays enabled when connected, unknown, for a given commit, or when releases don't sync first", () => {
    expect(connectionBlocksRelease({ status: "ok", cause: null }, { syncFirst: true, commit: null })).toBeNull();
    expect(connectionBlocksRelease({ status: "unknown", cause: null }, { syncFirst: true, commit: null })).toBeNull();
    expect(connectionBlocksRelease(down, { syncFirst: true, commit: "abcdef1" })).toBeNull();
    expect(connectionBlocksRelease(down, { syncFirst: false, commit: null })).toBeNull();
  });
});
