import { describe, expect, it } from "vitest";
import { compareCommittedToLive, describeSyncStatus, stableStringify, type CommittedState } from "./sync-status";

const committed: CommittedState = { serviceVersion: 24, serviceUpdatedAt: "2026-11-07T18:33:31.000Z", metadata: { name: "overview", status: "ACTIVE" } };
const live = (version: number, updatedAt: string, metadata: Record<string, unknown> = committed.metadata) => ({ ok: true as const, asset: { version, updatedAt, metadata } });

describe("compareCommittedToLive", () => {
  it("is in sync when version, updatedAt and metadata match (key order and Z format don't count)", () => {
    expect(compareCommittedToLive(committed, live(24, "2026-11-07T18:33:31Z", { status: "ACTIVE", name: "overview" }))).toEqual({ kind: "in-sync", version: 24 });
  });

  it("flags a newer live version", () => {
    expect(compareCommittedToLive(committed, live(25, "2026-11-12T00:00:00.000Z"))).toMatchObject({ kind: "live-newer", committedVersion: 24, liveVersion: 25 });
  });

  it("flags an in-place change: same version, updatedAt moved (the Active switch)", () => {
    const s = compareCommittedToLive(committed, live(24, "2026-11-10T23:38:13.000Z"));
    expect(s).toMatchObject({ kind: "metadata-changed", version: 24 });
    expect(describeSyncStatus(s).tone).toBe("warn");
    expect(compareCommittedToLive(committed, live(24, committed.serviceUpdatedAt, { name: "overview", status: "INACTIVE" })).kind).toBe("metadata-changed");
  });

  it("covers missing, unreadable and uncommitted assets", () => {
    expect(compareCommittedToLive(committed, { ok: false, notFound: true, error: "x" })).toEqual({ kind: "live-missing", committedVersion: 24 });
    expect(compareCommittedToLive(null, { ok: false, notFound: false, error: "AccessDenied" })).toEqual({ kind: "live-unavailable", error: "AccessDenied" });
    expect(compareCommittedToLive(null, live(3, "2026-01-01T00:00:00Z"))).toEqual({ kind: "not-committed", liveVersion: 3 });
    expect(compareCommittedToLive(committed, live(23, committed.serviceUpdatedAt)).kind).toBe("committed-newer");
  });

  it("describes every status in plain text without em dashes", () => {
    const all = [
      compareCommittedToLive(committed, live(24, committed.serviceUpdatedAt)),
      compareCommittedToLive(committed, live(25, committed.serviceUpdatedAt)),
      compareCommittedToLive(committed, live(24, "2026-11-10T23:38:13.000Z")),
      compareCommittedToLive(committed, live(23, committed.serviceUpdatedAt)),
      compareCommittedToLive(null, live(1, committed.serviceUpdatedAt)),
      compareCommittedToLive(committed, { ok: false, notFound: true, error: "" }),
      compareCommittedToLive(committed, { ok: false, notFound: false, error: "e" }),
    ];
    expect(new Set(all.map((s) => s.kind)).size).toBe(7);
    for (const s of all) expect(describeSyncStatus(s).text).not.toMatch(/\u2014/);
  });
});

describe("stableStringify", () => {
  it("sorts keys at every level and drops undefined", () => {
    expect(stableStringify({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"x":2,"y":1}]},"b":1}');
  });
});
