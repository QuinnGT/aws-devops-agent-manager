import { describe, expect, it } from "vitest";
import { parseLookupEvent, parseTimestamp, type WriteEvent } from "./events";
import { classify, matchAssetChanges, matchRulesFromPolicy, planAssetLookup } from "./match";
import { attributionPolicy, change, CLI_ROLE_ARN, CONSOLE_ROLE_ARN, ctEvent, type EventSpec } from "./test-support";
import { attributionKey } from "./types";

const P = attributionPolicy().attribution;
const rules = matchRulesFromPolicy(P);
const A = "ki-aaaaaaaa-0000-4000-8000-000000000001";
const CREATED = "2026-10-01T10:00:00.000Z";

function ev(s: Omit<EventSpec, "assetId">): WriteEvent {
  const r = parseLookupEvent(ctEvent({ assetId: A, ...s }), P.events);
  if (!r.ok) throw new Error(`event did not parse: ${r.reason}`);
  return r.event;
}

describe("parseLookupEvent", () => {
  it("skips read-only, other services, other event names, failed calls and bad JSON", () => {
    const f = P.events;
    expect(parseLookupEvent(ctEvent({ id: "1", assetId: A, time: CREATED, name: "GetAsset", readOnly: true }), f)).toEqual({ ok: false, reason: "not-a-write" });
    expect(parseLookupEvent(ctEvent({ id: "2", assetId: A, time: CREATED, source: "s3.amazonaws.com" }), f)).toEqual({ ok: false, reason: "not-a-write" });
    expect(parseLookupEvent(ctEvent({ id: "3", assetId: A, time: CREATED, name: "TagResource" }), f)).toEqual({ ok: false, reason: "not-a-write" });
    expect(parseLookupEvent(ctEvent({ id: "4", assetId: A, time: CREATED, errorCode: "ConflictException" }), f)).toEqual({ ok: false, reason: "failed-call" });
    expect(parseLookupEvent({ EventId: "5", CloudTrailEvent: "{not json" }, f)).toEqual({ ok: false, reason: "unparsable" });
  });

  it("reads epoch-second timestamps from responseElements", () => {
    const e = ev({ id: "x", time: "2026-11-10T23:38:13.000Z", written: { version: 24, createdAt: CREATED, updatedAt: "2026-11-10T23:38:13.000Z" }, clientToken: "t" });
    expect(e.written).toEqual({ assetId: A, version: 24, createdAt: new Date(CREATED), updatedAt: new Date("2026-11-10T23:38:13.000Z") });
    expect(e.clientToken).toBe("t");
    expect(parseTimestamp(1794353893)?.toISOString()).toBe("2026-11-10T23:38:13.000Z");
    expect(parseTimestamp(1794353893000)?.toISOString()).toBe("2026-11-10T23:38:13.000Z");
    expect(parseTimestamp("1794353893")?.toISOString()).toBe("2026-11-10T23:38:13.000Z");
    expect(parseTimestamp("nope")).toBeNull();
  });
});

describe("matchAssetChanges", () => {
  it("prefers an exact version and updatedAt match over a closer event", () => {
    const c = change({ assetId: A, serviceVersion: 3, changeKind: "metadata" }, "2026-11-01T12:00:10.000Z", CREATED);
    const near = ev({ id: "near", time: "2026-11-01T12:00:10.000Z" }); // no responseElements
    const exact = ev({ id: "exact", time: "2026-11-01T12:00:12.000Z", written: { version: 3, createdAt: CREATED, updatedAt: "2026-11-01T12:00:10.000Z" } });
    const m = matchAssetChanges([c], [near, exact], rules).get(attributionKey(c));
    expect(m).toMatchObject({ matchedBy: "exact", event: { eventId: "exact" } });
  });

  it("uses the window only for events that do not contradict the change, each event once", () => {
    const c1 = change({ assetId: A, serviceVersion: 5 }, "2026-11-01T12:00:00.000Z", CREATED);
    const c2 = change({ assetId: A, serviceVersion: 6 }, "2026-11-01T12:00:05.000Z", CREATED);
    const wrongVersion = ev({ id: "v9", time: "2026-11-01T12:00:01.000Z", written: { version: 9, createdAt: CREATED, updatedAt: "2026-11-01T12:00:01.000Z" } });
    const bare = ev({ id: "bare", name: "UpdateAssetFile", time: "2026-11-01T12:00:02.000Z" });
    const m = matchAssetChanges([c1, c2], [wrongVersion, bare], rules);
    expect(m.get(attributionKey(c1))).toMatchObject({ matchedBy: "window", event: { eventId: "bare" } });
    expect(m.get(attributionKey(c2))).toBeNull();
  });

  it("ignores events outside the window", () => {
    const c = change({ assetId: A, serviceVersion: 5 }, "2026-11-01T12:00:00.000Z", CREATED);
    const late = ev({ id: "late", time: "2026-11-01T12:01:01.000Z" });
    expect(matchAssetChanges([c], [late], rules).get(attributionKey(c))).toBeNull();
    expect(matchAssetChanges([c], [late], { ...rules, windowSeconds: 120 }).get(attributionKey(c))).toMatchObject({ matchedBy: "window" });
  });

  it("matches a creation to CreateAsset, not to a later status switch on version 1", () => {
    const created = change({ assetId: A, serviceVersion: 1, changeKind: "created" }, "2026-10-01T10:05:00.000Z", CREATED);
    const switched = change({ assetId: A, serviceVersion: 1, changeKind: "metadata" }, "2026-10-01T10:05:00.000Z", CREATED);
    const create = ev({ id: "create", name: "CreateAsset", time: CREATED, arn: CLI_ROLE_ARN, written: { version: 1, createdAt: CREATED, updatedAt: CREATED } });
    const toggle = ev({ id: "toggle", time: "2026-10-01T10:05:00.000Z", written: { version: 1, createdAt: CREATED, updatedAt: "2026-10-01T10:05:00.000Z" } });
    expect(matchAssetChanges([created], [toggle, create], rules).get(attributionKey(created))).toMatchObject({ matchedBy: "exact", event: { eventId: "create" } });
    expect(matchAssetChanges([switched], [toggle, create], rules).get(attributionKey(switched))).toMatchObject({ matchedBy: "exact", event: { eventId: "toggle" } });
    // Without the CreateAsset event, the toggle is not taken for the creation.
    expect(matchAssetChanges([created], [toggle], rules).get(attributionKey(created))).toBeNull();
  });

  it("matches a deletion to DeleteAsset by asset ID at or after the last update", () => {
    const del = change({ assetId: A, serviceVersion: 4, changeKind: "deleted" }, "2026-11-01T00:00:00.000Z", CREATED);
    const old = ev({ id: "old", name: "DeleteAsset", time: "2026-10-01T00:00:00.000Z" });
    const real = ev({ id: "real", name: "DeleteAsset", time: "2026-11-05T00:00:00.000Z" });
    expect(matchAssetChanges([del], [old, real], rules).get(attributionKey(del))).toMatchObject({ matchedBy: "exact", event: { eventId: "real" } });
    expect(matchAssetChanges([del], [old], rules).get(attributionKey(del))).toBeNull();
  });
});

