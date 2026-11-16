import {
  type AssetContent,
  type AssetFileBody,
  CreateAssetCommand,
  CreateAssetFileCommand,
  DeleteAssetCommand,
  DeleteAssetFileCommand,
  type DevOpsAgentClient,
  UpdateAssetCommand,
  UpdateAssetFileCommand,
} from "@aws-sdk/client-devops-agent";
import type { AuditEventInput } from "@/server/audit-log";
import { formatReasonNote } from "@/server/assets/reasons";
import type { Actor } from "@/server/aws/clients";
import { metadataHash } from "@/server/history/content-hash";
import type { DesiredAsset, DesiredFile } from "@/server/packages/types";
import { writeZip } from "@/server/packages/zip";
import type { Policy } from "@/server/policy";
import type { SpaceSettings } from "@/server/spaces/settings-schema";
import type { AppliedAsset, RecordAppliedInput, RecordAppliedResult } from "@/server/sync/engine";
import type { LiveAsset } from "@/server/sync/reader";
import { errorsOf } from "@/server/validation/types";
import type { IndexedLiveAsset, LiveReader } from "./check";
import { clientTokenFor } from "./client-token";
import { applyMetadataPatch, desiredContentHash, desiredFileBytes, hashDesiredFiles, metadataPatch, snapshotContentHash } from "./content";
import { applyOrder, IdentityIndex, resolveRefs } from "./resolve";
import type { ItemPatch, PlanStore } from "./store";
import type { ApplyRunItem, ItemConflict, ItemProgress, ItemVerification, PlanItemRow, WriteState, WriteStep } from "./types";

/**
 * The apply job (worker only).
 *
 * For each item, in policy order (stores and skills before memories and
 * custom agents, deletes last): resolve name references to asset IDs,
 * re-read live and skip the item if it changed since the check, write with
 * the plan item ID as clientToken, then read the asset back and compare
 * assetContentHash and metadataHash. Afterwards every written version is
 * recorded in git through the sync module, attributed to the app user.
 *
 * Writes go through the space's write role (devOpsAgentClient(space,
 * "write", actor), actor = the user who started apply). Reads, including the
 * re-read and the read-back, go through the read role, which is the role
 * that holds the Get and List actions.
 */

export interface ApplyReader extends LiveReader {
  /** Every live asset of one type (ListAssets with assetType), for the name check before a create */
  listAssetsOfType(assetType: string): Promise<LiveAsset[]>;
}

export interface ApplyDeps {
  store: PlanStore;
  policy: Pick<Policy, "assetTypes" | "agentTypes" | "limits" | "plans" | "historyLayout">;
  space: { id: string; agentSpaceId: string; settings: Pick<SpaceSettings, "deletesEnabled"> };
  liveIndex: readonly IndexedLiveAsset[];
  reader: ApplyReader;
  writer: Pick<DevOpsAgentClient, "send">;
  /** recordAppliedVersions from the sync module, already inside the space lock */
  recordApplied: (input: RecordAppliedInput) => Promise<RecordAppliedResult>;
  /** Runs the apply inside the space's sync lock, so a sync can't commit the app's versions first */
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  audit: (e: AuditEventInput) => Promise<void>;
  /** Index change reasons in asset_reasons (the git notes are written by recordApplied) */
  indexReasons: (rows: { id: string; assetId: string; commit: string; reason: string }[]) => Promise<void>;
  progress?: (fraction: number, message?: string) => Promise<void>;
  cancelled?: () => Promise<boolean>;
  log?: (message: string, extra?: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface ApplyContext {
  /** job_runs.id of this apply job (pg-boss retries reuse it) */
  runId: string;
  actor: Actor;
}

export type ApplyOutcome =
  | { status: "applied" | "failed"; written: number; skipped: number; failed: number; unchanged: number; commit: string | null; historyError?: string }
  | { status: "skipped"; reason: string };

export class PlanApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanApplyError";
  }
}

const TERMINAL: readonly ItemProgress[] = ["done", "skipped", "failed"];

