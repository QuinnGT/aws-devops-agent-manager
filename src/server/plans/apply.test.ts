import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevOpsAgentClient } from "@aws-sdk/client-devops-agent";
import { getAppPolicy } from "@/server/policy";
import type { DesiredAsset } from "@/server/packages/types";
import type { RecordAppliedInput, RecordAppliedResult } from "@/server/sync/engine";
import { type FakeSpace, fixtureSpace } from "@/server/sync/testing/fake-space";
import { type ApplyDeps, runPlanApply } from "./apply";
import { runPlanCheck } from "./check";
import { desiredOf, fakeReader, installWrites, itemRow, liveIndexOf, MemoryPlanStore, planRow } from "./testing";
import type { ItemConflict, ItemVerification, PlanItemRow } from "./types";

const policy = getAppPolicy().policy;
const SPACE = "11111111-1111-4111-8111-111111111111";
const AGENTS_MD = "ki-8578b1bb-b5ff-41d8-9368-4f106b846352";
const OVERVIEW = "ki-9184fa09-8e79-4a11-90fa-a6b81ab5fe6b";
const VERITY_SKILL = "ki-aa94f065-d420-4979-932c-41327da12ee3";
const USER = "publisher@example.com";

let fake: FakeSpace;
let store: MemoryPlanStore;
let writes: ReturnType<typeof installWrites>;
let client: DevOpsAgentClient;
let planId: string;
let recordApplied: ReturnType<typeof vi.fn<(input: RecordAppliedInput) => Promise<RecordAppliedResult>>>;
let audit: ReturnType<typeof vi.fn<ApplyDeps["audit"]>>;

function add(item: Partial<PlanItemRow> & Pick<PlanItemRow, "assetType" | "assetKey">): PlanItemRow {
  const row = itemRow({ planId, position: store.items.size, ...item });
  store.items.set(row.id, row);
  return row;
}

function deps(over: Partial<ApplyDeps> = {}): ApplyDeps {
  const fr = fakeReader(fake, policy);
  return {
    store,
    policy,
    space: { id: SPACE, agentSpaceId: fake.agentSpaceId, settings: { deletesEnabled: false } },
    liveIndex: liveIndexOf(fake, policy),
    reader: fr.reader,
    writer: client,
    recordApplied,
    withLock: (fn) => fn(),
    audit,
    indexReasons: vi.fn(async () => {}),
    sleep: async () => {},
    ...over,
  };
}

/** Run the real check, then move the plan to applying as startApply does. */
async function check(settings = { deletesEnabled: false }) {
  const runId = randomUUID();
  store.plan(planId).checkRunId = runId;
  const d = deps();
  await runPlanCheck(planId, { runId }, { store, policy, settings, liveIndex: d.liveIndex, reader: d.reader });
  Object.assign(store.plan(planId), { state: "applying", applyStartedBy: USER, reason: "v2 audit" });
}

const tokensOf = (command: string) => fake.callsOf(command).map((c) => c.input.clientToken);

beforeEach(async () => {
  fake = await fixtureSpace();
  fake.install();
  writes = installWrites(fake, { createDefaults: { status: "ACTIVE" } });
  client = fakeReader(fake, policy).client;
  store = new MemoryPlanStore();
  planId = randomUUID();
  store.plans.set(planId, planRow({ id: planId, spaceId: SPACE, title: "Runbooks" }));
  recordApplied = vi.fn(async (input: RecordAppliedInput) => ({
    commits: input.assets.map((a, i) => ({ assetId: a.assetId, version: 1, updatedAt: new Date().toISOString(), commit: `c${i}`, app: a.app !== null })),
    lastCommitByAsset: Object.fromEntries(input.assets.map((a, i) => [a.assetId, `c${i}`])),
    notes: [],
    head: `head-${input.assets.length}`,
    pushed: false,
  }));
  audit = vi.fn<ApplyDeps["audit"]>(async () => {});
});

afterEach(() => fake.restore());

function newStore(): DesiredAsset {
  return { assetType: "memory_store", key: "runbooks", metadata: { name: "runbooks", description: "Runbooks for the on-call", agent_types: ["GENERIC"] }, files: [{ path: "README.md", encoding: "utf8", content: "# Runbooks\n" }] };
}
function newMemory(): DesiredAsset {
  return { assetType: "memory", key: "runbooks/db/failover", metadata: { name: "db/failover", description: "Database failover steps" }, refs: { memoryStore: "runbooks" }, files: [{ path: "failover.md", encoding: "utf8", content: "1. Promote the replica.\n" }] };
}

