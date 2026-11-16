import { randomUUID } from "node:crypto";
import {
  type AssetContent,
  type AssetFileBody,
  CreateAssetCommand,
  CreateAssetFileCommand,
  DeleteAssetCommand,
  DeleteAssetFileCommand,
  ResourceNotFoundException,
  UpdateAssetCommand,
  UpdateAssetFileCommand,
} from "@aws-sdk/client-devops-agent";
import JSZip from "jszip";
import { DevOpsAgentClient } from "@aws-sdk/client-devops-agent";
import { assetDisplayName } from "@/server/history/layout";
import type { DesiredAsset } from "@/server/packages/types";
import type { Policy } from "@/server/policy";
import { assetIdentity } from "@/server/validation/identity";
import type { FakeFile, FakeSpace, FakeVersion } from "@/server/sync/testing/fake-space";
import type { IndexedLiveAsset } from "./check";
import { IdentityIndex } from "./resolve";
import { applyReader } from "./runtime";
import type { ApplyRunPatch, ItemPatch, PlanPatch, PlanStore } from "./store";
import type { ApplyRunRow, PlanItemRow, PlanRow, PlanState } from "./types";

/**
 * Tests only. An in-memory PlanStore, and write handlers for the sync
 * module's FakeSpace: CreateAsset, UpdateAsset, UpdateAssetFile,
 * CreateAssetFile, DeleteAssetFile and DeleteAsset, with clientToken
 * idempotency (a repeated token returns the first response and changes
 * nothing). Write responses follow the SDK types; there are no captured
 * fixtures for them.
 */

export class MemoryPlanStore implements PlanStore {
  plans = new Map<string, PlanRow>();
  items = new Map<string, PlanItemRow>();
  runs = new Map<string, ApplyRunRow>();
  settled: { planId: string; applied: string[]; reopened: string[] }[] = [];
  itemUpdates: { id: string; patch: ItemPatch }[] = [];

  async getPlan(id: string) {
    const p = this.plans.get(id);
    return p ? structuredClone(p) : null;
  }
  async getItems(planId: string) {
    return [...this.items.values()].filter((i) => i.planId === planId).sort((a, b) => a.position - b.position).map((i) => structuredClone(i));
  }
  async updatePlan(id: string, patch: PlanPatch, opts: { whereStates?: readonly PlanState[]; whereCheckRunId?: string | null } = {}) {
    const p = this.plans.get(id);
    if (!p) return false;
    if (opts.whereStates && !opts.whereStates.includes(p.state)) return false;
    if (opts.whereCheckRunId && p.checkRunId !== opts.whereCheckRunId) return false;
    Object.assign(p, patch, { updatedAt: new Date() });
    return true;
  }
  async updateItem(id: string, patch: ItemPatch) {
    const i = this.items.get(id);
    if (!i) throw new Error(`no item ${id}`);
    this.itemUpdates.push({ id, patch: structuredClone(patch) });
    Object.assign(i, structuredClone(patch));
  }
  async applyRunFor(input: { planId: string; spaceId: string; jobRunId: string | null; startedBy: string }) {
    const existing = [...this.runs.values()].find((r) => r.jobRunId === input.jobRunId);
    if (existing) return structuredClone(existing);
    const row: ApplyRunRow = {
      id: randomUUID(),
      planId: input.planId,
      spaceId: input.spaceId,
      jobRunId: input.jobRunId,
      startedBy: input.startedBy,
      status: "running",
      counts: null,
      items: [],
      commits: [],
      finalCommit: null,
      pushed: false,
      pushError: null,
      error: null,
      startedAt: new Date(),
      finishedAt: null,
    };
    this.runs.set(row.id, row);
    return structuredClone(row);
  }
  async updateApplyRun(id: string, patch: ApplyRunPatch) {
    Object.assign(this.runs.get(id)!, patch);
  }
  async settleDrafts(planId: string, applied: readonly string[], reopened: readonly string[]) {
    this.settled.push({ planId, applied: [...applied], reopened: [...reopened] });
  }

  plan(id: string): PlanRow {
    return this.plans.get(id)!;
  }
  item(id: string): PlanItemRow {
    return this.items.get(id)!;
  }
}