function errText(err: unknown): string {
  if (err instanceof Error) return `${err.name && err.name !== "Error" ? `${err.name}: ` : ""}${err.message}`.replace(/\s+/g, " ").slice(0, 400);
  return String(err).slice(0, 400);
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && (err.name === "ResourceNotFoundException" || err.name === "NotFoundException");
}

const second = (d: Date | null | undefined) => (d ? Math.floor(d.getTime() / 1000) : null);

/** Live moved since the check: another version, or another updatedAt (to the second). */
export function movedSinceCheck(item: Pick<PlanItemRow, "liveVersion" | "liveUpdatedAt">, live: Pick<LiveAsset, "version" | "updatedAt">): boolean {
  return live.version !== item.liveVersion || second(live.updatedAt) !== second(item.liveUpdatedAt);
}

function fileBody(f: DesiredFile): AssetFileBody {
  return f.encoding === "utf8" ? { text: f.content } : { bytes: desiredFileBytes(f) };
}

function zipOf(files: readonly DesiredFile[]): Uint8Array {
  return writeZip([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => ({ name: f.path, data: desiredFileBytes(f) })));
}

function contentFor(mode: "file" | "zip", files: readonly DesiredFile[], path?: string): AssetContent {
  if (mode === "zip") return { zip: { zipFile: zipOf(files) } };
  const f = path ? files.find((x) => x.path === path) : files[0];
  if (!f) throw new PlanApplyError(`The planned file ${path ?? ""} is missing from the item.`);
  return { file: { path: f.path, body: fileBody(f) } };
}

