import path from "node:path";
import type { DevOpsAgentClient } from "@aws-sdk/client-devops-agent";
import type { AssetFileSnapshot, AssetJson, AssetSnapshot } from "@/lib/assets/types";
import { isSafeAssetFilePath, parseAssetJson } from "@/server/assets/repo";
import { type Actor, devOpsAgentClient } from "@/server/aws/clients";
import type { HistoryRepo } from "@/server/git/history-repo";
import type { Policy } from "@/server/policy";
import { toAwsConfig, type SpaceRow } from "@/server/spaces/queries";
import { fileSnapshot, sha256Hex } from "@/server/sync/content";
import { AssetGoneError, SpaceReader } from "@/server/sync/reader";

/**
 * Where rollback content comes from: asset.json and files in the history
 * repository, and, for files git doesn't hold (above the commit threshold)
 * or versions git never recorded, the service through the space's read role.
 */

/**
 * One service version of an asset with every file's content, or null when
 * the service doesn't have it (the asset or version is gone). Timestamps may
 * be empty: the version list is not read.
 */
export type FetchVersion = (asset: { assetId: string; assetType: string }, version: number) => Promise<AssetSnapshot | null>;

/** Content kept for every file, whatever its size: rollback needs the bytes, not a git commit. */
const KEEP_ALL = Number.MAX_SAFE_INTEGER;

/**
 * The default FetchVersion: GetAsset, ListAssetFiles and GetAssetContent
 * (one zip; GetAssetFile for anything the zip lacks), all with assetVersion,
 * through the space's read role. Pass `client` to use another client (tests).
 */
export function serviceVersionFetcher(space: SpaceRow, actor: Actor, policy: Pick<Policy, "api" | "sync">, client?: DevOpsAgentClient): FetchVersion {
  let reader: SpaceReader | null = null;
  const get = () =>
    (reader ??= new SpaceReader(client ?? devOpsAgentClient(toAwsConfig(space), "read", actor), {
      agentSpaceId: space.agentSpaceId,
      pageSize: policy.api.pageSize,
      versionsPageSize: policy.sync.versionsPageSize,
      concurrency: policy.sync.concurrency,
      zipMinFiles: 1,
      maxCommittedFileBytes: KEEP_ALL,
    }));
  return async (asset, version) => {
    try {
      const epoch = new Date(0);
      const snap = await get().snapshot(asset, { version, createdAt: epoch, updatedAt: epoch });
      return { ...snap, createdAt: "", updatedAt: "" };
    } catch (err) {
      if (err instanceof AssetGoneError) return null;
      throw err;
    }
  };
}

/** The full commit hash for a commit, abbreviated hash or tag ref, or null when the repository doesn't have it. */
export async function resolveCommit(repo: HistoryRepo, ref: string): Promise<string | null> {
  const [entry] = await repo.log({ ref, maxCount: 1 });
  return entry?.hash ?? null;
}

export async function readAssetJsonAt(repo: HistoryRepo, commit: string, gitPath: string, layout: Pick<Policy["historyLayout"], "assetJson">): Promise<AssetJson | null> {
  return parseAssetJson(await repo.show(commit, path.posix.join(gitPath, layout.assetJson)));
}

/**
 * Every file listed in asset.json, with content when git holds it and its
 * hash matches. Files without content are the ones to read from the service.
 */
export async function readAssetFilesAt(repo: HistoryRepo, commit: string, gitPath: string, json: AssetJson): Promise<AssetFileSnapshot[]> {
  const out: AssetFileSnapshot[] = [];
  for (const f of json.files) {
    const bare: AssetFileSnapshot = { path: f.path, sha256: f.sha256, size: f.size, encoding: "utf8", ...(f.mimeType ? { mimeType: f.mimeType } : {}) };
    if (!f.committed || !isSafeAssetFilePath(f.path)) {
      out.push(bare);
      continue;
    }
    const bytes = await repo.showBytes(commit, path.posix.join(gitPath, f.path));
    if (!bytes || sha256Hex(bytes) !== f.sha256) {
      out.push(bare);
      continue;
    }
    out.push(fileSnapshot(f.path, bytes, { maxCommittedFileBytes: KEEP_ALL, mimeType: f.mimeType }));
  }
  return out;
}

/**
 * Fill files without content from a version read from the service. A file is
 * taken only when its hash matches the one recorded in git, so the rollback
 * restores exactly the recorded version. Returns the paths filled and the
 * paths still missing.
 */
export function fillFromService(files: AssetFileSnapshot[], fetched: AssetSnapshot | null): { files: AssetFileSnapshot[]; filled: string[]; missing: string[] } {
  const byPath = new Map((fetched?.files ?? []).map((f) => [f.path, f]));
  const filled: string[] = [];
  const missing: string[] = [];
  const out = files.map((f) => {
    if (f.content !== undefined) return f;
    const got = byPath.get(f.path);
    if (got && got.content !== undefined && got.sha256 === f.sha256) {
      filled.push(f.path);
      return { ...f, encoding: got.encoding, content: got.content, size: got.size };
    }
    missing.push(f.path);
    return f;
  });
  return { files: out, filled, missing };
}
