import { CloudTrailClient, type LookupEventsCommandOutput, LookupEventsCommand, ThrottlingException } from "@aws-sdk/client-cloudtrail";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFixture } from "../../../test/helpers/fixtures";
import { type AssetChangeToAttribute, type AttributionDeps, attributeChanges, attributionKey } from "./index";
import { limiterFor, RateLimiter, resetAttributionLimitersForTests } from "./rate-limiter";
import { APP_WRITE_ROLE_ARN, attributionPolicy, change, CLI_ROLE_ARN, CONSOLE_ROLE_ARN, ctEvent, fakeClock, IAM_USER_ARN } from "./test-support";

const ct = mockClient(CloudTrailClient);
const NOW = "2026-11-11T18:00:00.000Z";
const MEMORY = "ki-9184fa09-8e79-4a11-90fa-a6b81ab5fe6b";
const A = "ki-aaaaaaaa-0000-4000-8000-000000000001";
const B = "ki-bbbbbbbb-0000-4000-8000-000000000002";
const C = "ki-cccccccc-0000-4000-8000-000000000003";
const CREATED = "2026-10-01T10:00:00.000Z";

let clock: ReturnType<typeof fakeClock>;

function deps(overrides: Partial<AttributionDeps> = {}): AttributionDeps {
  return {
    cloudTrail: new CloudTrailClient({ region: "us-west-2" }),
    policy: attributionPolicy(),
    scope: { accountId: "111122223333", region: "us-west-2" },
    limiter: new RateLimiter(1, clock),
    clock,
    ...overrides,
  };
}

async function attributeOne(c: AssetChangeToAttribute, d: AttributionDeps = deps()) {
  const res = await attributeChanges([c], d);
  expect(res.size).toBe(1);
  return res.get(attributionKey(c));
}

function lookupInputs() {
  return ct.commandCalls(LookupEventsCommand).map((call) => call.args[0].input);
}