export async function runPlanApply(planId: string, ctx: ApplyContext, deps: ApplyDeps): Promise<ApplyOutcome> {
  const now = deps.now ?? (() => new Date());
  const plan = await deps.store.getPlan(planId);
  if (!plan) throw new PlanApplyError(`Plan ${planId} not found.`);
  if (plan.state === "applied" || plan.state === "failed") return { status: "skipped", reason: `The plan is already ${plan.state}.` };
  if (plan.state !== "applying") throw new PlanApplyError(`The plan is ${plan.state}; apply starts only from the applying state.`);
  if (plan.spaceId !== deps.space.id) throw new PlanApplyError("The plan belongs to another space.");

  const appUser = plan.applyStartedBy ?? ctx.actor.email;
  const run = await deps.store.applyRunFor({ planId, spaceId: plan.spaceId, jobRunId: ctx.runId, startedBy: appUser });
  if (run.status !== "running") await deps.store.updateApplyRun(run.id, { status: "running", finishedAt: null, error: null });

  return deps.withLock(async () => {
    const items = await deps.store.getItems(planId);
    const applier = new ItemApplier(deps, now);
    for (const it of items) if (it.progress === null) await applier.patch(it, { progress: "waiting", progressMessage: null });
    const ordered = applyOrder(items, deps.policy.plans.applyOrder);
    applier.seedCreated(items);

    // Deletes: the asset's current version is committed to git first.
    const deletes = ordered.filter((i) => i.kind === "delete" && i.change === "delete" && !i.conflict && !TERMINAL.includes(i.progress ?? "waiting") && i.assetId);
    if (deletes.length && deps.space.settings.deletesEnabled) {
      await deps.recordApplied({
        spaceId: plan.spaceId,
        planId,
        appUser,
        assets: deletes.map((i) => ({ assetId: i.assetId!, assetType: i.assetType, app: null })),
      });
    }

    let n = 0;
    for (const item of ordered) {
      n++;
      if (TERMINAL.includes(item.progress ?? "waiting")) continue;
      if (await deps.cancelled?.()) {
        await applier.patch(item, { progress: "skipped", progressMessage: "Apply was cancelled before this item." });
        continue;
      }
      await deps.progress?.((n - 1) / Math.max(1, ordered.length) * 0.9, `Applying ${item.name}`);
      await applier.apply(item);
    }

    // History: every item that started writing, whatever its result.
    await deps.progress?.(0.92, "Recording the applied versions in git");
    const written = ordered.filter((i) => i.writeStartedAt && i.assetId);
    let historyError: string | undefined;
    let lastCommit: string | null = null;
    let pushed = false;
    let pushError: string | null = null;
    if (written.length) {
      try {
        const rec = await deps.recordApplied({
          spaceId: plan.spaceId,
          planId,
          appUser,
          body: [`Applied by plan "${plan.title}" (${planId}).`, ...(plan.approvedBy ? [`Approved by ${plan.approvedByName ?? plan.approvedBy}.`] : [])],
          assets: written.map((i): AppliedAsset => ({
            assetId: i.assetId!,
            assetType: i.assetType,
            app: { before: i.preWriteVersion !== null && i.preWriteUpdatedAt ? { version: i.preWriteVersion, updatedAt: i.preWriteUpdatedAt } : null },
            deleted: i.change === "delete" && i.progress === "done",
            note: plan.reason ? { text: formatReasonNote({ reason: plan.reason, link: null, reasonId: i.id }, { email: appUser }, now()), marker: `Reason-Id: ${i.id}` } : null,
          })),
        });
        for (const i of written) {
          const c = rec.lastCommitByAsset[i.assetId!];
          if (c) await applier.patch(i, { commit: c });
        }
        lastCommit = rec.head ?? rec.commits.at(-1)?.commit ?? written.map((i) => i.commit).filter(Boolean).at(-1) ?? null;
        pushed = rec.pushed;
        pushError = rec.pushError ?? null;
        if (plan.reason) {
          await deps.indexReasons(written.filter((i) => i.commit).map((i) => ({ id: i.id, assetId: i.assetId!, commit: i.commit!, reason: plan.reason! })));
        }
      } catch (err) {
        // The writes stay; the next sync records them (CloudTrail clientTokens point at these plan items).
        historyError = errText(err);
        deps.log?.("recording the applied versions failed", { error: historyError });
      }
    }

    const counts = {
      written: ordered.filter((i) => i.progress === "done" && i.change !== "none").length,
      skipped: ordered.filter((i) => i.progress === "skipped" && !(i.change === "none" && !i.conflict)).length,
      unchanged: ordered.filter((i) => i.progress === "skipped" && i.change === "none" && !i.conflict).length,
      failed: ordered.filter((i) => i.progress === "failed").length,
    };
    const status = counts.failed > 0 ? "failed" : "applied";
    const runItems: ApplyRunItem[] = ordered.map((i) => ({
      planItemId: i.id,
      name: i.name,
      assetType: i.assetType,
      assetId: i.assetId,
      progress: i.progress ?? "waiting",
      message: i.progressMessage,
      version: i.writtenVersion,
      commit: i.commit,
    }));
    const commits = [...new Set(ordered.map((i) => i.commit).filter((c): c is string => Boolean(c)))];
    await deps.store.updateApplyRun(run.id, {
      status: status === "failed" ? "failed" : "succeeded",
      counts,
      items: runItems,
      commits,
      finalCommit: lastCommit,
      pushed,
      pushError,
      error: historyError ? `The changes were applied but not recorded in git: ${historyError}` : null,
      finishedAt: now(),
    });
    await deps.store.updatePlan(planId, { state: status, finishedAt: now(), resultCommit: lastCommit }, { whereStates: ["applying"] });
    const draftOf = (i: PlanItemRow) => (i.draftId ? [i.draftId] : []);
    await deps.store.settleDrafts(
      planId,
      ordered.filter((i) => i.progress === "done").flatMap(draftOf),
      ordered.filter((i) => i.progress !== "done").flatMap(draftOf),
    );
    await deps.audit({
      actor: ctx.actor,
      action: status === "failed" ? "plan.apply.fail" : "plan.apply.finish",
      spaceId: plan.spaceId,
      targetType: "plan",
      targetId: planId,
      result: status === "failed" ? "error" : "ok",
      details: { ...counts, commit: lastCommit, pushed, ...(historyError ? { historyError } : {}), failedItems: runItems.filter((r) => r.progress === "failed").map((r) => ({ name: r.name, message: r.message })) },
    });
    await deps.progress?.(1, status === "failed" ? `${counts.failed} change(s) failed` : `Applied ${counts.written} changes`);
    return { status, ...counts, commit: lastCommit, ...(historyError ? { historyError } : {}) };
  });
}

