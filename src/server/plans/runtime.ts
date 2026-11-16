import { existsSync } from "node:fs";
import { ListAssetsCommand, type DevOpsAgentClient } from "@aws-sdk/client-devops-agent";
import { and, desc, eq, isNull } from "drizzle-orm";
import { recordAuditEvent } from "@/server/audit-log";
import { type Actor, devOpsAgentClient } from "@/server/aws/clients";
import { pages } from "@/server/aws/paginate";
import { db } from "@/server/db/client";
import { assetChanges, assetIndex, assetReasons } from "@/server/db/schema";
import { HistoryRepo } from "@/server/git/history-repo";
import { getPolicyForRepo, type Policy } from "@/server/policy";
import { getHistoryRepoForSpace, type Space, toAwsConfig, toHistoryRepoConfig } from "@/server/spaces/queries";
import { recordAppliedVersions } from "@/server/sync/engine";
import { withSpaceLock } from "@/server/sync/lock";
import { type LiveAsset, SpaceReader, toLiveAsset } from "@/server/sync/reader";
import type { ApplyDeps, ApplyReader } from "./apply";
import type { CheckDeps, IndexedLiveAsset } from "./check";
import { dbPlanStore } from "./store";

/**
 * Real dependencies of the check and apply jobs (database, the space's
 * clients, the history repository). Unit tests build their own.
 */

/** Policy for a space: app defaults overlaid with its history repository's policy/ directory. */
export async function policyForSpace(space: Space): Promise<Policy> {
  const row = await getHistoryRepoForSpace(space);
  if (!row) return getPolicyForRepo(null).policy;
  const dir = HistoryRepo.workingDirFor(toHistoryRepoConfig(row));
  return getPolicyForRepo(existsSync(dir) ? dir : null).policy;
}

/** Live assets of the space from asset_index (the live index), for set validation and reference names. */
export async function loadLiveIndex(spaceId: string): Promise<IndexedLiveAsset[]> {
  const rows = await db()
    .select({ assetId: assetIndex.assetId, assetType: assetIndex.assetType, name: assetIndex.name, metadata: assetIndex.metadata })
    .from(assetIndex)
    .where(and(eq(assetIndex.spaceId, spaceId), isNull(assetIndex.deletedAt)));
  return rows.map((r) => ({ assetId: r.assetId, assetType: r.assetType, name: r.name, metadata: (r.metadata ?? {}) as Record<string, unknown> }));
}

/** Source label of the recorded change of an asset at this version (for "moved from v<a> to v<b> (<source>)"). */
export async function recordedSource(spaceId: string, assetId: string, version: number): Promise<string | null> {
  const [row] = await db()
    .select({ label: assetChanges.changeSourceLabel, source: assetChanges.changeSource })
    .from(assetChanges)
    .where(and(eq(assetChanges.spaceId, spaceId), eq(assetChanges.assetId, assetId), eq(assetChanges.serviceVersion, version)))
    .orderBy(desc(assetChanges.serviceUpdatedAt))
    .limit(1);
  return row ? (row.label ?? row.source) : null;
}

export function spaceReader(client: DevOpsAgentClient, space: Pick<Space, "agentSpaceId">, policy: Policy): SpaceReader {
  return new SpaceReader(client, {
    agentSpaceId: space.agentSpaceId,
    pageSize: policy.api.pageSize,
    versionsPageSize: policy.sync.versionsPageSize,
    concurrency: policy.sync.concurrency,
    zipMinFiles: policy.sync.zipMinFiles,
    maxCommittedFileBytes: policy.historyLayout.maxCommittedFileBytes,
  });
}

/** SpaceReader plus ListAssets filtered by type (the name check before a create). */
export function applyReader(client: DevOpsAgentClient, space: Pick<Space, "agentSpaceId">, policy: Policy): ApplyReader {
  const reader = spaceReader(client, space, policy);
  return {
    getAsset: (id) => reader.getAsset(id),
    snapshot: (a, v) => reader.snapshot(a, v),
    async listAssetsOfType(assetType) {
      const out: LiveAsset[] = [];
      const request = { agentSpaceId: space.agentSpaceId, assetType, maxResults: policy.api.pageSize };
      for await (const page of pages((req: typeof request & { nextToken?: string }) => client.send(new ListAssetsCommand(req)), request)) {
        for (const a of page.items ?? []) out.push(toLiveAsset(a));
      }
      return out;
    },
  };
}

export async function checkDepsFor(space: Space, actor: Actor, client?: DevOpsAgentClient): Promise<CheckDeps> {
  const policy = await policyForSpace(space);
  const read = client ?? devOpsAgentClient(toAwsConfig(space), "read", actor);
  return {
    store: dbPlanStore,
    policy,
    settings: space.parsedSettings,
    liveIndex: await loadLiveIndex(space.id),
    reader: spaceReader(read, space, policy),
    liveSource: (assetId, version) => recordedSource(space.id, assetId, version),
  };
}

export interface ApplyClients {
  read?: DevOpsAgentClient;
  write?: DevOpsAgentClient;
}

export async function applyDepsFor(space: Space, actor: Actor, clients: ApplyClients = {}): Promise<ApplyDeps> {
  const policy = await policyForSpace(space);
  const read = clients.read ?? devOpsAgentClient(toAwsConfig(space), "read", actor);
  const write = clients.write ?? devOpsAgentClient(toAwsConfig(space), "write", actor);
  return {
    store: dbPlanStore,
    policy,
    space: { id: space.id, agentSpaceId: space.agentSpaceId, settings: space.parsedSettings },
    liveIndex: await loadLiveIndex(space.id),
    reader: applyReader(read, space, policy),
    writer: write,
    recordApplied: (input) => recordAppliedVersions(input, { actor, client: read }, { lock: false }),
    withLock: async (fn) => {
      const locked = await withSpaceLock(space.id, policy.sync.lockWaitSeconds, fn);
      if (!locked.acquired) throw new Error("A sync of this space is still running; apply will retry.");
      return locked.value;
    },
    audit: recordAuditEvent,
    indexReasons: async (rows) => {
      if (!rows.length) return;
      await db()
        .insert(assetReasons)
        .values(rows.map((r) => ({ id: r.id, spaceId: space.id, assetId: r.assetId, commit: r.commit, reason: r.reason, link: null, notesRef: policy.historyLayout.notesRef, addedBy: actor.email })))
        .onConflictDoNothing({ target: assetReasons.id });
    },
  };
}