describe("planAssetLookup", () => {
  const now = new Date("2026-11-11T00:00:00.000Z");

  it("covers every change plus the window and drops changes older than retention", () => {
    const old = change({ assetId: A, serviceVersion: 1 }, "2026-07-01T00:00:00.000Z");
    const a = change({ assetId: A, serviceVersion: 2 }, "2026-11-01T00:00:00.000Z");
    const b = change({ assetId: A, serviceVersion: 3 }, "2026-11-02T00:00:00.000Z");
    const plan = planAssetLookup([old, a, b], P, now);
    expect(plan.outOfRetention).toEqual([old]);
    expect(plan.inRetention).toEqual([a, b]);
    expect(plan.range).toEqual({ start: new Date("2026-10-31T23:59:00.000Z"), end: new Date("2026-11-02T00:01:00.000Z") });
  });

  it("spans a deletion from the last update to detection, clamped to retention", () => {
    const del = change({ assetId: A, serviceVersion: 2, changeKind: "deleted" }, "2026-06-01T00:00:00.000Z");
    const plan = planAssetLookup([del], P, now);
    expect(plan.inRetention).toEqual([del]);
    expect(plan.range?.start).toEqual(new Date(now.getTime() - 90 * 86_400_000));
    expect(plan.range?.end).toEqual(new Date("2026-11-11T00:01:00.000Z"));
    expect(planAssetLookup([old()], P, now).range).toBeNull();
    function old() {
      return change({ assetId: A, serviceVersion: 1 }, "2026-01-01T00:00:00.000Z");
    }
  });
});

describe("classify", () => {
  const now = new Date("2026-11-11T00:00:00.000Z");
  const c = change({ assetId: A, serviceVersion: 3 }, "2026-11-01T00:00:00.000Z");

  it("applies role patterns in order with their match field and principal", () => {
    const e = ev({ id: "e", time: "2026-11-01T00:00:00.000Z", arn: CONSOLE_ROLE_ARN });
    const policy = {
      ...P,
      rolePatterns: [
        { pattern: "*-sam-*", match: "sessionName" as const, source: "agent" as const, label: "Chat agent", principal: "label" as const },
        { pattern: "DevOpsAgentRole-WebappAdmin-*", match: "roleName" as const, source: "console" as const, label: "Operator Web App" },
      ],
    };
    expect(classify(c, { kind: "matched", match: { event: e, matchedBy: "exact" }, planItem: null }, policy, now)).toMatchObject({
      source: "agent",
      label: "Chat agent",
      principal: "Chat agent",
    });
    expect(classify(c, { kind: "matched", match: { event: e, matchedBy: "window" }, planItem: null }, P, now)).toEqual({
      source: "console",
      label: "Operator Web App",
      principal: "AROAEXAMPLEMASKED0002-sam-Admin",
      cloudTrailEventId: "e",
      planId: null,
      matchedBy: "window",
    });
  });

  it("labels no-event changes by asset type, and recent ones as provisional", () => {
    expect(classify(c, { kind: "no-event", complete: true }, P, now)).toMatchObject({ source: "agent", principal: P.labels.agent, matchedBy: "none" });
    const byType = { ...P, noEventSourceByAssetType: { memory: "unknown" as const } };
    expect(classify(c, { kind: "no-event", complete: true }, byType, now)).toMatchObject({ source: "unknown", matchedBy: "none" });
    const recent = change({ assetId: A, serviceVersion: 4 }, "2026-11-10T23:58:00.000Z");
    expect(classify(recent, { kind: "no-event", complete: true }, P, now)).toMatchObject({ source: "unknown", provisional: true });
    expect(classify(c, { kind: "no-event", complete: false }, P, now)).toMatchObject({ source: "unknown", matchedBy: "none" });
  });
});