/** Applies one item at a time and keeps the in-memory rows in step with the store. */
class ItemApplier {
  private readonly index: IdentityIndex;
  private readonly listings = new Map<string, LiveAsset[]>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly deps: ApplyDeps,
    private readonly now: () => Date,
  ) {
    this.index = new IdentityIndex(deps.policy, deps.liveIndex);
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async patch(item: PlanItemRow, patch: ItemPatch): Promise<void> {
    Object.assign(item, patch);
    await this.deps.store.updateItem(item.id, patch);
  }

  /** Assets created by an earlier attempt of this job are known by ID. */
  seedCreated(items: readonly PlanItemRow[]): void {
    for (const i of items) {
      if (i.kind === "upsert" && i.assetId && i.desired) this.index.add(i.assetId, i.desired);
    }
  }

  private skip(item: PlanItemRow, message: string, conflict?: ItemConflict): Promise<void> {
    return this.patch(item, { progress: "skipped", progressMessage: message, ...(conflict ? { conflict } : {}) });
  }

  private fail(item: PlanItemRow, message: string, extra: ItemPatch = {}): Promise<void> {
    return this.patch(item, { progress: "failed", progressMessage: message, ...extra });
  }

  async apply(item: PlanItemRow): Promise<void> {
    if (item.conflict) return this.skip(item, `Skipped: ${(item.conflict as ItemConflict).message}`);
    if (item.change === "none" || item.change === null) return this.skip(item, "No change needed.");
    if (errorsOf((item.validation ?? []) as never[]).length) return this.fail(item, "Validation failed for this asset; fix it and re-check.");
    const steps = (item.writeSteps ?? []) as WriteStep[];
    if (!steps.length) return this.skip(item, "Nothing to write.");
    if (item.kind === "delete" && !this.deps.space.settings.deletesEnabled) return this.fail(item, "Deletes are off for this space.");

    await this.patch(item, { progress: "writing", progressMessage: null });
    try {
      if (item.kind === "delete") return await this.applyDelete(item);
      if (item.change === "create") return await this.applyCreate(item, steps);
      return await this.applyUpdate(item, steps);
    } catch (err) {
      return this.fail(item, `The write failed: ${errText(err)}`);
    }
  }

  private resolved(item: PlanItemRow): { desired: DesiredAsset; unresolved: string[] } {
    const d = item.desired!;
    const r = resolveRefs(this.deps.policy, d, this.index);
    return { desired: { ...d, metadata: r.metadata }, unresolved: r.unresolved };
  }

  private async startWrite(item: PlanItemRow, live: LiveAsset | null, state: WriteState): Promise<WriteState> {
    if (item.writeStartedAt && item.writeState) return item.writeState as WriteState;
    await this.patch(item, {
      writeStartedAt: this.now(),
      preWriteVersion: live?.version ?? null,
      preWriteUpdatedAt: live?.updatedAt ?? null,
      writeState: state,
    });
    return state;
  }

  private async applyCreate(item: PlanItemRow, steps: WriteStep[]): Promise<void> {
    const { desired, unresolved } = this.resolved(item);
    if (unresolved.length) return this.fail(item, `References could not be resolved (${unresolved.join("; ")}): the referenced asset was not created by this plan and is not in the space.`);
    const step = steps[0];
    if (step?.op !== "CreateAsset") return this.fail(item, "The check planned no CreateAsset call for this item.");

    if (!item.writeStartedAt) {
      // An asset with the same name created after the check: skip rather than make a second one.
      const identity = this.index.identityOf(desired);
      let listing = this.listings.get(item.assetType);
      if (!listing) {
        listing = await this.deps.reader.listAssetsOfType(item.assetType);
        this.listings.set(item.assetType, listing);
      }
      const same = identity !== null ? listing.find((a) => this.index.identityOf({ assetType: a.assetType, metadata: a.metadata }) === identity) : undefined;
      if (same) {
        return this.skip(item, "Skipped: an asset with this name was created after the check.", {
          kind: "exists",
          message: "An asset with this name was created after the check. Re-check to plan an update instead.",
          liveVersion: same.version,
          liveUpdatedAt: same.updatedAt.toISOString(),
          atApply: true,
        });
      }
    }
    const state = await this.startWrite(item, null, { metadata: desired.metadata, before: null });
    const res = await this.deps.writer.send(
      new CreateAssetCommand({
        agentSpaceId: this.deps.space.agentSpaceId,
        assetType: item.assetType,
        metadata: state.metadata as never,
        content: contentFor(step.content, desired.files),
        clientToken: clientTokenFor(item.id, 0),
      }),
    );
    const assetId = res.asset?.assetId;
    if (!assetId) return this.fail(item, "CreateAsset returned no asset ID.");
    await this.patch(item, { assetId });
    this.index.add(assetId, { ...desired, metadata: state.metadata });
    this.listings.get(item.assetType)?.push({
      assetId,
      assetType: item.assetType,
      metadata: state.metadata,
      version: res.asset?.version ?? 1,
      createdAt: this.now(),
      updatedAt: this.now(),
    });
    await this.verify(item, assetId, desired.files, state);
  }

  private async applyUpdate(item: PlanItemRow, steps: WriteStep[]): Promise<void> {
    const assetId = item.assetId;
    if (!assetId) return this.fail(item, "The item has no target asset.");
    const { desired, unresolved } = this.resolved(item);
    if (unresolved.length) return this.fail(item, `References could not be resolved (${unresolved.join("; ")}).`);

    const live = await this.deps.reader.getAsset(assetId);
    if (!live) {
      return this.skip(item, "Skipped: the asset was deleted after the check.", { kind: "missing", message: "The asset was deleted after the check.", atApply: true });
    }
    if (!item.writeStartedAt && movedSinceCheck(item, live)) {
      return this.skip(item, `Skipped: live moved from v${item.liveVersion} to v${live.version} after the check.`, {
        kind: "moved",
        message: `Live moved from v${item.liveVersion} to v${live.version} after the check.`,
        baseVersion: item.liveVersion,
        baseUpdatedAt: item.liveUpdatedAt?.toISOString() ?? null,
        liveVersion: live.version,
        liveUpdatedAt: live.updatedAt.toISOString(),
        atApply: true,
      });
    }
    const state = await this.startWrite(item, live, { metadata: metadataPatch(live.metadata, desired.metadata, item.removeMetadataKeys), before: live.metadata });
    const patch = state.metadata;
    const hasPatch = Object.keys(patch).length > 0;
    const files = desired.files;
    const base = { agentSpaceId: this.deps.space.agentSpaceId, assetId };

    for (const [i, s] of steps.entries()) {
      const clientToken = clientTokenFor(item.id, i);
      switch (s.op) {
        case "UpdateAsset":
          await this.deps.writer.send(
            new UpdateAssetCommand({
              ...base,
              ...(s.content ? { content: contentFor(s.content, files, s.path) } : {}),
              ...(hasPatch ? { metadata: patch as never } : {}),
              clientToken,
            }),
          );
          break;
        case "UpdateAssetFile":
        case "CreateAssetFile": {
          const f = files.find((x) => x.path === s.path);
          if (!f) throw new PlanApplyError(`The planned file ${s.path} is missing from the item.`);
          const body = { ...base, path: s.path, content: fileBody(f), clientToken };
          if (s.op === "UpdateAssetFile") await this.deps.writer.send(new UpdateAssetFileCommand(body));
          else await this.deps.writer.send(new CreateAssetFileCommand(body));
          break;
        }
        case "DeleteAssetFile":
          try {
            await this.deps.writer.send(new DeleteAssetFileCommand({ ...base, path: s.path }));
          } catch (err) {
            if (!isNotFound(err)) throw err; // already removed by an earlier attempt
          }
          break;
        default:
          throw new PlanApplyError(`Unexpected write step ${s.op} for an update.`);
      }
    }
    await this.verify(item, assetId, files, state);
  }

  private async applyDelete(item: PlanItemRow): Promise<void> {
    const assetId = item.assetId!;
    const live = await this.deps.reader.getAsset(assetId);
    if (!live) {
      if (item.writeStartedAt) return this.patch(item, { progress: "done", progressMessage: "Deleted." });
      return this.skip(item, "Skipped: the asset was already deleted.");
    }
    if (!item.writeStartedAt && movedSinceCheck(item, live)) {
      return this.skip(item, `Skipped: live moved from v${item.liveVersion} to v${live.version} after the check.`, {
        kind: "moved",
        message: `Live moved from v${item.liveVersion} to v${live.version} after the check.`,
        liveVersion: live.version,
        liveUpdatedAt: live.updatedAt.toISOString(),
        atApply: true,
      });
    }
    await this.startWrite(item, live, { metadata: {}, before: live.metadata });
    try {
      await this.deps.writer.send(new DeleteAssetCommand({ agentSpaceId: this.deps.space.agentSpaceId, assetId }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    await this.patch(item, { progress: "verifying" });
    const after = await this.deps.reader.getAsset(assetId);
    if (after) return this.fail(item, "The asset still exists after DeleteAsset.");
    await this.patch(item, { progress: "done", progressMessage: "Deleted." });
  }

  /** Read the asset back until both hashes match or the attempts run out. */
  private async verify(item: PlanItemRow, assetId: string, files: readonly DesiredFile[], state: WriteState): Promise<void> {
    await this.patch(item, { progress: "verifying" });
    const { readBackAttempts, readBackDelayMs } = this.deps.policy.plans.apply;
    const expectedContentHash = desiredContentHash(files);
    const isCreate = state.before === null;
    let last: ItemVerification | null = null;
    let lastAsset: LiveAsset | null = null;
    for (let attempt = 1; attempt <= readBackAttempts; attempt++) {
      if (attempt > 1) await this.sleep(readBackDelayMs);
      const asset = await this.deps.reader.getAsset(assetId);
      if (!asset) {
        last = { ok: false, expectedContentHash, actualContentHash: null, expectedMetadataHash: metadataHash(state.metadata), actualMetadataHash: "", metadataMismatch: [], fileMismatch: ["(asset not found)"], attempts: attempt };
        continue;
      }
      lastAsset = asset;
      const snap = await this.deps.reader.snapshot(asset, asset);
      const actualContentHash = snapshotContentHash(snap);
      // Creates: the keys apply sent; the service may add its own (status, skill_type). Updates: the whole metadata after the PATCH.
      const expected = isCreate ? state.metadata : applyMetadataPatch(state.before!, state.metadata);
      const actual = isCreate ? Object.fromEntries(Object.keys(state.metadata).filter((k) => k in snap.metadata).map((k) => [k, snap.metadata[k]])) : snap.metadata;
      const expectedMetadataHash = metadataHash(expected);
      const actualMetadataHash = metadataHash(actual);
      const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
      const metadataMismatch = [...keys].filter((k) => metadataHash({ v: expected[k] ?? null }) !== metadataHash({ v: actual[k] ?? null })).sort();
      const want = new Map(hashDesiredFiles(files).map((f) => [f.path, f.sha256]));
      const got = new Map(snap.files.map((f) => [f.path, f.sha256]));
      const fileMismatch = [...new Set([...want.keys(), ...got.keys()])].filter((p) => want.get(p) !== got.get(p)).sort();
      last = {
        ok: actualContentHash === expectedContentHash && actualMetadataHash === expectedMetadataHash,
        expectedContentHash,
        actualContentHash,
        expectedMetadataHash,
        actualMetadataHash,
        metadataMismatch,
        fileMismatch,
        ...(isCreate ? { serviceAddedKeys: Object.keys(snap.metadata).filter((k) => !(k in state.metadata)).sort() } : {}),
        attempts: attempt,
      };
      if (last.ok) break;
    }
    const v = last!;
    const written = lastAsset ? { writtenVersion: lastAsset.version, writtenUpdatedAt: lastAsset.updatedAt } : {};
    if (v.ok) return this.patch(item, { progress: "done", progressMessage: null, verification: v, ...written });
    const parts = [
      v.fileMismatch.length ? `files ${v.fileMismatch.join(", ")}` : null,
      v.metadataMismatch.length ? `metadata ${v.metadataMismatch.join(", ")}` : null,
    ].filter(Boolean);
    return this.fail(item, `The read-back differs from the plan (${parts.join("; ") || "hash mismatch"}). The write stays in the space.`, { verification: v, ...written });
  }
}
