import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { agentSpaces, assetChanges, assetIndex, assetReasons } from "@/server/db/schema";
import { truncateAll } from "../../../test/helpers/db";
import { countChangesBySource, countChangesSinceBySpace, countSettledUnknownSince, countUnknownByReason, listFeedItems } from "./feed";

const STORE = "ki-00000000-0000-0000-0000-00000000aaaa";
const MEM = "ki-00000000-0000-0000-0000-00000000bbbb";
const SKILL = "ki-00000000-0000-0000-0000-00000000cccc";
let spaceId: string;
let otherSpaceId: string;

const change = (assetId: string, version: number, at: string, extra: Partial<typeof assetChanges.$inferInsert> = {}) => ({
  spaceId,
  assetId,
  serviceVersion: version,
  serviceUpdatedAt: new Date(at),
  changeKind: "content" as const,
  commit: `c-${assetId.slice(-4)}-${version}-${at}`,
  changeSource: "agent",
  ...extra,
});

beforeAll(async () => {
  await truncateAll();
  const [s, o] = await db()
    .insert(agentSpaces)
    .values([
      { alias: "feed-test", region: "us-west-2", accountId: "111122223333", agentSpaceId: "as-feed" },
      { alias: "feed-other", region: "us-east-1", accountId: "111122223333", agentSpaceId: "as-other" },
    ])
    .returning();
  spaceId = s!.id;
  otherSpaceId = o!.id;
  await db()
    .insert(assetIndex)
    .values([
      { spaceId, assetId: STORE, assetType: "memory_store", name: "chat-tool-use_best" },
      { spaceId, assetId: MEM, assetType: "memory", name: "overview", parentAssetId: STORE },
      { spaceId, assetId: SKILL, assetType: "skill", name: "verity" },
    ]);
  await db()
    .insert(assetChanges)
    .values([
      change(STORE, 1, "2026-06-01T00:00:00Z", { changeKind: "created", changeSource: "unknown" }),
      change(MEM, 1, "2026-11-01T10:00:00Z", { changeKind: "created" }),
      change(MEM, 2, "2026-11-03T10:00:00Z"),
      change(MEM, 2, "2026-11-04T10:00:00Z", { changeKind: "metadata", changeSource: "console", changeSourceLabel: "Operator Web App", principal: "alex" }),
      change(SKILL, 7, "2026-11-05T10:00:00Z", { changeKind: "baseline", changeSource: "unknown", attributionProvisional: true }),
      change(SKILL, 8, "2026-11-06T10:00:00Z", { changeSource: "bogus" }),
    ]);
  await db().insert(assetReasons).values({ id: randomUUID(), spaceId, assetId: MEM, commit: `c-bbbb-2-2026-11-03T10:00:00Z`, reason: "Tighten the index", notesRef: "refs/notes/reasons", addedBy: "t@example.com" });
  await db().insert(assetChanges).values({ ...change(SKILL, 1, "2026-11-06T10:00:00Z"), spaceId: otherSpaceId });
});

