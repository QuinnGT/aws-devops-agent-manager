import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { MANAGED_LOCK_REASON, assetActionRules } from "./edit-rules";
import type { HistoryEntry } from "./history";
import { flatten, groupMemories, orderTypes, sectionHeading } from "./sections";
import { buildPathTree } from "./tree";
import type { AssetListRow } from "./browse";
import {
  changeKindLabel,
  describeInterval,
  orderPair,
  parseAssetTab,
  previousEntry,
  resolveVersionRef,
  restorableVersion,
  shortAssetId,
  stripLabels,
  versionCadence,
  versionPoints,
  versionRef,
} from "./versions";

const policy = getAppPolicy().policy;
const hex = (n: number) => n.toString(16).padStart(40, "0");

function entry(version: number | null, updatedAt: string, over: Partial<HistoryEntry> = {}): HistoryEntry {
  const hash = over.commitHash ?? hex(Math.round(Date.parse(updatedAt) / 1000));
  return {
    key: `${version}@${updatedAt}`,
    version,
    updatedAt,
    commit: null,
    commitHash: hash,
    changeKind: "content",
    source: "agent",
    sourceLabel: "DevOps Agent",
    principal: null,
    cloudTrailEventId: null,
    planId: null,
    inGit: true,
    inLive: null,
    state: "recorded",
    ...over,
  };
}

// Newest first, as mergeAssetHistory returns them: v24 changed in place twice by the console switch.
const entries: HistoryEntry[] = [
  entry(24, "2026-11-10T23:38:13.000Z", { source: "console", changeKind: "metadata", commitHash: hex(4) }),
  entry(24, "2026-11-10T23:30:02.000Z", { source: "console", changeKind: "metadata", commitHash: hex(3) }),
  entry(24, "2026-11-07T18:33:31.000Z", { commitHash: hex(2) }),
  entry(23, "2026-11-03T18:38:34.000Z", { commitHash: hex(1) }),
];

describe("asset page tabs and version references", () => {
  it("parses the tab and falls back to content", () => {
    expect(["versions", "metadata", "files", "nope", undefined].map((t) => parseAssetTab(t))).toEqual(["versions", "metadata", "files", "content", "content"]);
  });

  it("keeps one point per version, the newest entry of a version changed in place", () => {
    const points = versionPoints(entries);
    expect(points.map((p) => [p.version, p.commit, p.source])).toEqual([
      [23, hex(1), "agent"],
      [24, hex(4), "console"],
    ]);
    expect(versionPoints([entry(5, "2026-01-01T00:00:00.000Z", { state: "deleted" }), entry(4, "2025-12-01T00:00:00.000Z", { inGit: false })])).toEqual([]);
  });

  it("resolves version numbers and the asset's own commits, and nothing else", () => {
    expect(resolveVersionRef(entries, "24")?.commitHash).toBe(hex(4));
    expect(resolveVersionRef(entries, "23")?.commitHash).toBe(hex(1));
    expect(resolveVersionRef(entries, hex(3))?.updatedAt).toBe("2026-11-10T23:30:02.000Z");
    expect(resolveVersionRef(entries, hex(3).toUpperCase())?.commitHash).toBe(hex(3));
    expect([resolveVersionRef(entries, "99"), resolveVersionRef(entries, hex(9)), resolveVersionRef(entries, "../x"), resolveVersionRef(entries, undefined)]).toEqual([null, null, null, null]);
  });

  it("writes a version number when it names the entry, else the commit", () => {
    expect(versionRef(entries, entries[0]!)).toBe("24");
    expect(versionRef(entries, entries[2]!)).toBe(hex(2));
    expect(versionRef(entries, { version: null, commitHash: hex(7) })).toBe(hex(7));
    expect(versionRef(entries, { version: 1, commitHash: null })).toBeNull();
  });

  it("finds the previous recorded entry and orders a pair oldest first", () => {
    expect(previousEntry(entries, entries[0]!)?.commitHash).toBe(hex(3));
    expect(previousEntry(entries, entries[3]!)).toBeNull();
    const withDeletion = [entry(24, "2026-11-12T00:00:00.000Z", { state: "deleted", changeKind: "deleted", commitHash: hex(5) }), ...entries];
    expect(previousEntry(withDeletion, withDeletion[1]!)?.commitHash).toBe(hex(3));
    const [a, b] = orderPair(resolveVersionRef(entries, "24")!, resolveVersionRef(entries, "23")!);
    expect([a.version, b.version]).toEqual([23, 24]);
    const [c, d] = orderPair(resolveVersionRef(entries, hex(4))!, resolveVersionRef(entries, hex(2))!);
    expect([c.commitHash, d.commitHash]).toEqual([hex(2), hex(4)]);
  });
});

describe("cadence line", () => {
  const day = 86_400_000;
  const series = (n: number, source: HistoryEntry["source"], everyDays: number) =>
    Array.from({ length: n }, (_, i) => ({ version: i + 1, source, sourceLabel: "", principal: null, at: new Date(Date.UTC(2026, 7, 1) + i * everyDays * day).toISOString(), commit: hex(i), changeKind: "content" }));

  it("names the source with five or more versions and the median interval", () => {
    const c = versionCadence([...series(22, "agent", 4), { ...series(1, "console", 1)[0]!, version: 23 }]);
    expect(c).toMatchObject({ source: "agent", count: 22 });
    expect(describeInterval(c!.medianMs)).toBe("4 days");
  });

  it("stays quiet below five versions and for unknown sources", () => {
    expect(versionCadence(series(4, "agent", 1))).toBeNull();
    expect(versionCadence(series(10, "unknown", 3))).toBeNull();
  });

  it("describes intervals in minutes, hours or days", () => {
    expect([describeInterval(60_000), describeInterval(31 * 60_000), describeInterval(3_600_000 * 2), describeInterval(day), describeInterval(3 * day)]).toEqual(["minute", "31 minutes", "2 hours", "day", "3 days"]);
  });
});

