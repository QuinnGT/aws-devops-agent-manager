import { createHash } from "node:crypto";
import path from "node:path";
import type { AssetJson } from "@/lib/assets/types";
import { TRAILERS } from "@/lib/assets/types";
import type { HistoryRepo } from "@/server/git/history-repo";
import { assetDir } from "@/server/history/layout";
import type { Policy } from "@/server/policy";

/**
 * Test support: asset.json values and commits shaped like the sync worker
 * writes them. Only used by tests.
 */

export const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export interface TestAsset {
  assetId: string;
  assetType: string;
  metadata: Record<string, unknown>;
  version: number;
  updatedAt: string;
  /** Committed files: path -> content */
  files: Record<string, string | Buffer>;
  /** Files listed in asset.json but not committed (too large) */
  uncommitted?: Record<string, string | Buffer>;
  storeName?: string;
}

export function assetJsonOf(a: TestAsset): AssetJson {
  const listed = [
    ...Object.entries(a.files).map(([p, c]) => ({ path: p, sha256: sha(c), size: Buffer.byteLength(c), committed: true })),
    ...Object.entries(a.uncommitted ?? {}).map(([p, c]) => ({ path: p, sha256: sha(c), size: Buffer.byteLength(c), committed: false })),
  ].sort((x, y) => (x.path < y.path ? -1 : 1));
  return {
    assetId: a.assetId,
    assetType: a.assetType,
    metadata: a.metadata,
    serviceVersion: a.version,
    serviceCreatedAt: "2026-07-01T00:00:00.000Z",
    serviceUpdatedAt: a.updatedAt,
    files: listed,
  };
}

export function dirOf(layout: Policy["historyLayout"], alias: string, a: Pick<TestAsset, "assetId" | "assetType" | "metadata" | "storeName">): string {
  return assetDir(layout, alias, { assetId: a.assetId, assetType: a.assetType, metadata: a.metadata, storeName: a.storeName ?? null });
}

/** Commit one version of an asset (asset.json plus committed files), removing files the previous version had. */
export async function commitVersion(
  repo: HistoryRepo,
  layout: Policy["historyLayout"],
  alias: string,
  a: TestAsset,
  previous?: TestAsset,
): Promise<{ commit: string; gitPath: string }> {
  const dir = dirOf(layout, alias, a);
  const removed = previous ? Object.keys(previous.files).filter((p) => !(p in a.files)) : [];
  const commit = await repo.writeAndCommit(
    [
      { path: path.posix.join(dir, layout.assetJson), content: `${JSON.stringify(assetJsonOf(a), null, 2)}\n` },
      ...Object.entries(a.files).map(([p, c]) => ({ path: path.posix.join(dir, p), content: c })),
      ...removed.map((p) => ({ path: path.posix.join(dir, p), content: null })),
    ],
    {
      message: `${a.assetType} ${a.assetId} version ${a.version}`,
      author: { name: "Test", email: "test@example.com" },
      committer: { name: "Test", email: "test@example.com" },
      date: new Date(a.updatedAt),
      trailers: { [TRAILERS.assetId]: a.assetId, [TRAILERS.assetType]: a.assetType, [TRAILERS.serviceVersion]: a.version, [TRAILERS.serviceUpdatedAt]: a.updatedAt, [TRAILERS.spaceAlias]: alias },
    },
  );
  if (!commit) throw new Error(`no change committing ${a.assetId} v${a.version}`);
  return { commit, gitPath: dir };
}

/** Commit the deletion of an asset (every file its asset.json accounts for). */
export async function commitDelete(repo: HistoryRepo, layout: Policy["historyLayout"], alias: string, a: TestAsset, at: string): Promise<string> {
  const dir = dirOf(layout, alias, a);
  const commit = await repo.writeAndCommit(
    [path.posix.join(dir, layout.assetJson), ...Object.keys(a.files).map((p) => path.posix.join(dir, p))].map((p) => ({ path: p, content: null })),
    {
      message: `delete ${a.assetType} ${a.assetId}`,
      author: { name: "Test", email: "test@example.com" },
      committer: { name: "Test", email: "test@example.com" },
      date: new Date(at),
      trailers: { [TRAILERS.assetId]: a.assetId, [TRAILERS.assetType]: a.assetType, [TRAILERS.spaceAlias]: alias },
    },
  );
  if (!commit) throw new Error(`no change deleting ${a.assetId}`);
  return commit;
}
