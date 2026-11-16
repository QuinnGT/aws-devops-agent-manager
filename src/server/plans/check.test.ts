import { randomUUID } from "node:crypto";
import { GetAssetCommand } from "@aws-sdk/client-devops-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { type FakeSpace, fixtureSpace } from "@/server/sync/testing/fake-space";
import { runPlanCheck, type CheckDeps } from "./check";
import { desiredOf, fakeReader, itemRow, liveIndexOf, MemoryPlanStore, planRow } from "./testing";
import type { ItemConflict, PlanItemRow, PlanSummary } from "./types";

const policy = getAppPolicy().policy;
const SPACE = "11111111-1111-4111-8111-111111111111";
const AGENTS_MD = "ki-8578b1bb-b5ff-41d8-9368-4f106b846352";
const OVERVIEW = "ki-9184fa09-8e79-4a11-90fa-a6b81ab5fe6b"; // memories in the managed chat-tool-use-best-practices store
const CATEGORY = "ki-53a8c21b-624a-41b5-bc0b-d8dee329f427";
const VERITY_STORE = "ki-f7aad8aa-0449-4221-bd9d-bceee6f33d24";
const VERITY_SKILL = "ki-aa94f065-d420-4979-932c-41327da12ee3";
const CHAT_SKILL = "ki-6e6624f9-cca2-4545-8c89-3519caa36a0f";
const SMALL_SKILL = "ki-bfc466c0-77ed-42e7-a5dc-7881ca27d6cc";

let fake: FakeSpace;
let store: MemoryPlanStore;
let deps: CheckDeps;
const planId = randomUUID();
const runId = randomUUID();

function add(item: Partial<PlanItemRow> & Pick<PlanItemRow, "assetType" | "assetKey">): PlanItemRow {
  const row = itemRow({ planId, position: store.items.size, ...item });
  store.items.set(row.id, row);
  return row;
}

beforeEach(async () => {
  fake = await fixtureSpace();
  fake.install();
  store = new MemoryPlanStore();
  store.plans.set(planId, planRow({ id: planId, spaceId: SPACE, checkRunId: runId }));
  deps = { store, policy, settings: { deletesEnabled: false }, liveIndex: liveIndexOf(fake, policy), reader: fakeReader(fake, policy).reader, liveSource: async () => "Operator Web App", now: () => new Date("2026-11-11T12:00:00.000Z") };
});

afterEach(() => fake.restore());

