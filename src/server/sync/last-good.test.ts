import { describe, expect, it } from "vitest";
import { lastGoodSyncAt, withSucceededAt } from "./last-good";

describe("last good sync", () => {
  const good = new Date("2026-11-10T21:00:00Z");
  const failedAt = new Date("2026-11-11T22:09:00Z");

  it("reads succeededAt from last_result, so a failed run doesn't move it", () => {
    const lastResult = withSucceededAt({ status: "succeeded" }, good);
    expect(lastGoodSyncAt({ status: "error", lastSyncCompletedAt: failedAt, lastResult })).toEqual(good);
    expect(lastGoodSyncAt({ status: "cancelled", lastSyncCompletedAt: failedAt, lastResult: withSucceededAt({}, lastGoodSyncAt({ status: "error", lastSyncCompletedAt: failedAt, lastResult })) })).toEqual(good);
  });

  it("falls back to the completion time only for a succeeded row written before succeededAt existed", () => {
    expect(lastGoodSyncAt({ status: "succeeded", lastSyncCompletedAt: good, lastResult: { changes: 1 } })).toEqual(good);
    expect(lastGoodSyncAt({ status: "error", lastSyncCompletedAt: failedAt, lastResult: { changes: 1 } })).toBeNull();
    expect(lastGoodSyncAt({ status: "error", lastSyncCompletedAt: failedAt, lastResult: null })).toBeNull();
    expect(lastGoodSyncAt(null)).toBeNull();
  });

  it("stores nothing when there was never a good sync", () => {
    expect(withSucceededAt({ a: 1 }, null)).toEqual({ a: 1 });
  });
});
