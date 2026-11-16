import type { Policy } from "@/server/policy";
import type { WriteEvent } from "./events";
import { globMatches } from "./glob";
import { type AssetChangeToAttribute, type Attribution, attributionKey } from "./types";

/**
 * Pure attribution logic: which CloudTrail write event belongs to which
 * change, and which source label follows. No I/O here; ./index does the
 * lookups and calls these functions.
 */

type AttributionPolicy = Policy["attribution"];

export interface EventMatch {
  event: WriteEvent;
  matchedBy: "exact" | "window";
}

export interface MatchRules {
  windowSeconds: number;
  creationEventNames: readonly string[];
  deletionEventNames: readonly string[];
}

export function matchRulesFromPolicy(p: AttributionPolicy): MatchRules {
  return {
    windowSeconds: p.matchWindowSeconds,
    creationEventNames: p.events.creationEventNames,
    deletionEventNames: p.events.deletionEventNames,
  };
}

const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const sameSecond = (a: Date, b: Date) => sec(a) === sec(b);

/** The timestamp a change is matched on: createdAt for creations, updatedAt otherwise. */
export function changeTime(c: AssetChangeToAttribute): Date {
  return c.changeKind === "created" ? c.serviceCreatedAt : c.serviceUpdatedAt;
}

/** The written state matches the change's version and timestamp exactly (to the second). */
export function isExactMatch(c: AssetChangeToAttribute, e: WriteEvent, rules: MatchRules): boolean {
  const w = e.written;
  if (!w || (w.assetId !== null && w.assetId !== c.assetId) || w.version !== c.serviceVersion) return false;
  if (c.changeKind === "created") {
    if (!w.createdAt || !sameSecond(w.createdAt, c.serviceCreatedAt)) return false;
    // createdAt is the asset's creation time on every version, so a later write to
    // version 1 (a status switch) also carries it. Require the creation event or an
    // updatedAt equal to the creation time.
    return rules.creationEventNames.includes(e.eventName) || (w.updatedAt !== null && sameSecond(w.updatedAt, c.serviceCreatedAt));
  }
  return w.updatedAt !== null && sameSecond(w.updatedAt, c.serviceUpdatedAt);
}

/** The event reports a different asset, version or timestamp than the change. */
export function contradicts(c: AssetChangeToAttribute, e: WriteEvent): boolean {
  const w = e.written;
  if (!w) return false;
  if (w.assetId !== null && w.assetId !== c.assetId) return true;
  if (w.version !== null && w.version !== c.serviceVersion) return true;
  if (c.changeKind === "created") {
    if (w.createdAt && !sameSecond(w.createdAt, c.serviceCreatedAt)) return true;
    return w.updatedAt !== null && !sameSecond(w.updatedAt, c.serviceCreatedAt);
  }
  return w.updatedAt !== null && !sameSecond(w.updatedAt, c.serviceUpdatedAt);
}

function preferred(c: AssetChangeToAttribute, e: WriteEvent, rules: MatchRules): boolean {
  if (c.changeKind === "created") return rules.creationEventNames.includes(e.eventName);
  return !rules.creationEventNames.includes(e.eventName) && !rules.deletionEventNames.includes(e.eventName);
}

/** Preferred event names first, then closest to the change's timestamp, then earliest. */
function best(c: AssetChangeToAttribute, events: WriteEvent[], rules: MatchRules): WriteEvent | null {
  const t = changeTime(c).getTime();
  let top: WriteEvent | null = null;
  let topKey: [number, number, number] | null = null;
  for (const e of events) {
    const key: [number, number, number] = [preferred(c, e, rules) ? 0 : 1, Math.abs(e.eventTime.getTime() - t), e.eventTime.getTime()];
    if (!topKey || key[0] < topKey[0] || (key[0] === topKey[0] && (key[1] < topKey[1] || (key[1] === topKey[1] && key[2] < topKey[2])))) {
      top = e;
      topKey = key;
    }
  }
  return top;
}

/**
 * Match one asset's changes to that asset's write events.
 *
 * 1. Deletions: a deletion event at or after the last recorded update
 *    (minus the window). An asset ID is deleted once, so this counts as exact.
 * 2. Exact: version and updatedAt (createdAt for creations) from responseElements.
 * 3. Window: only for changes without an exact match, the closest event
 *    within matchWindowSeconds that no other change claimed and whose
 *    responseElements do not contradict the change.
 */
export function matchAssetChanges(changes: readonly AssetChangeToAttribute[], events: readonly WriteEvent[], rules: MatchRules): Map<string, EventMatch | null> {
  const out = new Map<string, EventMatch | null>();
  const claimed = new Set<string>();
  const windowMs = rules.windowSeconds * 1000;
  const pending: AssetChangeToAttribute[] = [];

  for (const c of changes) {
    const key = attributionKey(c);
    if (c.changeKind === "deleted") {
      const from = c.serviceUpdatedAt.getTime() - windowMs;
      const dels = events.filter((e) => rules.deletionEventNames.includes(e.eventName) && e.eventTime.getTime() >= from && !contradictsDeletion(c, e));
      const e = dels.sort((a, b) => a.eventTime.getTime() - b.eventTime.getTime())[0];
      out.set(key, e ? { event: e, matchedBy: "exact" } : null);
      if (e) claimed.add(e.eventId);
      continue;
    }
    const e = best(
      c,
      events.filter((ev) => isExactMatch(c, ev, rules)),
      rules,
    );
    if (e) {
      out.set(key, { event: e, matchedBy: "exact" });
      claimed.add(e.eventId);
    } else {
      pending.push(c);
    }
  }

  pending.sort((a, b) => changeTime(a).getTime() - changeTime(b).getTime());
  for (const c of pending) {
    const t = changeTime(c).getTime();
    const candidates = events.filter(
      (e) => !claimed.has(e.eventId) && !rules.deletionEventNames.includes(e.eventName) && Math.abs(e.eventTime.getTime() - t) <= windowMs && !contradicts(c, e),
    );
    const e = best(c, candidates, rules);
    out.set(attributionKey(c), e ? { event: e, matchedBy: "window" } : null);
    if (e) claimed.add(e.eventId);
  }
  return out;
}

