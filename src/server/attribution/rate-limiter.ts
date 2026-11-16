/**
 * Client-side request spacing for CloudTrail LookupEvents, which allows two
 * requests per second per account and Region; above that it returns
 * ThrottlingException. Source: CloudTrail API reference, LookupEvents
 * (https://docs.aws.amazon.com/awscloudtrail/latest/APIReference/API_LookupEvents.html).
 * The rate actually used comes from policy (attribution.lookupEvents.requestsPerSecond).
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class RateLimiter {
  private intervalMs: number;
  private nextAt = 0;

  constructor(
    requestsPerSecond: number,
    private readonly clock: Clock = systemClock,
  ) {
    this.intervalMs = RateLimiter.interval(requestsPerSecond);
  }

  private static interval(rps: number): number {
    if (!(rps > 0) || !Number.isFinite(rps)) throw new Error(`requestsPerSecond must be a positive number: ${rps}`);
    return 1000 / rps;
  }

  get requestsPerSecond(): number {
    return 1000 / this.intervalMs;
  }

  setRate(requestsPerSecond: number): void {
    this.intervalMs = RateLimiter.interval(requestsPerSecond);
  }

  /** Wait for the next slot. Slots are reserved synchronously, so concurrent callers queue in order. */
  async acquire(): Promise<void> {
    const now = this.clock.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.intervalMs;
    if (at > now) await this.clock.sleep(at - now);
  }
}

const limiters = new Map<string, RateLimiter>();

/** One limiter per account and Region per process, shared by every attribution call. */
export function limiterFor(scopeKey: string, requestsPerSecond: number): RateLimiter {
  let l = limiters.get(scopeKey);
  if (!l) {
    l = new RateLimiter(requestsPerSecond);
    limiters.set(scopeKey, l);
  } else if (l.requestsPerSecond !== requestsPerSecond) {
    l.setRate(requestsPerSecond);
  }
  return l;
}

export function resetAttributionLimitersForTests(): void {
  limiters.clear();
}
