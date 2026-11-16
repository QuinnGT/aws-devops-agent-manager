import type { CloudTrailClient } from "@aws-sdk/client-cloudtrail";
import type { Policy } from "@/server/policy";
import { parseLookupEvent, type WriteEvent } from "./events";
import { lookupAssetEvents } from "./lookup";
import { type ChangeEvidence, classify, type EventMatch, matchAssetChanges, matchRulesFromPolicy, planAssetLookup } from "./match";
import { type Clock, limiterFor, type RateLimiter, systemClock } from "./rate-limiter";
import { type AssetChangeToAttribute, type Attribution, attributionKey } from "./types";

/**
 * CONTRACT. Labels the source of one asset change. The sync module calls
 * attributeChanges once per batch.
 *
 * Every change in the batch gets an entry in the returned map. Per call,
 * each asset is looked up once (one LookupEvents search covering all of
 * that asset's changes, every page) and its events are reused for all of
 * its changes. Requests share one rate limiter per account and Region.
 */

export type { AssetChangeToAttribute, Attribution } from "./types";
export { attributionKey } from "./types";
export { principalFromUserIdentity, type PrincipalInfo } from "./identity";
export { compileGlob } from "./glob";

export interface AttributionDeps {
  cloudTrail: CloudTrailClient;
  policy: Pick<Policy, "attribution">;
  /** Look up whether a clientToken belongs to a plan item this app applied. */
  findPlanItemByClientToken?: (clientToken: string) => Promise<{ planId: string; appUser: string } | null>;
  /**
   * Account and Region of the CloudTrail client: the scope of the LookupEvents
   * rate limit. Pass the space's accountId and region. Without it, the
   * client's Region is used with a shared "default" account key.
   */
  scope?: { accountId: string; region: string };
  /** Tests: replace the shared per-scope limiter */
  limiter?: RateLimiter;
  /** Tests: clock for now and backoff sleeps */
  clock?: Clock;
}

async function scopeKey(deps: AttributionDeps): Promise<string> {
  if (deps.scope) return `${deps.scope.accountId}|${deps.scope.region}`;
  let region = "unknown-region";
  try {
    const r = deps.cloudTrail.config.region;
    region = typeof r === "function" ? await r() : String(r);
  } catch {
    // keep the fallback key
  }
  return `default|${region}`;
}

function errorReason(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 300);
  return String(err).slice(0, 300);
}

export async function attributeChanges(changes: AssetChangeToAttribute[], deps: AttributionDeps): Promise<Map<string, Attribution>> {
  const p = deps.policy.attribution;
  const clock = deps.clock ?? systemClock;
  const now = new Date(clock.now());
  const out = new Map<string, Attribution>();
  const set = (c: AssetChangeToAttribute, evidence: ChangeEvidence) => out.set(attributionKey(c), classify(c, evidence, p, now));

  if (changes.length === 0) return out;
  if (p.cloudTrailSource !== "lookup-events") {
    for (const c of changes) set(c, { kind: "unsupported-source", source: p.cloudTrailSource });
    return out;
  }

  const byAsset = new Map<string, AssetChangeToAttribute[]>();
  for (const c of changes) {
    const list = byAsset.get(c.assetId);
    if (list) list.push(c);
    else byAsset.set(c.assetId, [c]);
  }

  const limiter = deps.limiter ?? limiterFor(await scopeKey(deps), p.lookupEvents.requestsPerSecond);
  const rules = matchRulesFromPolicy(p);
  const filter = p.events;
  const planItems = new Map<string, Promise<{ planId: string; appUser: string } | null>>();
  const findPlanItem = (token: string) => {
    let hit = planItems.get(token);
    if (!hit && deps.findPlanItemByClientToken) {
      hit = deps.findPlanItemByClientToken(token);
      planItems.set(token, hit);
    }
    return hit ?? Promise.resolve(null);
  };

  for (const [assetId, assetChanges] of byAsset) {
    const plan = planAssetLookup(assetChanges, p, now);
    for (const c of plan.outOfRetention) set(c, { kind: "out-of-retention", retentionDays: p.lookupEvents.retentionDays });
    if (!plan.range) continue;

    let events: WriteEvent[];
    let complete: boolean;
    try {
      const res = await lookupAssetEvents(deps.cloudTrail, assetId, plan.range, p.lookupEvents, limiter, clock);
      complete = res.complete;
      events = [];
      for (const raw of res.events) {
        const parsed = parseLookupEvent(raw, filter);
        if (parsed.ok) events.push(parsed.event);
      }
    } catch (err) {
      const reason = errorReason(err);
      for (const c of plan.inRetention) set(c, { kind: "error", reason });
      continue;
    }

    const matches = matchAssetChanges(plan.inRetention, events, rules);
    for (const c of plan.inRetention) {
      const match: EventMatch | null = matches.get(attributionKey(c)) ?? null;
      if (!match) {
        set(c, { kind: "no-event", complete });
        continue;
      }
      try {
        const planItem = match.event.clientToken ? await findPlanItem(match.event.clientToken) : null;
        set(c, { kind: "matched", match, planItem });
      } catch (err) {
        // Without the plan lookup the app rule (first in order) cannot be ruled out.
        set(c, { kind: "error", reason: `plan item lookup failed: ${errorReason(err)}` });
      }
    }
  }
  return out;
}