function contradictsDeletion(c: AssetChangeToAttribute, e: WriteEvent): boolean {
  return e.written?.assetId != null && e.written.assetId !== c.assetId;
}

export interface AssetLookupPlan {
  /** Changes the lookup can attribute */
  inRetention: AssetChangeToAttribute[];
  /** Changes older than CloudTrail keeps; no lookup needed for them */
  outOfRetention: AssetChangeToAttribute[];
  /** One time range covering every in-retention change plus the window; null when there are none */
  range: { start: Date; end: Date } | null;
}

/**
 * Time range of the single LookupEvents search for one asset's changes:
 * from the earliest change minus the window to the latest plus the window,
 * clamped to the retention period. A deletion spans from the last recorded
 * update to when it was detected (default now), since its time is unknown.
 */
export function planAssetLookup(changes: readonly AssetChangeToAttribute[], p: AttributionPolicy, now: Date): AssetLookupPlan {
  const windowMs = p.matchWindowSeconds * 1000;
  const retentionStart = now.getTime() - p.lookupEvents.retentionDays * 86_400_000;
  const inRetention: AssetChangeToAttribute[] = [];
  const outOfRetention: AssetChangeToAttribute[] = [];
  let lo = Infinity;
  let hi = -Infinity;

  for (const c of changes) {
    const from = c.changeKind === "deleted" ? c.serviceUpdatedAt.getTime() : changeTime(c).getTime();
    const to = c.changeKind === "deleted" ? (c.detectedAt ?? now).getTime() : from;
    if (to < retentionStart) {
      outOfRetention.push(c);
      continue;
    }
    inRetention.push(c);
    lo = Math.min(lo, from - windowMs);
    hi = Math.max(hi, to + windowMs);
  }

  const range = inRetention.length ? { start: new Date(Math.max(lo, retentionStart)), end: new Date(hi) } : null;
  return { inRetention, outOfRetention, range };
}

/** What the lookup produced for one change, the input to classify(). */
export type ChangeEvidence =
  | { kind: "matched"; match: EventMatch; planItem: { planId: string; appUser: string } | null }
  | { kind: "no-event"; complete: boolean }
  | { kind: "error"; reason: string }
  | { kind: "out-of-retention"; retentionDays: number }
  | { kind: "unsupported-source"; source: string };

function principalFor(e: WriteEvent, field: "sessionName" | "roleName" | "arn" | "label", label: string): string | null {
  const id = e.identity;
  const v = field === "label" ? label : field === "arn" ? id.principal : id[field];
  return v ?? id.principal ?? label;
}

/** Ordered source rules, first match wins. */
export function classify(c: AssetChangeToAttribute, evidence: ChangeEvidence, p: AttributionPolicy, now: Date): Attribution {
  const L = p.labels;
  const unknown = (matchedBy: Attribution["matchedBy"], note: string, extra: Partial<Attribution> = {}): Attribution => ({
    source: "unknown",
    label: L.unknown,
    principal: L.unknown,
    cloudTrailEventId: null,
    planId: null,
    matchedBy,
    note,
    ...extra,
  });

  switch (evidence.kind) {
    case "error":
      return unknown("error", `CloudTrail lookup failed: ${evidence.reason}`);
    case "unsupported-source":
      return unknown("error", `CloudTrail source "${evidence.source}" is not supported yet`);
    case "out-of-retention":
      return unknown("none", `Change is older than the CloudTrail lookup period (${evidence.retentionDays} days)`);
    case "no-event": {
      if (!evidence.complete) return unknown("none", "CloudTrail lookup stopped at the page limit before finding a matching event");
      const since = c.changeKind === "deleted" ? (c.detectedAt ?? now) : changeTime(c);
      if (now.getTime() - since.getTime() < p.eventDeliveryDelaySeconds * 1000) {
        return unknown("none", "No CloudTrail event yet; it may not be delivered", { provisional: true });
      }
      const source = p.noEventSourceByAssetType[c.assetType] ?? p.noEventSource;
      if (source === "unknown") return unknown("none", `No CloudTrail write event, and ${c.assetType} is not labeled as an agent change`);
      return { source: "agent", label: L.agent, principal: L.agent, cloudTrailEventId: null, planId: null, matchedBy: "none" };
    }
    case "matched": {
      const { event, matchedBy } = evidence.match;
      if (evidence.planItem) {
        return {
          source: "app",
          label: L.app,
          principal: evidence.planItem.appUser,
          cloudTrailEventId: event.eventId,
          planId: evidence.planItem.planId,
          matchedBy: "clientToken",
        };
      }
      for (const rule of p.rolePatterns) {
        const target = rule.match === "arn" ? event.identity.principal : event.identity[rule.match];
        if (!target || !globMatches(rule.pattern, target)) continue;
        const field = rule.principal ?? (rule.source === "console" ? "sessionName" : "arn");
        return {
          source: rule.source,
          label: rule.label,
          principal: principalFor(event, field, rule.label),
          cloudTrailEventId: event.eventId,
          planId: null,
          matchedBy,
        };
      }
      return { source: "cli", label: L.cli, principal: event.identity.principal, cloudTrailEventId: event.eventId, planId: null, matchedBy };
    }
  }
}