export function planRow(overrides: Partial<PlanRow> & Pick<PlanRow, "id" | "spaceId">): PlanRow {
  const now = new Date("2026-11-11T12:00:00.000Z");
  return {
    title: "Test plan",
    origin: { kind: "drafts", draftIds: [] },
    originKind: "drafts",
    state: "checking",
    reason: null,
    notes: [],
    createdBy: "author@example.com",
    createdByName: null,
    checkRunId: null,
    checkRequestedBy: null,
    checkedAt: null,
    checkError: null,
    summary: null,
    validation: [],
    approvalRequestedBy: null,
    approvalRequestedAt: null,
    approvedBy: null,
    approvedByName: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    rejectNote: null,
    applyRunId: null,
    applyStartedBy: null,
    applyStartedAt: null,
    finishedAt: null,
    resultCommit: null,
    discardedBy: null,
    discardedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function itemRow(overrides: Partial<PlanItemRow> & Pick<PlanItemRow, "planId" | "position" | "assetType" | "assetKey">): PlanItemRow {
  const now = new Date("2026-11-11T12:00:00.000Z");
  return {
    id: randomUUID(),
    kind: "upsert",
    name: overrides.assetKey,
    assetId: null,
    desired: null,
    baseVersion: null,
    baseUpdatedAt: null,
    removeMetadataKeys: [],
    note: null,
    draftId: null,
    change: null,
    liveVersion: null,
    liveUpdatedAt: null,
    conflict: null,
    metadataDiff: [],
    contentDiff: [],
    addedLines: 0,
    removedLines: 0,
    validation: [],
    validationStatus: null,
    sizeMeter: null,
    writeSteps: [],
    checkedAt: null,
    progress: null,
    progressMessage: null,
    writeStartedAt: null,
    preWriteVersion: null,
    preWriteUpdatedAt: null,
    writeState: null,
    writtenVersion: null,
    writtenUpdatedAt: null,
    verification: null,
    commit: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function notFound(what: string): ResourceNotFoundException {
  return new ResourceNotFoundException({ message: `${what} not found`, $metadata: {} });
}

function fileOf(path: string, body: AssetFileBody | undefined): FakeFile {
  if (body?.text !== undefined) return { path, text: body.text, mimeType: "text/markdown" };
  if (body?.bytes !== undefined) return { path, bytes: body.bytes };
  throw new Error(`no body for ${path}`);
}

async function filesOf(content: AssetContent | undefined): Promise<FakeFile[] | null> {
  if (!content) return null;
  if (content.file) return [fileOf(content.file.path!, content.file.body)];
  if (content.zip) {
    const zip = await JSZip.loadAsync(content.zip.zipFile!);
    const out: FakeFile[] = [];
    for (const e of Object.values(zip.files)) if (!e.dir) out.push({ path: e.name, text: await e.async("string"), mimeType: "text/markdown" });
    return out;
  }
  throw new Error("unsupported content");
}

function patchMetadata(meta: Record<string, unknown>, patch: Record<string, unknown> | undefined): Record<string, unknown> {
  const out = { ...meta };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

export interface FakeWriteOptions {
  /** Timestamps of writes: starts here and moves one second per write */
  clock?: Date;
  /** Change what a write stores, to simulate a service that rewrites content */
  tamper?: (command: string, version: FakeVersion) => void;
  /** Metadata the service adds on create when missing */
  createDefaults?: Record<string, unknown>;
}

/**
 * Add write handlers to an installed FakeSpace stub. Every call (including
 * repeated tokens) is recorded in `fake.calls`.
 */
export function installWrites(fake: FakeSpace, opts: FakeWriteOptions = {}) {
  const stub = fake.stub;
  if (!stub) throw new Error("install the FakeSpace first");
  let t = (opts.clock ?? new Date("2026-11-12T00:00:00.000Z")).getTime();
  const tick = () => new Date((t += 1000)).toISOString();
  const tokens = new Map<string, unknown>();
  const effects: { command: string; assetId: string; token?: string }[] = [];

  const shape = (assetId: string) => {
    const a = fake.assets.get(assetId)!;
    const v = a.versions.at(-1)!;
    return { assetId, assetType: a.assetType, metadata: structuredClone(v.metadata), version: v.version, createdAt: new Date(a.versions[0]!.createdAt), updatedAt: new Date(v.updatedAt) };
  };
  const once = async <T>(command: string, token: string | undefined, input: object, fn: () => Promise<T>): Promise<T> => {
    fake.calls.push({ command, input: { ...(input as Record<string, unknown>) } });
    if (token && tokens.has(`${command}:${token}`)) return tokens.get(`${command}:${token}`) as T;
    const r = await fn();
    if (token) tokens.set(`${command}:${token}`, r);
    return r;
  };
  const newVersion = (assetId: string, command: string, files: FakeFile[] | null, metadata: Record<string, unknown> | undefined, token?: string) => {
    const a = fake.assets.get(assetId);
    if (!a) throw notFound(`asset ${assetId}`);
    const prev = a.versions.at(-1)!;
    const v: FakeVersion = {
      version: prev.version + 1,
      createdAt: prev.createdAt,
      updatedAt: tick(),
      metadata: patchMetadata(prev.metadata, metadata),
      files: files ?? prev.files.map((f) => ({ ...f })),
    };
    opts.tamper?.(command, v);
    a.versions.push(v);
    effects.push({ command, assetId, token });
    return v;
  };

  stub.on(CreateAssetCommand).callsFake((input) =>
    once("CreateAsset", input.clientToken, input, async () => {
      const files = (await filesOf(input.content))!;
      const assetId = `ki-${randomUUID()}`;
      const at = tick();
      const v: FakeVersion = { version: 1, createdAt: at, updatedAt: at, metadata: { ...(opts.createDefaults ?? {}), ...((input.metadata ?? {}) as Record<string, unknown>) }, files };
      opts.tamper?.("CreateAsset", v);
      fake.add({ assetId, assetType: input.assetType!, versions: [v] });
      effects.push({ command: "CreateAsset", assetId, token: input.clientToken });
      return { asset: shape(assetId) };
    }),
  );

  stub.on(UpdateAssetCommand).callsFake((input) =>
    once("UpdateAsset", input.clientToken, input, async () => {
      const a = fake.assets.get(input.assetId!);
      if (!a) throw notFound(`asset ${input.assetId}`);
      const prev = a.versions.at(-1)!;
      const incoming = await filesOf(input.content);
      if (incoming) {
        const files = input.content?.zip ? incoming : [...prev.files.filter((f) => f.path !== incoming[0]!.path), incoming[0]!];
        newVersion(a.assetId, "UpdateAsset", files, input.metadata as Record<string, unknown> | undefined, input.clientToken);
      } else {
        // Metadata only: the current version changes in place (the test space did this for status).
        prev.metadata = patchMetadata(prev.metadata, input.metadata as Record<string, unknown> | undefined);
        prev.updatedAt = tick();
        opts.tamper?.("UpdateAsset", prev);
        effects.push({ command: "UpdateAsset", assetId: a.assetId, token: input.clientToken });
      }
      return { asset: shape(a.assetId) };
    }),
  );

  for (const [Cmd, name] of [
    [UpdateAssetFileCommand, "UpdateAssetFile"],
    [CreateAssetFileCommand, "CreateAssetFile"],
  ] as const) {
    stub.on(Cmd as typeof UpdateAssetFileCommand).callsFake((input) =>
      once(name, input.clientToken, input, async () => {
        const a = fake.assets.get(input.assetId!);
        if (!a) throw notFound(`asset ${input.assetId}`);
        const prev = a.versions.at(-1)!;
        const f = fileOf(input.path!, input.content);
        const v = newVersion(a.assetId, name, [...prev.files.filter((x) => x.path !== f.path), f], undefined, input.clientToken);
        return { file: { path: f.path, content: input.content, version: v.version, createdAt: new Date(v.updatedAt), updatedAt: new Date(v.updatedAt) } };
      }),
    );
  }

  stub.on(DeleteAssetFileCommand).callsFake((input) =>
    once("DeleteAssetFile", undefined, input, async () => {
      const a = fake.assets.get(input.assetId!);
      if (!a) throw notFound(`asset ${input.assetId}`);
      const prev = a.versions.at(-1)!;
      if (!prev.files.some((f) => f.path === input.path)) throw notFound(`file ${input.path}`);
      newVersion(a.assetId, "DeleteAssetFile", prev.files.filter((f) => f.path !== input.path), undefined);
      return {};
    }),
  );

  stub.on(DeleteAssetCommand).callsFake((input) =>
    once("DeleteAsset", undefined, input, async () => {
      if (!fake.assets.has(input.assetId!)) throw notFound(`asset ${input.assetId}`);
      fake.remove(input.assetId!);
      effects.push({ command: "DeleteAsset", assetId: input.assetId! });
      return {};
    }),
  );

  return { effects, tokens };
}

/** The live index (asset_index shape) of a FakeSpace's latest versions. */
export function liveIndexOf(fake: FakeSpace, policy: Pick<Policy, "historyLayout">): IndexedLiveAsset[] {
  return [...fake.assets.values()].map((a) => {
    const v = a.versions.at(-1)!;
    return { assetId: a.assetId, assetType: a.assetType, metadata: structuredClone(v.metadata), name: assetDisplayName(policy.historyLayout, { assetId: a.assetId, assetType: a.assetType, metadata: v.metadata }) };
  });
}

/** A reader over the mocked client (every DevOpsAgentClient is stubbed by the FakeSpace). */
export function fakeReader(fake: FakeSpace, policy: Policy) {
  const client = new DevOpsAgentClient({ region: "us-west-2", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
  return { client, reader: applyReader(client, { agentSpaceId: fake.agentSpaceId }, policy) };
}

/** The latest version of a fake asset as a DesiredAsset (text files only), with name refs. */
export function desiredOf(fake: FakeSpace, assetId: string, policy: Policy, edit: (d: DesiredAsset) => void = () => {}): DesiredAsset {
  const a = fake.assets.get(assetId)!;
  const v = a.versions.at(-1)!;
  const index = new IdentityIndex(policy, liveIndexOf(fake, policy));
  const entry = policy.assetTypes.assetTypes[a.assetType];
  const refs: Record<string, string | string[]> = {};
  for (const rule of entry?.references ?? []) {
    const id = v.metadata[rule.key];
    if (typeof id === "string") {
      const n = index.lookup(rule.assetType, id);
      if (n) refs[rule.ref] = rule.many ? [n] : n;
    }
  }
  const d: DesiredAsset = {
    assetType: a.assetType,
    assetId,
    key: "",
    metadata: structuredClone(v.metadata),
    files: v.files.map((f) => ({ path: f.path, encoding: "utf8" as const, content: f.text ?? "" })),
    ...(Object.keys(refs).length ? { refs } : {}),
  };
  edit(d);
  d.key = assetIdentity(policy, d, index.lookup);
  return d;
}
