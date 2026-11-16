import { describe, expect, it } from "vitest";
import { applyCommitPolicy, assignKinds, type CandidateChange, detectChanges, orderChanges, resolveStorePolicy } from "./changes";

const asset = { assetId: "ki-1", assetType: "memory" };
const v = (version: number, updatedAt: string, createdAt = "2026-08-13T18:37:05.000Z") => ({ version, createdAt: new Date(createdAt), updatedAt: new Date(updatedAt) });
const none = { lastSyncedVersion: null, lastSyncedUpdatedAt: null, recorded: new Map<number, Date>() };

describe("detectChanges", () => {
  it("returns every version, oldest first, when nothing is recorded", () => {
    const out = detectChanges(asset, [v(3, "2026-09-03T00:00:00Z"), v(1, "2026-09-01T00:00:00Z"), v(2, "2026-09-02T00:00:00Z")], none);
    expect(out.map((c) => [c.version, c.newVersion])).toEqual([
      [1, true],
      [2, true],
      [3, true],
    ]);
  });

  it("returns versions newer than the last recorded one", () => {
    const recorded = new Map([[2, new Date("2026-09-02T00:00:00Z")]]);
    const out = detectChanges(asset, [v(1, "2026-09-01T00:00:00Z"), v(2, "2026-09-02T00:00:00Z"), v(3, "2026-09-03T00:00:00Z")], {
      lastSyncedVersion: 2,
      lastSyncedUpdatedAt: new Date("2026-09-02T00:00:00Z"),
      recorded,
    });
    expect(out.map((c) => c.version)).toEqual([3]);
  });

  it("detects a new updatedAt on a recorded version as a metadata change (the Active switch)", () => {
    const recorded = new Map([[24, new Date("2026-11-07T18:33:31Z")]]);
    const out = detectChanges(asset, [v(24, "2026-11-10T23:38:13Z")], { lastSyncedVersion: 24, lastSyncedUpdatedAt: new Date("2026-11-07T18:33:31Z"), recorded });
    expect(out).toEqual([expect.objectContaining({ version: 24, newVersion: false, updatedAt: new Date("2026-11-10T23:38:13Z") })]);
    expect(detectChanges(asset, [v(24, "2026-11-07T18:33:31Z")], { lastSyncedVersion: 24, lastSyncedUpdatedAt: new Date("2026-11-07T18:33:31Z"), recorded })).toEqual([]);
  });

  it("falls back to the index's last synced timestamp when the change rows are missing", () => {
    const out = detectChanges(asset, [v(5, "2026-09-05T00:00:00Z")], { lastSyncedVersion: 5, lastSyncedUpdatedAt: new Date("2026-09-04T00:00:00Z"), recorded: new Map() });
    expect(out.map((c) => [c.version, c.newVersion])).toEqual([[5, false]]);
  });

  it("does not revisit versions skipped by a daily policy", () => {
    const recorded = new Map([[3, new Date("2026-09-03T00:00:00Z")]]);
    const out = detectChanges(asset, [v(2, "2026-09-02T00:00:00Z"), v(3, "2026-09-03T00:00:00Z")], { lastSyncedVersion: 3, lastSyncedUpdatedAt: new Date("2026-09-03T00:00:00Z"), recorded });
    expect(out).toEqual([]);
  });

  it("re-adds the current version of an asset that came back after a deletion", () => {
    const recorded = new Map([[2, new Date("2026-09-02T00:00:00Z")]]);
    const out = detectChanges(asset, [v(1, "2026-09-01T00:00:00Z"), v(2, "2026-09-02T00:00:00Z")], {
      lastSyncedVersion: 2,
      lastSyncedUpdatedAt: new Date("2026-09-02T00:00:00Z"),
      recorded,
      reappeared: true,
    });
    expect(out.map((c) => [c.version, c.newVersion])).toEqual([[2, true]]);
  });
});

describe("applyCommitPolicy", () => {
  const changes: CandidateChange[] = [
    ["2026-11-01T09:00:00Z", 1],
    ["2026-11-01T15:00:00Z", 2],
    ["2026-11-02T10:00:00Z", 3],
    ["2026-11-03T08:00:00Z", 4],
    ["2026-11-03T09:00:00Z", 5],
  ].map(([t, n]) => ({ ...asset, version: n as number, createdAt: new Date("2026-11-01T09:00:00Z"), updatedAt: new Date(t as string), newVersion: true }));
  const now = new Date("2026-11-03T12:00:00Z");

  it("keeps everything for every-version and nothing for ignore", () => {
    expect(applyCommitPolicy(changes, "every-version", now)).toEqual({ commit: changes, deferred: 0 });
    expect(applyCommitPolicy(changes, "ignore", now)).toEqual({ commit: [], deferred: 0 });
  });

  it("keeps the last change of each finished UTC day and defers the current day", () => {
    const r = applyCommitPolicy(changes, "daily", now);
    expect(r.commit.map((c) => c.version)).toEqual([2, 3]);
    expect(r.deferred).toBe(2);
    expect(applyCommitPolicy(changes, "daily", new Date("2026-11-04T00:00:00Z")).commit.map((c) => c.version)).toEqual([2, 3, 5]);
  });
});

describe("assignKinds", () => {
  const c = (version: number, newVersion = true): CandidateChange => ({ ...asset, version, createdAt: new Date(0), updatedAt: new Date(version * 1000), newVersion });

  it("labels the first commit created (version 1) or baseline (later version)", () => {
    expect(assignKinds([c(1), c(2)], false).map((x) => x.kind)).toEqual(["created", "content"]);
    expect(assignKinds([c(4), c(5)], false).map((x) => x.kind)).toEqual(["baseline", "content"]);
  });

  it("labels later new versions content and in-place updates metadata", () => {
    expect(assignKinds([c(5), c(5, false)], true).map((x) => x.kind)).toEqual(["content", "metadata"]);
  });
});

describe("orderChanges", () => {
  it("orders by time across assets, then stores before memories at the same instant", () => {
    const at = (assetId: string, assetType: string, t: string, version = 1) => ({ assetId, assetType, version, updatedAt: new Date(t) });
    const out = orderChanges(
      [at("m", "memory", "2026-07-07T03:29:34Z"), at("s", "memory_store", "2026-07-07T03:29:34Z"), at("a", "skill", "2026-07-01T00:00:00Z"), at("b", "agents_md", "2026-07-08T00:00:00Z")],
      ["memory_store", "agents_md", "skill", "custom_agent", "memory"],
    );
    expect(out.map((x) => x.assetId)).toEqual(["a", "s", "m", "b"]);
  });
});

describe("resolveStorePolicy", () => {
  const policy = { defaultStoreCommitPolicy: "every-version" as const, storeCommitPolicies: { monitors: "daily" as const, other: "ignore" as const } };
  it("prefers the space setting, then the policy override, then the default", () => {
    expect(resolveStorePolicy("monitors", policy, {})).toBe("daily");
    expect(resolveStorePolicy("monitors", policy, { monitors: "every-version" })).toBe("every-version");
    expect(resolveStorePolicy("verity", policy, {})).toBe("every-version");
    expect(resolveStorePolicy(null, policy, { verity: "ignore" })).toBe("every-version");
  });
});
