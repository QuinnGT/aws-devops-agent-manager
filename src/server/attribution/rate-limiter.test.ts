import { describe, expect, it } from "vitest";
import { limiterFor, RateLimiter, resetAttributionLimitersForTests } from "./rate-limiter";
import { fakeClock } from "./test-support";

describe("RateLimiter", () => {
  it("spaces requests by 1/rate and lets the first one through at once", async () => {
    const clock = fakeClock("2026-11-11T00:00:00.000Z");
    const l = new RateLimiter(2, clock);
    const times: number[] = [];
    for (let i = 0; i < 4; i++) {
      await l.acquire();
      times.push(clock.now());
    }
    const t0 = times[0] ?? 0;
    expect(times.map((t) => t - t0)).toEqual([0, 500, 1000, 1500]);
  });

  it("reserves slots in order for concurrent callers", async () => {
    let t = 0;
    const waits: number[] = [];
    const l = new RateLimiter(1, { now: () => t, sleep: async (ms) => void waits.push(ms) });
    await Promise.all([l.acquire(), l.acquire(), l.acquire()]);
    expect(waits).toEqual([1000, 2000]);
    t = 10_000;
    await l.acquire();
    expect(waits).toEqual([1000, 2000]);
  });

  it("rejects a non-positive rate", () => {
    expect(() => new RateLimiter(0)).toThrow();
  });

  it("shares one limiter per scope key and follows rate changes", () => {
    resetAttributionLimitersForTests();
    const a = limiterFor("111122223333|us-west-2", 1);
    expect(limiterFor("111122223333|us-west-2", 1)).toBe(a);
    expect(limiterFor("111122223333|us-east-1", 1)).not.toBe(a);
    limiterFor("111122223333|us-west-2", 2);
    expect(a.requestsPerSecond).toBe(2);
    resetAttributionLimitersForTests();
  });
});