describe("listFeedItems", () => {
  it("returns changes newest first with parent names, previous commits, reasons and known sources", async () => {
    const { items, hasMore } = await listFeedItems(spaceId);
    expect(hasMore).toBe(false);
    expect(items.map((i) => `${i.name} v${i.version} ${i.kind}`)).toEqual([
      "verity v8 content",
      "verity v7 baseline",
      "overview v2 metadata",
      "overview v2 content",
      "overview v1 created",
      "chat-tool-use_best v1 created",
    ]);
    const [v8, , meta, content, created] = items;
    expect(v8!.source).toBe("unknown"); // an unrecognized stored source reads as unknown
    expect(v8!.previousCommit).toBe(items[1]!.commit);
    expect(meta).toMatchObject({ source: "console", sourceLabel: "Operator Web App", principal: "alex", parentName: "chat-tool-use_best", previousCommit: content!.commit });
    expect(content).toMatchObject({ hasReason: true, reason: "Tighten the index", previousCommit: created!.commit });
    expect(created!.previousCommit).toBeNull();
    expect(items[1]!.provisional).toBe(true);
  });

  it("filters by source, type, date and name, and pages with hasMore", async () => {
    expect((await listFeedItems(spaceId, { sources: ["console"] })).items).toHaveLength(1);
    expect((await listFeedItems(spaceId, { types: ["skill"] })).items.map((i) => i.version)).toEqual([8, 7]);
    expect((await listFeedItems(spaceId, { since: new Date("2026-11-04T00:00:00Z") })).items).toHaveLength(3);
    expect((await listFeedItems(spaceId, { name: "OVER" })).items).toHaveLength(3);
    // LIKE wildcards in the name are literal: unescaped, "e_v" would match "overview"
    expect((await listFeedItems(spaceId, { name: "use_best" })).items).toHaveLength(1);
    expect((await listFeedItems(spaceId, { name: "e_v" })).items).toHaveLength(0);
    expect((await listFeedItems(spaceId, { name: "%" })).items).toHaveLength(0);
    const page = await listFeedItems(spaceId, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });
});

describe("counts", () => {
  it("counts every source, including zero", async () => {
    // "bogus" is not a known source and counts as unknown
    expect(await countChangesBySource(spaceId)).toEqual({ agent: 2, console: 1, cli: 0, app: 0, unknown: 3 });
  });

  it("counts settled unknown changes since a date, skipping provisional ones", async () => {
    expect(await countSettledUnknownSince(spaceId, new Date("2026-05-01T00:00:00Z"))).toBe(1);
    expect(await countSettledUnknownSince(spaceId, new Date("2026-08-01T00:00:00Z"))).toBe(0);
  });

  it("counts unknown changes by why their source is unknown, so Home says the 90-day reason only for old ones", async () => {
    // The June store change is older than a lookup period starting in August; the November skill change still waits for its event.
    expect(await countUnknownByReason(spaceId, new Date("2026-08-01T00:00:00Z"))).toEqual({ old: 1, pending: 1, failed: 0, noEvent: 0 });
    expect(await countUnknownByReason(spaceId, new Date("2026-05-01T00:00:00Z"))).toEqual({ old: 0, pending: 1, failed: 0, noEvent: 1 });
    expect(await countUnknownByReason(otherSpaceId, new Date("2026-05-01T00:00:00Z"))).toEqual({ old: 0, pending: 0, failed: 0, noEvent: 0 });
  });

  it("counts recent changes per space", async () => {
    const m = await countChangesSinceBySpace([spaceId, otherSpaceId], new Date("2026-11-04T00:00:00Z"));
    expect(m.get(spaceId)).toBe(3);
    expect(m.get(otherSpaceId)).toBe(1);
  });
});

describe("display names", () => {
  it("names instruction files and untitled artifacts for people, and finds them by those names", async () => {
    const [s] = await db().insert(agentSpaces).values({ alias: "feed-names", region: "us-west-2", accountId: "111122223333", agentSpaceId: "as-names" }).returning();
    const id = s!.id;
    const MD = "ki-00000000-0000-0000-0000-00000000dddd";
    const TRIAGE = "ki-00000000-0000-0000-0000-00000000eeee";
    const ART = "ki-00000000-0000-0000-0000-00000000ffff";
    await db()
      .insert(assetIndex)
      .values([
        { spaceId: id, assetId: MD, assetType: "agents_md", name: "GENERIC", metadata: { agent_type: "GENERIC" } },
        { spaceId: id, assetId: TRIAGE, assetType: "agents_md", name: "INCIDENT_TRIAGE", metadata: { agent_type: "INCIDENT_TRIAGE" } },
        { spaceId: id, assetId: ART, assetType: "artifact", name: ART, metadata: { title: "Agent Space Summary Report" } },
      ]);
    await db()
      .insert(assetChanges)
      .values([
        { ...change(MD, 1, "2026-11-01T10:00:00Z"), spaceId: id },
        { ...change(TRIAGE, 1, "2026-11-02T10:00:00Z"), spaceId: id },
        { ...change(ART, 1, "2026-11-03T10:00:00Z"), spaceId: id },
      ]);
    expect((await listFeedItems(id)).items.map((i) => i.name)).toEqual(["Agent Space Summary Report", "Incident triage instructions", "Global instructions"]);
    expect((await listFeedItems(id, { name: "global" })).items.map((i) => i.assetId)).toEqual([MD]);
    expect((await listFeedItems(id, { name: "instructions" })).items).toHaveLength(2);
    expect((await listFeedItems(id, { name: "summary" })).items.map((i) => i.assetId)).toEqual([ART]);
    expect((await listFeedItems(id, { name: "GENERIC" })).items.map((i) => i.assetId)).toEqual([MD]);
  });
});

describe("plan links", () => {
  it("carries the plan that applied a change made through this app", async () => {
    const [s] = await db().insert(agentSpaces).values({ alias: "feed-plans", region: "us-west-2", accountId: "111122223333", agentSpaceId: "as-plans" }).returning();
    const id = s!.id;
    const A = "ki-00000000-0000-0000-0000-00000000abab";
    const PLAN = "11111111-1111-4111-8111-111111111111";
    await db().insert(assetIndex).values({ spaceId: id, assetId: A, assetType: "skill", name: "probe" });
    await db()
      .insert(assetChanges)
      .values([
        { ...change(A, 1, "2026-11-01T10:00:00Z", { changeKind: "created" }), spaceId: id },
        { ...change(A, 2, "2026-11-02T10:00:00Z", { changeSource: "app", principal: "alex@example.com", planId: PLAN }), spaceId: id },
      ]);
    expect((await listFeedItems(id)).items.map((i) => [i.version, i.planId])).toEqual([
      [2, PLAN],
      [1, null],
    ]);
  });
});