describe("strip labels, IDs and kinds", () => {
  it("labels the first, every fifth, the last and the selected versions", () => {
    const points = Array.from({ length: 24 }, (_, i) => ({ version: i + 1 }));
    expect([...stripLabels(points, [23])].sort((a, b) => a - b)).toEqual([1, 5, 10, 15, 20, 23, 24]);
  });

  it("shortens asset IDs to the prefix and first group", () => {
    expect(shortAssetId("ki-9184fa09-8e79-4a11-90fa-a6b81ab5fe6b")).toBe("ki-9184fa09");
    expect(shortAssetId("short")).toBe("short");
  });

  it("words change kinds", () => {
    expect(["created", "baseline", "content", "metadata", "deleted", null].map(changeKindLabel)).toEqual(["Created", "First recorded", "Content updated", "Status or metadata", "Deleted", "Recorded"]);
  });
});

describe("asset action rules (drafts edit rules)", () => {
  const nameOf = (type: string, id: string) => (type === "memory_store" && id === "store-1" ? "chat-tool-use-best-practices" : type === "memory_store" && id === "store-2" ? "my-notes" : undefined);

  it("keeps a memory in a managed store editable, with the Active switch", () => {
    const r = assetActionRules(policy, { assetType: "memory", metadata: { name: "overview", memory_store_id: "store-1" } }, nameOf);
    expect(r).toMatchObject({ typeEditable: true, supportsStatus: true, contentLocked: null });
    expect(r.rules).toMatchObject({ managed: true, status: true, content: true });
  });

  it("leaves other memories and skills editable", () => {
    expect(assetActionRules(policy, { assetType: "memory", metadata: { name: "x", memory_store_id: "store-2" } }, nameOf).contentLocked).toBeNull();
    expect(assetActionRules(policy, { assetType: "skill", metadata: { name: "verity" } }, nameOf)).toMatchObject({ typeEditable: true, supportsStatus: true, contentLocked: null });
  });

  it("marks types the app can't edit, and instructions without the Active switch", () => {
    expect(assetActionRules(policy, { assetType: "artifact", metadata: {} }, nameOf)).toMatchObject({ typeEditable: false, contentLocked: null });
    expect(assetActionRules(policy, { assetType: "agents_md", metadata: { agent_type: "GENERIC" } }, nameOf)).toMatchObject({ typeEditable: true, supportsStatus: false });
  });
});

describe("asset list sections", () => {
  const row = (assetId: string, name: string, parentAssetId: string | null = null, assetType = "memory"): AssetListRow => ({
    assetId,
    assetType,
    name,
    status: "ACTIVE",
    version: 1,
    updatedAt: null,
    deleted: false,
    managed: { managed: false },
    lastChange: null,
    parentAssetId,
    metadata: {},
  });

  it("orders types as policy does, unknown types last by name", () => {
    expect(orderTypes(Object.keys(policy.assetTypes.assetTypes), ["memory", "zeta", "agents_md", "artifact", "alpha", "skill"])).toEqual(["agents_md", "skill", "memory", "artifact", "alpha", "zeta"]);
  });

  it("groups memories by store name, folders first", () => {
    const stores = new Map([
      ["s-b", row("s-b", "b-store", null, "memory_store")],
      ["s-a", row("s-a", "a-store", null, "memory_store")],
    ]);
    const groups = groupMemories([row("1", "overview", "s-b"), row("2", "categories/x", "s-b"), row("3", "notes", "s-a"), row("4", "orphan", "s-gone")], stores);
    expect(groups.map((g) => [g.store?.name ?? g.storeId, g.count])).toEqual([
      ["a-store", 1],
      ["b-store", 2],
      ["s-gone", 1],
    ]);
    expect(flatten(groups[1]!.tree).map((r) => r.name)).toEqual(["categories/x", "overview"]);
    expect(flatten(buildPathTree([row("1", "a/b/c"), row("2", "a")], (r) => r.name)).map((r) => r.name)).toEqual(["a", "a/b/c"]);
  });

  it("uses the policy noun for headings", () => {
    expect([sectionHeading(policy, "memory"), sectionHeading(policy, "custom_agent"), sectionHeading(policy, "unknown_type")]).toEqual(["Memories", "Custom agents", "unknown_type"]);
  });
});

describe("Restore this version", () => {
  it("is offered on the newest entry of each older version, and on every version of a deleted asset", () => {
    expect(entries.map((e) => restorableVersion(entries, e, { deleted: false }))).toEqual([null, null, null, 23]);
    expect(entries.map((e) => restorableVersion(entries, e, { deleted: true }))).toEqual([24, null, null, 23]);
  });

  it("says plainly why a managed memory can't be restored", () => {
    expect(MANAGED_LOCK_REASON).toBe("Editing memories in managed stores is turned off in this app's plan rules. You can still switch them on or off.");
  });
});
