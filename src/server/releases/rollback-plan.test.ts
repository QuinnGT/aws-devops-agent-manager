import { describe, expect, it } from "vitest";
import type { AssetFileSnapshot, AssetSnapshot } from "@/lib/assets/types";
import { getAppPolicy, type Policy } from "@/server/policy";
import { releasesSection } from "@/server/policy/sections/releases";
import { buildRollbackItems, classifyRollback, countActions, typeOrder, type CurrentAsset, type RollbackPolicy, type TargetAsset } from "./rollback-plan";

const policy = getAppPolicy().policy;
const notes = policy.releases.rollback.notes;

const T = "2026-10-01T00:00:00.000Z";
const target = (assetId: string, assetType: string, metadata: Record<string, unknown>, serviceVersion = 1): TargetAsset => ({ assetId, assetType, metadata, serviceVersion, serviceUpdatedAt: T });
const current = (assetId: string, assetType: string, name: string, metadata: Record<string, unknown>, over: Partial<CurrentAsset> = {}): CurrentAsset => ({
  assetId,
  assetType,
  name,
  parentAssetId: typeof metadata.memory_store_id === "string" ? metadata.memory_store_id : null,
  metadata,
  liveVersion: 1,
  liveUpdatedAt: "2026-11-01T00:00:00.000Z",
  deleted: false,
  ...over,
});

const skillMeta = (name: string, status = "ACTIVE") => ({ name, description: `${name} skill`, agent_types: ["GENERIC"], status, skill_type: "USER" });
const storeMeta = (name: string) => ({ name, description: `${name} store`, agent_types: ["GENERIC"], status: "ACTIVE" });

// The target: what the release recorded.
const targets: TargetAsset[] = [
  target("S1", "memory_store", storeMeta("runbooks")),
  target("M1", "memory", { name: "db/failover", description: "Failover", memory_store_id: "S1", status: "ACTIVE" }),
  target("K1", "skill", skillMeta("triage")),
  target("K3", "skill", { name: "big", description: "big skill", agent_types: ["GENERIC"], status: "ACTIVE" }),
  target("C1", "custom_agent", { name: "oncall", skills: ["K1", "K3"], memory_stores: ["S1", "MS"] }),
  target("A1", "agents_md", { agent_type: "GENERIC", status: "ACTIVE" }),
  target("MS", "memory_store", storeMeta("monitors"), 5),
  target("MM", "memory", { name: "m1", description: "Managed", memory_store_id: "MS" }, 2),
  target("ART", "artifact", { title: "Report" }),
  target("R-old", "skill", skillMeta("renamed")),
];

// The current index: changes since the target.
const now: CurrentAsset[] = [
  current("S1", "memory_store", "runbooks", storeMeta("runbooks")),
  current("M1", "memory", "db/failover", { name: "db/failover", description: "Failover", memory_store_id: "S1", status: "ACTIVE" }, { liveVersion: 3 }),
  current("K1", "skill", "triage", skillMeta("triage"), { deleted: true }),
  current("K3", "skill", "big", { name: "big", description: "big skill", agent_types: ["GENERIC"], status: "ACTIVE", enable_tools: ["x"], skill_type: "USER" }, { liveVersion: 2 }),
  current("C1", "custom_agent", "oncall", { name: "oncall", skills: ["K3"], memory_stores: ["S1", "MS"], tools: ["aws"] }, { liveVersion: 2 }),
  current("A1", "agents_md", "GENERIC", { agent_type: "GENERIC", status: "ACTIVE" }, { liveVersion: 2 }),
  current("MS", "memory_store", "monitors", storeMeta("monitors"), { liveVersion: 9 }),
  current("MM", "memory", "m1", { name: "m1", description: "Managed", memory_store_id: "MS" }, { liveVersion: 4 }),
  current("MNEW", "memory", "m2", { name: "m2", description: "New managed", memory_store_id: "MS" }),
  current("ART", "artifact", "Report", { title: "Report" }),
  current("R-old", "skill", "renamed", skillMeta("renamed"), { deleted: true }),
  current("R-new", "skill", "renamed", skillMeta("renamed")),
  current("K2", "skill", "new-skill", skillMeta("new-skill")),
  current("K4", "skill", "old-inactive", skillMeta("old-inactive", "INACTIVE")),
  current("C2", "custom_agent", "helper", { name: "helper", skills: ["K2"] }),
];

function file(path: string, content: string): AssetFileSnapshot {
  return { path, sha256: `sha-${path}`, size: content.length, encoding: "utf8", content };
}

const mainFile: Record<string, string> = { memory_store: "README.md", memory: "body.md", skill: "SKILL.md", custom_agent: "AGENT.md", agents_md: "AGENTS.md", artifact: "a.md" };

function filesFor(ts: readonly TargetAsset[]): Map<string, AssetFileSnapshot[]> {
  return new Map(ts.map((t) => [t.assetId, [file(mainFile[t.assetType]!, `${t.assetId} at v${t.serviceVersion}\n`)]]));
}