describe("plan check", () => {
  it("accepts an imported AGENTS.md whose metadata leaves out status: PATCH keeps the live status", async () => {
    const live = fake.latest(AGENTS_MD);
    const md = desiredOf(fake, AGENTS_MD, policy, (d) => {
      d.files[0]!.content += "\nImported rule.\n";
      d.metadata = { agent_type: "GENERIC" }; // what a package import sends; live also has status: ACTIVE
    });
    const item = add({ assetType: "agents_md", assetKey: md.key, assetId: AGENTS_MD, desired: md, baseVersion: live.version, baseUpdatedAt: new Date(live.updatedAt) });
    await runPlanCheck(planId, { runId }, deps);
    const r = store.item(item.id);
    expect((r.validation as { code: string }[]).map((v) => v.code)).not.toContain("edit.status");
    expect(r).toMatchObject({ change: "content", validationStatus: "passed", metadataDiff: [] });
  });

  it("decides the change, diffs, validates and measures each item", async () => {
    const live = fake.latest(AGENTS_MD);
    const md = desiredOf(fake, AGENTS_MD, policy, (d) => (d.files[0]!.content += "\nOne more rule.\n"));
    const content = add({ assetType: "agents_md", assetKey: md.key, assetId: AGENTS_MD, desired: md, baseVersion: live.version, baseUpdatedAt: new Date(live.updatedAt) });
    const status = add({ assetType: "memory", assetKey: "x", assetId: OVERVIEW, desired: desiredOf(fake, OVERVIEW, policy, (d) => (d.metadata.status = "INACTIVE")) });
    const managedEdit = add({ assetType: "memory", assetKey: "y", assetId: CATEGORY, desired: desiredOf(fake, CATEGORY, policy, (d) => (d.files[0]!.content = "rewritten")) });
    const same = add({ assetType: "skill", assetKey: "z", assetId: CHAT_SKILL, desired: desiredOf(fake, CHAT_SKILL, policy) });

    const out = await runPlanCheck(planId, { runId }, deps);
    expect(out.status).toBe("checked");

    const c = store.item(content.id);
    expect(c).toMatchObject({ change: "content", liveVersion: 5, conflict: null, validationStatus: "passed", addedLines: 2, removedLines: 0 });
    expect(c.writeSteps).toEqual([{ op: "UpdateAsset", content: "file", path: "AGENTS.md" }]);
    expect(c.sizeMeter).toMatchObject({ level: "ok", maxBytes: 25600 });
    expect((c.contentDiff as { path: string }[]).map((f) => f.path)).toEqual(["AGENTS.md"]);

    const s = store.item(status.id);
    expect(s).toMatchObject({ change: "status", validationStatus: "passed", writeSteps: [{ op: "UpdateAsset", content: null }] });
    expect(s.metadataDiff).toEqual([{ key: "status", kind: "changed", before: "ACTIVE", after: "INACTIVE" }]);

    // The API writes a managed memory's content, so plans.yaml allows it.
    const m = store.item(managedEdit.id);
    expect(m.validationStatus).toBe("passed");
    expect((m.validation as { code: string }[]).map((r) => r.code)).not.toContain("managed.content");

    expect(store.item(same.id)).toMatchObject({ change: "none", writeSteps: [] });

    const plan = store.plan(planId);
    expect(plan).toMatchObject({ state: "ready", checkError: null });
    expect(plan.summary as PlanSummary).toMatchObject({ items: 4, contentUpdates: 2, statusChanges: 1, unchanged: 1, writes: 3, validation: { failedAssets: 0 } });
  });

  it("flags an item whose live version moved past its base, with the source of the change", async () => {
    const d = desiredOf(fake, VERITY_STORE, policy, (x) => (x.files[0]!.content = "new readme"));
    fake.addVersion(VERITY_STORE, { updatedAt: "2026-11-11T09:00:00.000Z" });
    const item = add({ assetType: "memory_store", assetKey: d.key, assetId: VERITY_STORE, desired: d, baseVersion: 1, baseUpdatedAt: new Date("2026-01-01T00:00:00Z") });
    await runPlanCheck(planId, { runId }, deps);
    const conflict = store.item(item.id).conflict as ItemConflict;
    expect(conflict).toMatchObject({ kind: "moved", baseVersion: 1, liveVersion: 2, source: "Operator Web App" });
    expect((store.plan(planId).summary as PlanSummary).skipped).toBe(1);

    // Re-check from the callout plans against the new live version.
    store.plan(planId).state = "checking";
    await runPlanCheck(planId, { runId, rebase: true }, deps);
    expect(store.item(item.id)).toMatchObject({ conflict: null, baseVersion: 2, change: "content" });
  });

  it("validates creates and references against the set and the live index, and matches a same-name live asset", async () => {
    const store1 = { assetType: "memory_store", key: "runbooks", metadata: { name: "runbooks", description: "Runbooks", agent_types: ["GENERIC"] }, files: [{ path: "README.md", encoding: "utf8" as const, content: "# Runbooks\n" }] };
    const mem = { assetType: "memory", key: "runbooks/db/failover", metadata: { name: "db/failover", description: "Failover" }, refs: { memoryStore: "runbooks" }, files: [{ path: "failover.md", encoding: "utf8" as const, content: "steps" }] };
    const orphan = { assetType: "memory", key: "nope/x", metadata: { name: "x", description: "X" }, refs: { memoryStore: "nope" }, files: [{ path: "x.md", encoding: "utf8" as const, content: "x" }] };
    const sameName = desiredOf(fake, SMALL_SKILL, policy, (d) => {
      delete d.assetId;
      d.metadata.status = "ACTIVE";
    });
    const a = add({ assetType: "memory_store", assetKey: store1.key, desired: store1 });
    const b = add({ assetType: "memory", assetKey: mem.key, desired: mem });
    const c = add({ assetType: "memory", assetKey: orphan.key, desired: orphan });
    const d = add({ assetType: "skill", assetKey: sameName.key, desired: sameName });
    const del = add({ kind: "delete", assetType: "skill", assetKey: "verity", assetId: VERITY_SKILL });

    await runPlanCheck(planId, { runId }, deps);
    expect(store.item(a.id)).toMatchObject({ change: "create", validationStatus: "passed", writeSteps: [{ op: "CreateAsset", content: "file" }] });
    expect(store.item(b.id)).toMatchObject({ change: "create", validationStatus: "passed" });
    expect((store.item(c.id).validation as { code: string }[]).map((r) => r.code)).toContain("reference.unresolved");
    expect(store.item(d.id)).toMatchObject({ assetId: SMALL_SKILL, change: "status", note: "Matched to the live asset with the same name." });
    expect(store.item(d.id).desired?.assetId).toBe(SMALL_SKILL);
    expect((store.item(del.id).validation as { code: string }[]).map((r) => r.code)).toEqual(["delete.disabled"]);
  });

  it("does nothing when a newer check was requested, and records a read failure as the check error", async () => {
    add({ assetType: "agents_md", assetKey: "GENERIC", assetId: AGENTS_MD, desired: desiredOf(fake, AGENTS_MD, policy) });
    expect(await runPlanCheck(planId, { runId: randomUUID() }, deps)).toMatchObject({ status: "skipped" });
    expect(store.plan(planId).state).toBe("checking");

    fake.stub!.on(GetAssetCommand).rejects(Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" }));
    await expect(runPlanCheck(planId, { runId }, { ...deps, policy: { ...policy, api: { ...policy.api, maxAttempts: 1 } } as typeof policy })).rejects.toThrow("Rate exceeded");
    expect(store.plan(planId)).toMatchObject({ state: "ready", checkError: expect.stringContaining("Rate exceeded") });
  });
});