beforeEach(() => {
  ct.reset();
  clock = fakeClock(NOW);
  resetAttributionLimitersForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("attributeChanges with the captured test-space event", () => {
  type Fx = { Events: NonNullable<LookupEventsCommandOutput["Events"]>; NextToken?: string };
  const fx = apiFixture<Fx>("CloudTrail.LookupEvents.memory").response;
  const asLookup = (r: Fx) => ({ ...r, Events: r.Events.map((e) => ({ ...e, EventTime: new Date(e.EventTime as unknown as string) })) });

  it("labels the console status switch with the role session name, reading every page", async () => {
    ct.on(LookupEventsCommand).resolvesOnce(asLookup(fx)).resolves({ Events: [] });
    const c = change({ assetId: MEMORY, serviceVersion: 24, changeKind: "metadata" }, "2026-11-10T23:38:13.000Z", "2026-08-13T18:37:05.000Z");

    expect(await attributeOne(c)).toEqual({
      source: "console",
      label: "Operator Web App",
      principal: "AROAEXAMPLEMASKED0001-alex-Admin",
      cloudTrailEventId: "819eeec4-61e6-49c2-944c-90ea42569020",
      planId: null,
      matchedBy: "exact",
    });

    const inputs = lookupInputs();
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toEqual({
      LookupAttributes: [{ AttributeKey: "ResourceName", AttributeValue: MEMORY }],
      StartTime: new Date("2026-11-10T23:37:13.000Z"),
      EndTime: new Date("2026-11-10T23:39:13.000Z"),
      MaxResults: 50,
      NextToken: undefined,
    });
    expect(inputs[1]).toMatchObject({ NextToken: fx.NextToken, StartTime: inputs[0]?.StartTime, EndTime: inputs[0]?.EndTime });
  });

  it("tells apart switches one second apart by updatedAt", async () => {
    ct.on(LookupEventsCommand).resolves({ ...asLookup(fx), NextToken: undefined });
    const c = change({ assetId: MEMORY, serviceVersion: 24, changeKind: "metadata" }, "2026-11-10T23:38:12.000Z", "2026-08-13T18:37:05.000Z");
    expect(await attributeOne(c)).toMatchObject({ source: "console", cloudTrailEventId: "900090bb-832e-4dea-999c-ac157fd6512f", matchedBy: "exact" });
  });
});

describe("attributeChanges source rules", () => {
  it("attributes a CLI creation and a later console switch on version 1, with one lookup for the asset", async () => {
    const switchedAt = "2026-10-01T10:00:40.000Z";
    ct.on(LookupEventsCommand).resolves({
      Events: [
        ctEvent({ id: "toggle", assetId: A, time: switchedAt, arn: CONSOLE_ROLE_ARN, written: { version: 1, createdAt: CREATED, updatedAt: switchedAt } }),
        ctEvent({ id: "create", assetId: A, name: "CreateAsset", time: CREATED, arn: IAM_USER_ARN, written: { version: 1, createdAt: CREATED, updatedAt: CREATED } }),
      ],
    });
    const created = change({ assetId: A, serviceVersion: 1, changeKind: "created" }, CREATED, CREATED);
    const switched = change({ assetId: A, serviceVersion: 1, changeKind: "metadata" }, switchedAt, CREATED);

    const res = await attributeChanges([created, switched], deps());
    expect(res.get(attributionKey(created))).toEqual({
      source: "cli",
      label: "CLI or SDK",
      principal: IAM_USER_ARN,
      cloudTrailEventId: "create",
      planId: null,
      matchedBy: "exact",
    });
    expect(res.get(attributionKey(switched))).toMatchObject({ source: "console", principal: "AROAEXAMPLEMASKED0002-sam-Admin", cloudTrailEventId: "toggle" });
    expect(lookupInputs()).toHaveLength(1);
    expect(lookupInputs()[0]).toMatchObject({ StartTime: new Date("2026-10-01T09:59:00.000Z"), EndTime: new Date("2026-10-01T10:01:40.000Z") });
  });

  it("records the IAM principal ARN for a CLI write from an assumed role", async () => {
    const at = "2026-11-05T08:00:00.000Z";
    ct.on(LookupEventsCommand).resolves({ Events: [ctEvent({ id: "cli", assetId: A, time: at, arn: CLI_ROLE_ARN, written: { version: 7, createdAt: CREATED, updatedAt: at } })] });
    expect(await attributeOne(change({ assetId: A, serviceVersion: 7 }, at, CREATED))).toMatchObject({ source: "cli", principal: CLI_ROLE_ARN, matchedBy: "exact" });
  });

  it("labels the app's own write by clientToken, looking up each token once", async () => {
    const at = "2026-11-05T08:00:00.000Z";
    const at2 = "2026-11-05T08:10:00.000Z";
    ct.on(LookupEventsCommand).resolves({
      Events: [
        ctEvent({ id: "app1", assetId: A, time: at, arn: APP_WRITE_ROLE_ARN, clientToken: "tok-1", written: { version: 8, createdAt: CREATED, updatedAt: at } }),
        ctEvent({ id: "app2", assetId: A, time: at2, arn: APP_WRITE_ROLE_ARN, clientToken: "tok-1", written: { version: 9, createdAt: CREATED, updatedAt: at2 } }),
      ],
    });
    const find = vi.fn(async (token: string) => (token === "tok-1" ? { planId: "plan-1", appUser: "a@example.com" } : null));
    const c8 = change({ assetId: A, serviceVersion: 8 }, at, CREATED);
    const c9 = change({ assetId: A, serviceVersion: 9 }, at2, CREATED);
    const res = await attributeChanges([c8, c9], deps({ findPlanItemByClientToken: find }));
    expect(res.get(attributionKey(c8))).toEqual({
      source: "app",
      label: "DevOps Agent Manager",
      principal: "a@example.com",
      cloudTrailEventId: "app1",
      planId: "plan-1",
      matchedBy: "clientToken",
    });
    expect(res.get(attributionKey(c9))).toMatchObject({ source: "app", cloudTrailEventId: "app2" });
    expect(find).toHaveBeenCalledTimes(1);
  });

  it("falls back to cli when the clientToken is not a plan item", async () => {
    const at = "2026-11-05T08:00:00.000Z";
    ct.on(LookupEventsCommand).resolves({ Events: [ctEvent({ id: "x", assetId: A, time: at, arn: CLI_ROLE_ARN, clientToken: "other", written: { version: 8, createdAt: CREATED, updatedAt: at } })] });
    const res = await attributeOne(change({ assetId: A, serviceVersion: 8 }, at, CREATED), deps({ findPlanItemByClientToken: async () => null }));
    expect(res).toMatchObject({ source: "cli", principal: CLI_ROLE_ARN, matchedBy: "exact" });
  });

  it("falls back to the time window when responseElements carry no version", async () => {
    const at = "2026-11-05T08:00:00.000Z";
    ct.on(LookupEventsCommand).resolves({
      Events: [
        ctEvent({ id: "file", assetId: A, name: "UpdateAssetFile", time: "2026-11-05T08:00:20.000Z", arn: CONSOLE_ROLE_ARN, written: null }),
        ctEvent({ id: "failed", assetId: A, time: "2026-11-05T08:00:01.000Z", arn: CLI_ROLE_ARN, errorCode: "ConflictException" }),
      ],
    });
    expect(await attributeOne(change({ assetId: A, serviceVersion: 3 }, at, CREATED))).toMatchObject({ source: "console", cloudTrailEventId: "file", matchedBy: "window" });
  });

  it("labels a change with no write event as the agent", async () => {
    ct.on(LookupEventsCommand).resolves({
      Events: [ctEvent({ id: "read", assetId: A, name: "GetAsset", time: "2026-11-03T18:38:34.000Z", readOnly: true })],
    });
    expect(await attributeOne(change({ assetId: A, serviceVersion: 23 }, "2026-11-03T18:38:34.000Z", CREATED))).toEqual({
      source: "agent",
      label: "DevOps Agent",
      principal: "DevOps Agent",
      cloudTrailEventId: null,
      planId: null,
      matchedBy: "none",
    });
  });

  it("marks a very recent change with no event as provisional unknown", async () => {
    ct.on(LookupEventsCommand).resolves({ Events: [] });
    const res = await attributeOne(change({ assetId: A, serviceVersion: 2 }, "2026-11-11T17:59:00.000Z", CREATED));
    expect(res).toMatchObject({ source: "unknown", matchedBy: "none", provisional: true });
  });

  it("matches a deletion to DeleteAsset without responseElements", async () => {
    ct.on(LookupEventsCommand).resolves({ Events: [ctEvent({ id: "del", assetId: A, name: "DeleteAsset", time: "2026-11-09T12:00:00.000Z", arn: CONSOLE_ROLE_ARN, written: null })] });
    const del = change({ assetId: A, serviceVersion: 4, changeKind: "deleted", detectedAt: new Date("2026-11-10T00:00:00.000Z") }, "2026-11-01T00:00:00.000Z", CREATED);
    expect(await attributeOne(del)).toMatchObject({ source: "console", cloudTrailEventId: "del", matchedBy: "exact" });
    expect(lookupInputs()[0]).toMatchObject({ StartTime: new Date("2026-10-31T23:59:00.000Z"), EndTime: new Date("2026-11-10T00:01:00.000Z") });
  });

  it("labels changes older than CloudTrail keeps as unknown without a lookup", async () => {
    const res = await attributeOne(change({ assetId: A, serviceVersion: 1 }, "2026-07-01T00:00:00.000Z", CREATED));
    expect(res).toMatchObject({ source: "unknown", matchedBy: "none" });
    expect(lookupInputs()).toHaveLength(0);
  });

  it("returns unknown for every change when the source is not lookup-events", async () => {
    const d = deps({ policy: attributionPolicy({ cloudTrailSource: "athena" }) });
    const res = await attributeOne(change({ assetId: A, serviceVersion: 1 }, "2026-11-01T00:00:00.000Z"), d);
    expect(res).toMatchObject({ source: "unknown", matchedBy: "error" });
    expect(lookupInputs()).toHaveLength(0);
  });
});

describe("attributeChanges failures, throttling and pagination", () => {
  const at = "2026-11-05T08:00:00.000Z";

  it("labels every change of an asset unknown when its lookup fails, and keeps going", async () => {
    const denied = Object.assign(new Error("not authorized to perform cloudtrail:LookupEvents"), { name: "AccessDeniedException" });
    ct.on(LookupEventsCommand, { LookupAttributes: [{ AttributeKey: "ResourceName", AttributeValue: A }] }).rejects(denied);
    ct.on(LookupEventsCommand, { LookupAttributes: [{ AttributeKey: "ResourceName", AttributeValue: B }] }).resolves({ Events: [] });
    const a1 = change({ assetId: A, serviceVersion: 1 }, at, CREATED);
    const a2 = change({ assetId: A, serviceVersion: 2 }, "2026-11-05T09:00:00.000Z", CREATED);
    const b1 = change({ assetId: B, serviceVersion: 1 }, at, CREATED);
    const res = await attributeChanges([a1, a2, b1], deps());
    for (const c of [a1, a2]) {
      expect(res.get(attributionKey(c))).toMatchObject({ source: "unknown", label: "Unknown", principal: "Unknown", matchedBy: "error" });
      expect(res.get(attributionKey(c))?.note).toContain("AccessDeniedException");
    }
    expect(res.get(attributionKey(b1))).toMatchObject({ source: "agent" });
  });

  it("labels the change unknown when the plan item lookup fails", async () => {
    ct.on(LookupEventsCommand).resolves({ Events: [ctEvent({ id: "x", assetId: A, time: at, clientToken: "t", written: { version: 1, createdAt: CREATED, updatedAt: at } })] });
    const d = deps({
      findPlanItemByClientToken: async () => {
        throw new Error("db down");
      },
    });
    expect(await attributeOne(change({ assetId: A, serviceVersion: 1 }, at, CREATED), d)).toMatchObject({ source: "unknown", matchedBy: "error" });
  });

  it("retries a throttled request with backoff", async () => {
    ct.on(LookupEventsCommand)
      .rejectsOnce(new ThrottlingException({ message: "Rate exceeded", $metadata: {} }))
      .rejectsOnce(new ThrottlingException({ message: "Rate exceeded", $metadata: {} }))
      .resolves({ Events: [ctEvent({ id: "ok", assetId: A, time: at, arn: CLI_ROLE_ARN, written: { version: 2, createdAt: CREATED, updatedAt: at } })] });
    expect(await attributeOne(change({ assetId: A, serviceVersion: 2 }, at, CREATED))).toMatchObject({ source: "cli", cloudTrailEventId: "ok" });
    expect(lookupInputs()).toHaveLength(3);
    // Backoff 1000 ms, then 2000 ms; the limiter needs no extra wait after a backoff.
    expect(clock.sleeps).toEqual([1000, 2000]);
  });

  it("gives up after the configured throttle retries and labels the change unknown", async () => {
    const base = attributionPolicy().attribution;
    const d = deps({ policy: attributionPolicy({ lookupEvents: { ...base.lookupEvents, throttleRetries: 1 } }) });
    ct.on(LookupEventsCommand).rejects(new ThrottlingException({ message: "Rate exceeded", $metadata: {} }));
    const res = await attributeOne(change({ assetId: A, serviceVersion: 2 }, at, CREATED), d);
    expect(res).toMatchObject({ source: "unknown", matchedBy: "error" });
    expect(res?.note).toContain("ThrottlingException");
    expect(lookupInputs()).toHaveLength(2);
  });

  it("spaces requests across assets at the policy rate", async () => {
    const times: number[] = [];
    ct.on(LookupEventsCommand).callsFake(() => {
      times.push(clock.now());
      return { Events: [] };
    });
    const changes = [A, B, C].map((id) => change({ assetId: id, serviceVersion: 1 }, at, CREATED));
    await attributeChanges(changes, deps({ limiter: new RateLimiter(2, clock) }));
    const t0 = times[0] ?? 0;
    expect(times.map((t) => t - t0)).toEqual([0, 500, 1000]);
  });

  it("uses one shared limiter per account and Region when none is injected", async () => {
    ct.on(LookupEventsCommand).resolves({ Events: [] });
    const acquire = vi.spyOn(RateLimiter.prototype, "acquire");
    const base = attributionPolicy().attribution;
    const fast = attributionPolicy({ lookupEvents: { ...base.lookupEvents, requestsPerSecond: 1000 } });
    const scoped = deps({ limiter: undefined, policy: fast });
    await attributeChanges([change({ assetId: A, serviceVersion: 1 }, at, CREATED)], scoped);
    await attributeChanges([change({ assetId: B, serviceVersion: 1 }, at, CREATED)], scoped);
    // Without a scope, the client's Region is the key.
    await attributeChanges([change({ assetId: C, serviceVersion: 1 }, at, CREATED)], deps({ limiter: undefined, policy: fast, scope: undefined }));
    const [first, second, third] = acquire.mock.contexts;
    expect(first).toBe(limiterFor("111122223333|us-west-2", 1000));
    expect(second).toBe(first);
    expect(third).toBe(limiterFor("default|us-west-2", 1000));
    expect(third).not.toBe(first);
  });

  it("follows NextToken through every page", async () => {
    ct.on(LookupEventsCommand)
      .resolvesOnce({ Events: [ctEvent({ id: "p1", assetId: A, time: "2026-11-05T08:00:30.000Z", arn: CLI_ROLE_ARN, written: { version: 1, createdAt: CREATED, updatedAt: "2026-11-05T08:00:30.000Z" } })], NextToken: "t1" })
      .resolvesOnce({ Events: [], NextToken: "t2" })
      .resolvesOnce({ Events: [ctEvent({ id: "p3", assetId: A, time: at, arn: CONSOLE_ROLE_ARN, written: { version: 2, createdAt: CREATED, updatedAt: at } })] });
    expect(await attributeOne(change({ assetId: A, serviceVersion: 2 }, at, CREATED))).toMatchObject({ source: "console", cloudTrailEventId: "p3", matchedBy: "exact" });
    expect(lookupInputs().map((i) => i.NextToken)).toEqual([undefined, "t1", "t2"]);
  });

  it("labels an unmatched change unknown when the page cap stops the lookup", async () => {
    const base = attributionPolicy().attribution;
    const d = deps({ policy: attributionPolicy({ lookupEvents: { ...base.lookupEvents, maxPagesPerAsset: 2 } }) });
    ct.on(LookupEventsCommand).resolves({ Events: [], NextToken: "more" });
    const res = await attributeOne(change({ assetId: A, serviceVersion: 2 }, at, CREATED), d);
    expect(res).toMatchObject({ source: "unknown", matchedBy: "none" });
    expect(lookupInputs()).toHaveLength(2);
  });

  it("returns an empty map for an empty batch without calling CloudTrail", async () => {
    expect((await attributeChanges([], deps())).size).toBe(0);
    expect(lookupInputs()).toHaveLength(0);
  });
});