function snapshotOf(c: CurrentAsset): AssetSnapshot {
  return { assetId: c.assetId, assetType: c.assetType, version: c.liveVersion!, createdAt: T, updatedAt: "2026-11-01T00:00:00.000Z", metadata: c.metadata, files: [file(mainFile[c.assetType]!, `${c.assetId} now\n`)] };
}

function run(opts: { scope?: "space" | "asset"; ts?: TargetAsset[]; cur?: CurrentAsset[]; p?: RollbackPolicy; files?: Map<string, AssetFileSnapshot[]> } = {}) {
  const ts = opts.ts ?? targets;
  const cur = opts.cur ?? now;
  const p = opts.p ?? policy;
  const classification = classifyRollback({ scope: opts.scope ?? "space", targets: ts, current: cur, policy: p });
  const deactivate = new Map(classification.addedAfter.filter((a) => a.action === "deactivate").map((a) => [a.current.assetId, snapshotOf(a.current)]));
  const built = buildRollbackItems({
    classification,
    policy: p,
    targets: ts,
    current: cur,
    targetFiles: opts.files ?? filesFor(ts),
    deactivateSnapshots: deactivate,
    fetchedPaths: new Map([["K3", ["assets/big.bin"]]]),
  });
  const row = (key: string, assetType?: string) => built.rows.find((r) => r.key === key && (!assetType || r.assetType === assetType))!;
  const item = (assetId: string) => built.items.find((i) => i.desired.assetId === assetId || (!i.desired.assetId && i.desired.key === assetId))!;
  return { classification, built, row, item };
}

describe("rollback of a release or commit", () => {
  it("updates assets that still exist, unchanged ones included", () => {
    const { row, item } = run();
    expect(row("runbooks", "memory_store")).toMatchObject({ action: "update", assetId: "S1", expected: "unchanged", note: null });
    expect(row("runbooks/db/failover")).toMatchObject({ action: "update", assetId: "M1", expected: "changes", targetVersion: 1, currentVersion: 3 });
    expect(item("M1").desired).toMatchObject({ assetType: "memory", key: "runbooks/db/failover", metadata: { memory_store_id: "S1" }, refs: { memoryStore: "runbooks" } });
    expect(item("M1").desired.files).toEqual([{ path: "body.md", encoding: "utf8", content: "M1 at v1\n" }]);
    expect(item("M1")).toMatchObject({ baseVersion: null, baseUpdatedAt: null });
  });

  it("recreates an asset deleted since the target without an asset ID, and custom agents refer to it by name", () => {
    const { row, item } = run();
    expect(row("triage")).toMatchObject({ action: "create", assetId: null, targetAssetId: "K1", expected: "create", note: notes.recreated });
    const created = item("triage");
    expect(created.desired.assetId).toBeUndefined();
    expect(created.desired.metadata).toEqual(skillMeta("triage"));

    const agent = item("C1");
    // K1 has no ID yet: the plan resolves refs.skills at apply time.
    expect(agent.desired.metadata.skills).toEqual(["K3"]);
    expect(agent.desired.refs).toEqual({ skills: ["triage", "big"], memoryStores: ["runbooks", "monitors"] });
    expect(agent.desired.metadata.memory_stores).toEqual(["S1", "MS"]);
  });

  it("updates the asset that took over the name when one was deleted and created again", () => {
    const { row, item, built } = run();
    expect(row("renamed")).toMatchObject({ action: "update", assetId: "R-new", targetAssetId: "R-old", note: notes.replaced });
    expect(item("R-new").desired.key).toBe("renamed");
    expect(built.rows.filter((r) => r.key === "renamed")).toHaveLength(1);
  });

  it("removes metadata keys added after the target, except the keys policy keeps", () => {
    const { row, item } = run();
    expect(item("C1").removeMetadataKeys).toEqual(["tools"]);
    expect(item("K3").removeMetadataKeys).toEqual(["enable_tools"]);
    expect(row("big").note).toBe(`Removes metadata keys added after the target: enable_tools. Files read from the service because the history repository doesn't hold them: assets/big.bin.`);
    expect(item("S1").removeMetadataKeys).toBeUndefined();
  });

  it("sets skills added after the target Inactive and leaves other types as they are", () => {
    const { row, item, built } = run();
    expect(row("new-skill")).toMatchObject({ action: "deactivate", assetId: "K2", note: notes.deactivated });
    expect(item("K2")).toMatchObject({ baseVersion: 1, baseUpdatedAt: "2026-11-01T00:00:00.000Z", note: notes.deactivated });
    expect(item("K2").desired.metadata.status).toBe("INACTIVE");
    expect(item("K2").desired.files).toEqual([{ path: "SKILL.md", encoding: "utf8", content: "K2 now\n" }]);
    expect(row("old-inactive")).toMatchObject({ action: "keep", note: notes.alreadyInactive });
    expect(row("helper")).toMatchObject({ action: "keep", assetId: "C2", note: notes.kept });
    expect(built.items.some((i) => i.desired.assetId === "C2" || i.desired.assetId === "K4")).toBe(false);
    expect(built.deletes).toEqual([]);
  });

  it("leaves managed stores, their memories and non-editable types out", () => {
    const { row, built } = run();
    expect(row("monitors")).toMatchObject({ action: "skip", skipReason: "managed", note: notes.managed });
    expect(row("monitors/m1")).toMatchObject({ action: "skip", skipReason: "managed", targetAssetId: "MM" });
    expect(row("monitors/m2")).toMatchObject({ action: "skip", skipReason: "managed", assetId: "MNEW", targetAssetId: null });
    expect(row("ART")).toMatchObject({ action: "skip", skipReason: "not-editable", note: notes.notEditable });
    expect(built.items.map((i) => i.desired.assetId ?? i.desired.key)).not.toContain("MS");
    expect(countActions(built.rows)).toEqual({ update: 6, create: 1, deactivate: 1, delete: 0, keep: 2, skip: 4 });
    expect(built.problems).toEqual([]);
  });

  it("orders items so stores and skills come before the memories and agents that refer to them", () => {
    const { built } = run();
    const types = built.items.map((i) => i.desired.assetType);
    expect(types.indexOf("memory_store")).toBeLessThan(types.indexOf("memory"));
    expect(types.lastIndexOf("skill")).toBeLessThan(types.indexOf("custom_agent"));
    const order = typeOrder(policy);
    expect(order.get("memory_store")!).toBeLessThan(order.get("memory")!);
    expect(order.get("skill")!).toBeLessThan(order.get("custom_agent")!);
  });

  it("recreates a deleted store before its memories, which refer to it by name", () => {
    const cur = now.map((c) => (c.assetId === "S1" || c.assetId === "M1" ? { ...c, deleted: true } : c));
    const { item, built } = run({ cur });
    const ids = built.items.map((i) => i.desired.key);
    expect(ids.indexOf("runbooks")).toBeLessThan(ids.indexOf("runbooks/db/failover"));
    const memory = item("runbooks/db/failover");
    expect(memory.desired.assetId).toBeUndefined();
    expect(memory.desired.metadata.memory_store_id).toBeUndefined();
    expect(memory.desired.refs).toEqual({ memoryStore: "runbooks" });
    expect(item("C1").desired.metadata.memory_stores).toEqual(["MS"]);
  });

  it("follows a per-type policy: delete and include managed assets", () => {
    const p: Policy = { ...policy, releases: releasesSection.schema.parse({ rollback: { addedAfterTarget: { skill: "deactivate", custom_agent: "delete", default: "keep" }, managed: "include" } }) };
    const { row, built } = run({ p });
    expect(built.deletes).toEqual([{ assetId: "C2", note: p.releases.rollback.notes.deleted }]);
    expect(row("helper").action).toBe("delete");
    expect(row("monitors")).toMatchObject({ action: "update", assetId: "MS" });
    expect(row("monitors/m2")).toMatchObject({ action: "keep" });
  });

  it("refuses an asset whose files can't be read, and keeps the rest", () => {
    const files = filesFor(targets);
    files.set("K3", [{ path: "assets/big.bin", sha256: "x", size: 9_000_000, encoding: "base64" }]);
    files.delete("A1");
    const { row, built } = run({ files });
    expect(row("big").action).toBe("skip");
    expect(row("GENERIC").action).toBe("skip");
    expect(built.problems.map((p) => [p.code, p.assetKey])).toEqual([
      ["rollback.content-missing", "skill:big"],
      ["rollback.content-missing", "agents_md:GENERIC"],
    ]);
    expect(built.problems[0]!.message).toContain("assets/big.bin");
    expect(built.items.some((i) => i.desired.assetId === "K3")).toBe(false);
  });
});