describe("apply job", () => {
  it("writes each item once with its plan item ID as clientToken, stores first, and verifies every read-back", async () => {
    const mem = add({ assetType: "memory", assetKey: "runbooks/db/failover", desired: newMemory() });
    const md = add({ assetType: "agents_md", assetKey: "GENERIC", assetId: AGENTS_MD, desired: desiredOf(fake, AGENTS_MD, policy, (d) => (d.files[0]!.content += "\nNew rule.\n")) });
    const st = add({ assetType: "memory_store", assetKey: "runbooks", desired: newStore() });
    const sw = add({ assetType: "memory", assetKey: "status", assetId: OVERVIEW, desired: desiredOf(fake, OVERVIEW, policy, (d) => (d.metadata.status = "INACTIVE")) });
    await check();
    const before = fake.latest(AGENTS_MD).version;

    const out = await runPlanApply(planId, { runId: randomUUID(), actor: { email: USER } }, deps());
    expect(out).toMatchObject({ status: "applied", written: 4, failed: 0, skipped: 0 });

    // Order: the store before the memory that refers to it by name; one token per call, each the plan item ID.
    expect(writes.effects.map((e) => e.token)).toEqual([st.id, md.id, mem.id, sw.id]);
    expect(tokensOf("CreateAsset")).toEqual([st.id, mem.id]);
    expect(tokensOf("UpdateAsset")).toEqual([md.id, sw.id]);
    const storeId = store.item(st.id).assetId!;
    expect(storeId).toMatch(/^ki-/);
    expect(fake.callsOf("CreateAsset")[1]!.input.metadata).toEqual({ name: "db/failover", description: "Database failover steps", memory_store_id: storeId });

    // A content update is one call with the file; a status switch sends only the changed key.
    expect(fake.callsOf("UpdateAsset")[0]!.input).toMatchObject({ assetId: AGENTS_MD, content: { file: { path: "AGENTS.md" } } });
    expect(fake.callsOf("UpdateAsset")[0]!.input.metadata).toBeUndefined();
    expect(fake.callsOf("UpdateAsset")[1]!.input).toMatchObject({ assetId: OVERVIEW, metadata: { status: "INACTIVE" } });
    expect(fake.callsOf("UpdateAsset")[1]!.input.content).toBeUndefined();
    expect(fake.latest(AGENTS_MD).version).toBe(before + 1);

    for (const id of [mem.id, md.id, st.id, sw.id]) {
      const i = store.item(id);
      expect(i.progress).toBe("done");
      expect((i.verification as ItemVerification).ok).toBe(true);
      expect(i.commit).toMatch(/^c\d$/);
    }
    expect((store.item(st.id).verification as ItemVerification).serviceAddedKeys).toEqual(["status"]);
    expect(store.item(md.id)).toMatchObject({ preWriteVersion: before, writtenVersion: before + 1 });

    // History: every written asset with its starting point, one note per item.
    const rec = recordApplied.mock.calls[0]![0];
    expect(rec).toMatchObject({ spaceId: SPACE, planId, appUser: USER });
    expect(rec.assets.find((a) => a.assetId === AGENTS_MD)).toMatchObject({ app: { before: { version: before } }, note: { marker: `Reason-Id: ${md.id}` } });
    expect(rec.assets.find((a) => a.assetId === storeId)!.app).toEqual({ before: null });
    expect(rec.body?.[0]).toContain("Runbooks");

    expect(store.plan(planId)).toMatchObject({ state: "applied", resultCommit: "head-4" });
    expect([...store.runs.values()][0]).toMatchObject({ status: "succeeded", finalCommit: "head-4" });
    expect(out).toMatchObject({ commit: "head-4" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "plan.apply.finish", result: "ok", actor: { email: USER } }));
    expect(store.settled[0]).toMatchObject({ planId });
  });

  it("re-reads live before each write and skips an item that changed since the check", async () => {
    const md = add({ assetType: "agents_md", assetKey: "GENERIC", assetId: AGENTS_MD, desired: desiredOf(fake, AGENTS_MD, policy, (d) => (d.files[0]!.content = "# Mine\n")) });
    const sw = add({ assetType: "memory", assetKey: "status", assetId: OVERVIEW, desired: desiredOf(fake, OVERVIEW, policy, (d) => (d.metadata.status = "INACTIVE")) });
    await check();
    // A console edit after the check, and a status switch in place (same version, new updatedAt).
    fake.addVersion(AGENTS_MD, { updatedAt: "2026-11-11T13:00:00.000Z", files: [{ path: "AGENTS.md", text: "# Console\n" }] });
    fake.updateInPlace(OVERVIEW, { status: "ACTIVE" }, "2026-11-11T13:05:00.000Z");

    const out = await runPlanApply(planId, { runId: randomUUID(), actor: { email: USER } }, deps());
    expect(out).toMatchObject({ status: "applied", written: 0, skipped: 2 });
    expect(fake.callsOf("UpdateAsset")).toHaveLength(0);
    expect(store.item(md.id)).toMatchObject({ progress: "skipped", writeStartedAt: null });
    expect(store.item(md.id).conflict as ItemConflict).toMatchObject({ kind: "moved", atApply: true, liveVersion: 6 });
    expect(store.item(sw.id).progress).toBe("skipped");
    expect(fake.latest(AGENTS_MD).files[0]!.text).toBe("# Console\n");
    expect(recordApplied).not.toHaveBeenCalled();
  });

  it("marks an item Failed when the read-back differs, and keeps going", async () => {
    writes = installWrites(fake, {
      tamper: (command, v) => {
        if (command === "UpdateAsset" && v.files[0]?.path === "AGENTS.md") v.files[0].text = "# Rewritten by the service\n";
      },
    });
    const md = add({ assetType: "agents_md", assetKey: "GENERIC", assetId: AGENTS_MD, desired: desiredOf(fake, AGENTS_MD, policy, (d) => (d.files[0]!.content = "# Mine\n")) });
    const st = add({ assetType: "memory_store", assetKey: "runbooks", desired: newStore() });
    await check();
    const getAssets = () => fake.callsOf("GetAsset").filter((c) => c.input.assetId === AGENTS_MD && c.input.assetVersion === undefined).length;
    const reads = getAssets();

    const out = await runPlanApply(planId, { runId: randomUUID(), actor: { email: USER } }, deps());
    expect(out).toMatchObject({ status: "failed", failed: 1, written: 1 });
    const item = store.item(md.id);
    expect(item.progress).toBe("failed");
    expect(item.progressMessage).toContain("The read-back differs from the plan (files AGENTS.md)");
    expect(item.verification as ItemVerification).toMatchObject({ ok: false, fileMismatch: ["AGENTS.md"], metadataMismatch: [], attempts: 3 });
    expect(getAssets() - reads).toBe(1 + 3); // the re-read before the write, then three read-backs
    expect(store.item(st.id).progress).toBe("done");
    // The failed write is still recorded in git: it is in the space.
    expect(recordApplied.mock.calls[0]![0].assets.map((a) => a.assetId)).toContain(AGENTS_MD);
    expect(store.plan(planId).state).toBe("failed");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "plan.apply.fail", result: "error" }));
  });

  it("a retried job resumes without writing twice: finished items are left alone, started ones re-send the same token", async () => {
    const st = add({ assetType: "memory_store", assetKey: "runbooks", desired: newStore() });
    const md = add({ assetType: "agents_md", assetKey: "GENERIC", assetId: AGENTS_MD, desired: desiredOf(fake, AGENTS_MD, policy, (d) => (d.files[0]!.content = "# Mine\n")) });
    const sw = add({ assetType: "memory", assetKey: "status", assetId: OVERVIEW, desired: desiredOf(fake, OVERVIEW, policy, (d) => (d.metadata.status = "INACTIVE")) });
    await check();
    const before = fake.latest(AGENTS_MD).version;

    // The database goes away right after the AGENTS.md write is sent: the job dies mid-item.
    let down = false;
    const update = store.updateItem.bind(store);
    store.updateItem = async (id, patch) => {
      if (down) throw new Error("connection terminated");
      return update(id, patch);
    };
    const crashing = { send: async (cmd: Parameters<DevOpsAgentClient["send"]>[0]) => {
      const r = await client.send(cmd as never);
      if ((cmd.input as { clientToken?: string }).clientToken === md.id) down = true;
      return r;
    } } as unknown as DevOpsAgentClient;
    const runId = randomUUID();
    await expect(runPlanApply(planId, { runId, actor: { email: USER } }, deps({ writer: crashing }))).rejects.toThrow("connection terminated");
    expect(store.item(st.id).progress).toBe("done");
    expect(store.item(md.id)).toMatchObject({ progress: "writing", writeStartedAt: expect.any(Date) });
    expect(fake.latest(AGENTS_MD).version).toBe(before + 1);

    // pg-boss retries the same job.
    down = false;
    const out = await runPlanApply(planId, { runId, actor: { email: USER } }, deps());
    expect(out).toMatchObject({ status: "applied", written: 3 });
    expect(tokensOf("CreateAsset")).toEqual([st.id]);
    expect(tokensOf("UpdateAsset")).toEqual([md.id, md.id, sw.id]);
    expect(writes.effects.filter((e) => e.token === md.id)).toHaveLength(1);
    expect(fake.latest(AGENTS_MD).version).toBe(before + 1);
    expect(store.item(md.id)).toMatchObject({ progress: "done", preWriteVersion: before });
    expect(store.runs.size).toBe(1);

    // A third delivery of a finished job does nothing.
    expect(await runPlanApply(planId, { runId, actor: { email: USER } }, deps())).toMatchObject({ status: "skipped" });
  });

  it("resolves name references on update items too, to a store created earlier in the same plan", async () => {
    const VERITY_MEMORY = "ki-b77513b3-2248-43cc-a063-1abec03216fb";
    const oldStore = fake.latest(VERITY_MEMORY).metadata.memory_store_id;
    // As rollbacks and imports send it: every reference by name, and the ID field of a recreated asset dropped.
    const moved = desiredOf(fake, VERITY_MEMORY, policy, (d) => {
      delete d.metadata.memory_store_id;
      d.refs = { memoryStore: "runbooks" };
    });
    const same = desiredOf(fake, VERITY_MEMORY, policy);
    expect(same.refs).toEqual({ memoryStore: "verity" });
    const mem = add({ assetType: "memory", assetKey: moved.key, assetId: VERITY_MEMORY, desired: moved });
    const st = add({ assetType: "memory_store", assetKey: "runbooks", desired: newStore() });
    await check();
    const checked = store.item(mem.id);
    expect(checked).toMatchObject({ change: "metadata", validationStatus: "passed", writeSteps: [{ op: "UpdateAsset", content: null }] });
    expect(checked.metadataDiff).toEqual([{ key: "memory_store_id", kind: "changed", before: oldStore, after: "(new ID of runbooks)" }]);

    const out = await runPlanApply(planId, { runId: randomUUID(), actor: { email: USER } }, deps());
    expect(out).toMatchObject({ status: "applied", written: 2 });
    const storeId = store.item(st.id).assetId!;
    expect(writes.effects.map((e) => e.token)).toEqual([st.id, mem.id]);
    expect(fake.callsOf("UpdateAsset")[0]!.input).toMatchObject({ assetId: VERITY_MEMORY, metadata: { memory_store_id: storeId } });
    expect(fake.latest(VERITY_MEMORY).metadata.memory_store_id).toBe(storeId);
    expect(store.item(mem.id)).toMatchObject({ progress: "done", writeState: { metadata: { memory_store_id: storeId } } });
  });

  it("skips a create when an asset with the same name appeared after the check", async () => {
    const st = add({ assetType: "memory_store", assetKey: "runbooks", desired: newStore() });
    await check();
    fake.add({ assetId: "ki-00000000-0000-4000-8000-000000000001", assetType: "memory_store", versions: [{ version: 1, createdAt: "2026-11-11T13:00:00.000Z", updatedAt: "2026-11-11T13:00:00.000Z", metadata: { name: "runbooks" }, files: [] }] });
    const out = await runPlanApply(planId, { runId: randomUUID(), actor: { email: USER } }, deps());
    expect(out).toMatchObject({ skipped: 1, written: 0 });
    expect(store.item(st.id).conflict as ItemConflict).toMatchObject({ kind: "exists", atApply: true });
    expect(fake.callsOf("CreateAsset")).toHaveLength(0);
  });

  it("commits the current version before a delete, then deletes and records it", async () => {
    const del = add({ kind: "delete", assetType: "skill", assetKey: "verity", name: "verity", assetId: VERITY_SKILL });
    await check({ deletesEnabled: true });
    expect(store.item(del.id)).toMatchObject({ change: "delete", validationStatus: "passed" });
    const out = await runPlanApply(planId, { runId: randomUUID(), actor: { email: USER } }, deps({ space: { id: SPACE, agentSpaceId: fake.agentSpaceId, settings: { deletesEnabled: true } } }));
    expect(out).toMatchObject({ status: "applied", written: 1 });
    expect(recordApplied.mock.calls[0]![0].assets).toEqual([{ assetId: VERITY_SKILL, assetType: "skill", app: null }]);
    expect(fake.callsOf("DeleteAsset")).toHaveLength(1);
    expect(fake.assets.has(VERITY_SKILL)).toBe(false);
    expect(recordApplied.mock.calls[1]![0].assets[0]).toMatchObject({ assetId: VERITY_SKILL, deleted: true });
  });
});
