import { describe, expect, it } from "vitest";
import { TRAILERS } from "@/lib/assets/types";
import { getAppPolicy } from "@/server/policy";
import { apiFixture } from "../../../test/helpers/fixtures";
import { mergeAssetHistory, resolveSource, versionKey, type HistoryChangeRow, type HistoryCommit, type LiveVersion } from "./history";

const labels = getAppPolicy().policy.attribution.labels;
const live = apiFixture<{ items: LiveVersion[] }>("ListAssetVersions.memory").response.items;

function commit(hash: string, version: number, updatedAt: string, extra: Record<string, string> = {}): HistoryCommit {
  return {
    hash,
    date: updatedAt.replace(".000Z", "Z"),
    authorName: "a",
    authorEmail: "a@x",
    message: `memory overview: version ${version}`,
    trailers: { [TRAILERS.assetId]: "ki-9184fa09-8e79-4a11-90fa-a6b81ab5fe6b", [TRAILERS.serviceVersion]: String(version), [TRAILERS.serviceUpdatedAt]: updatedAt, ...extra },
  };
}

function change(hash: string, version: number, updatedAt: string, over: Partial<HistoryChangeRow> = {}): HistoryChangeRow {
  return {
    serviceVersion: version,
    serviceUpdatedAt: new Date(updatedAt),
    changeKind: "content",
    commit: hash,
    changeSource: "agent",
    changeSourceLabel: null,
    principal: null,
    cloudTrailEventId: null,
    planId: null,
    ...over,
  };
}

describe("mergeAssetHistory", () => {
  // The test space: overview gained v24 on 11-07, then the Active switch on 11-10 moved v24's updatedAt.
  const commits = [
    commit("c24b", 24, "2026-11-10T23:38:13.000Z", { [TRAILERS.changeSource]: "console" }),
    commit("c24a", 24, "2026-11-07T18:33:31.000Z"),
    commit("c23", 23, "2026-11-03T18:38:34.000Z"),
  ];
  const changes = [
    change("c24b", 24, "2026-11-10T23:38:13.000Z", { changeKind: "metadata", changeSource: "console", principal: "DevOpsAgentRole-WebappAdmin-x/dam-alex-Admin", cloudTrailEventId: "evt-1" }),
    change("c24a", 24, "2026-11-07T18:33:31.000Z"),
    change("c23", 23, "2026-11-03T18:38:34.000Z"),
  ];

  it("matches git and live versions on version and updatedAt", () => {
    const entries = mergeAssetHistory({ commits, changes, live, labels });
    expect(entries).toHaveLength(live.length + 1);
    const [first, second, third] = entries;
    expect(first).toMatchObject({ version: 24, commitHash: "c24b", state: "recorded", inGit: true, inLive: true, source: "console", sourceLabel: labels.console, cloudTrailEventId: "evt-1" });
    // v24 as first written: git keeps the timestamp the console switch overwrote
    expect(second).toMatchObject({ version: 24, commitHash: "c24a", state: "superseded-in-place", inLive: false, source: "agent", sourceLabel: labels.agent });
    expect(third).toMatchObject({ version: 23, commitHash: "c23", state: "recorded", inLive: true });
    const rest = entries.slice(3);
    expect(rest.every((e) => e.state === "not-synced" && !e.inGit && e.inLive)).toBe(true);
    expect(rest.map((e) => e.version)).toEqual(Array.from({ length: 22 }, (_, i) => 22 - i));
  });

  it("marks recorded versions the service no longer lists, and keeps state unknown without live data", () => {
    const pruned = mergeAssetHistory({ commits, changes, live: live.filter((v) => v.version !== 23), labels });
    expect(pruned.find((e) => e.commitHash === "c23")?.state).toBe("not-held-by-service");
    const offline = mergeAssetHistory({ commits, changes, live: null, labels });
    expect(offline).toHaveLength(3);
    expect(offline.every((e) => e.inLive === null && e.state === "recorded")).toBe(true);
  });

  it("uses commit trailers when asset_changes has no row, and change rows when the commit is past the log cap", () => {
    const entries = mergeAssetHistory({
      commits: [commit("c24b", 24, "2026-11-10T23:38:13.000Z", { [TRAILERS.changeSource]: "console", [TRAILERS.principal]: "role/x" })],
      changes: [change("c23", 23, "2026-11-03T18:38:34.000Z", { changeSource: "cli", changeSourceLabel: "CLI (custom label)" })],
      live: null,
      labels,
    });
    expect(entries.map((e) => [e.commitHash, e.source, e.sourceLabel, e.principal])).toEqual([
      ["c24b", "console", labels.console, "role/x"],
      ["c23", "cli", "CLI (custom label)", null],
    ]);
    expect(entries[1]!.commit).toBeNull();
  });

  it("shows a deletion and commits without a version", () => {
    const entries = mergeAssetHistory({
      commits: [{ ...commit("del", 24, "2026-11-12T00:00:00.000Z"), trailers: {} }, commit("c24b", 24, "2026-11-10T23:38:13.000Z")],
      changes: [change("del", 24, "2026-11-12T00:00:00.000Z", { changeKind: "deleted" })],
      live: [],
      labels,
    });
    expect(entries[0]).toMatchObject({ commitHash: "del", state: "deleted", inLive: false });
    const noVersion = mergeAssetHistory({ commits: [{ ...commit("x", 1, "2026-01-01T00:00:00.000Z"), trailers: {} }], changes: [], live: [], labels });
    expect(noVersion[0]).toMatchObject({ key: "commit:x", version: null, state: "recorded", updatedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("normalizes timestamps for matching", () => {
    expect(versionKey(24, "2026-11-10T23:38:13Z")).toBe(versionKey(24, new Date("2026-11-10T23:38:13.000Z")));
  });
});

describe("resolveSource", () => {
  it("accepts a label in the Change-Source trailer", () => {
    expect(resolveSource(null, { [TRAILERS.changeSource]: labels.console }, labels)).toEqual({ source: "console", label: labels.console });
    expect(resolveSource(null, { [TRAILERS.changeSource]: "Something else" }, labels)).toEqual({ source: "unknown", label: "Something else" });
    expect(resolveSource(null, {}, labels)).toEqual({ source: "unknown", label: labels.unknown });
    expect(resolveSource({ changeSource: "bogus", changeSourceLabel: null }, null, labels)).toEqual({ source: "unknown", label: labels.unknown });
  });
});