describe("rollback of one asset version", () => {
  it("restores only that asset and leaves everything added since alone", () => {
    const ts = [target("M1", "memory", { name: "db/failover", description: "Failover v1", memory_store_id: "S1" })];
    const { built, item } = run({ scope: "asset", ts });
    expect(built.rows.map((r) => [r.key, r.action])).toEqual([["runbooks/db/failover", "update"]]);
    expect(item("M1").desired).toMatchObject({ assetId: "M1", key: "runbooks/db/failover", refs: { memoryStore: "runbooks" }, metadata: { memory_store_id: "S1" } });
    // status was added after version 1, so it is removed
    expect(item("M1").removeMetadataKeys).toEqual(["status"]);
  });

  it("recreates a deleted asset, keeping references to live assets", () => {
    const ts = [target("K1", "skill", skillMeta("triage"))];
    const { built } = run({ scope: "asset", ts });
    expect(built.items).toHaveLength(1);
    expect(built.items[0]!.desired.assetId).toBeUndefined();
    expect(built.items[0]!.note).toBe(notes.recreated);
  });

  it("warns when the version refers to an asset that no longer exists", () => {
    const ts = [target("C1", "custom_agent", { name: "oncall", skills: ["K1", "K3"] })];
    const { built, item } = run({ scope: "asset", ts });
    expect(item("C1").desired.metadata.skills).toEqual(["K3"]);
    expect(item("C1").desired.refs).toEqual({ skills: ["triage", "big"] });
    expect(built.problems).toEqual([expect.objectContaining({ level: "warning", code: "rollback.reference-missing", assetKey: "custom_agent:oncall" })]);
  });
});
