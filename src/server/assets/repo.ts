import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { TRAILERS, type AssetJson } from "@/lib/assets/types";
import { mapLimit } from "@/server/aws/paginate";
import { HistoryRepo, type HistoryRepoConfig, type LogEntry } from "@/server/git/history-repo";
import { getAppPolicy, type Policy } from "@/server/policy";
import { getHistoryRepoForSpace, toHistoryRepoConfig, type SpaceRow } from "@/server/spaces/queries";
import { ASSET_BROWSER } from "./config";
import type { VersionContent, VersionFile } from "./diff";

/**
 * Read access to a space's history repository for the asset browser. Never
 * writes, and never initializes a missing working copy (that is the worker's
 * job), so it is safe in the web process.
 */

export type SpaceRepo =
  | { ok: true; repo: HistoryRepo; layout: Policy["historyLayout"] }
  | { ok: false; reason: "no-repo" | "not-cloned"; message: string };

/** Open the working copy only if it already exists. */
export async function openExistingHistoryRepo(config: HistoryRepoConfig): Promise<HistoryRepo | null> {
  const dir = HistoryRepo.workingDirFor(config);
  if (!existsSync(path.join(dir, ".git"))) return null;
  return HistoryRepo.open(config);
}

export async function openSpaceHistoryRepo(space: SpaceRow, layout: Policy["historyLayout"] = getAppPolicy().policy.historyLayout): Promise<SpaceRepo> {
  const row = await getHistoryRepoForSpace(space);
  if (!row) return { ok: false, reason: "no-repo", message: "This space has no history repository. An Admin can set one in the space settings." };
  const repo = await openExistingHistoryRepo(toHistoryRepoConfig(row));
  if (!repo) return { ok: false, reason: "not-cloned", message: `The history repository ${row.name} has no working copy yet. The first sync creates it.` };
  return { ok: true, repo, layout };
}

const assetJsonSchema = z.object({
  assetId: z.string(),
  assetType: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  serviceVersion: z.number().int(),
  serviceCreatedAt: z.string(),
  serviceUpdatedAt: z.string(),
  files: z
    .array(
      z.object({
        path: z.string(),
        sha256: z.string(),
        size: z.number(),
        committed: z.boolean(),
        mimeType: z.string().optional(),
      }),
    )
    .default([]),
});

export function parseAssetJson(text: string | null): AssetJson | null {
  if (!text) return null;
  try {
    const r = assetJsonSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** A file path from asset.json that stays inside the asset directory. */
export function isSafeAssetFilePath(p: string): boolean {
  if (!p || p.includes("\0") || p.includes("\\") || p.startsWith("/")) return false;
  const norm = path.posix.normalize(p);
  return norm === p && !norm.startsWith("../") && norm !== ".." && !norm.split("/").includes("..");
}

export interface CommittedAsset extends VersionContent {
  /** The commit the content was read from */
  commit: string;
  assetJson: AssetJson;
}

/**
 * The asset's asset.json and committed files at one commit (default HEAD).
 * Files listed in asset.json but not committed come back with content null.
 */
export async function readCommittedAsset(
  repo: HistoryRepo,
  gitPath: string,
  layout: Pick<Policy["historyLayout"], "assetJson">,
  ref: string = "HEAD",
  opts: { maxFileBytes?: number } = {},
): Promise<CommittedAsset | null> {
  const commit = ref === "HEAD" ? await repo.head() : ref;
  if (!commit) return null;
  const assetJson = parseAssetJson(await repo.show(commit, path.posix.join(gitPath, layout.assetJson)));
  if (!assetJson) return null;
  const maxBytes = opts.maxFileBytes ?? ASSET_BROWSER.maxInlineFileBytes;
  const files = await mapLimit(assetJson.files, ASSET_BROWSER.gitReadConcurrency, async (f): Promise<VersionFile> => {
    const base = { path: f.path, sha256: f.sha256, size: f.size, committed: f.committed };
    if (!f.committed || !isSafeAssetFilePath(f.path) || f.size > maxBytes) return { ...base, content: null };
    return { ...base, content: await repo.show(commit, path.posix.join(gitPath, f.path)) };
  });
  return { commit, assetJson, files };
}

/** One committed file's content at a commit, if asset.json lists it as committed. */
export async function readCommittedFile(
  repo: HistoryRepo,
  gitPath: string,
  layout: Pick<Policy["historyLayout"], "assetJson">,
  filePath: string,
  ref: string = "HEAD",
): Promise<{ content: string; mimeType?: string } | null> {
  if (!isSafeAssetFilePath(filePath)) return null;
  const commit = ref === "HEAD" ? await repo.head() : ref;
  if (!commit) return null;
  const assetJson = parseAssetJson(await repo.show(commit, path.posix.join(gitPath, layout.assetJson)));
  const entry = assetJson?.files.find((f) => f.path === filePath && f.committed);
  if (!entry) return null;
  const content = await repo.show(commit, path.posix.join(gitPath, filePath));
  return content === null ? null : { content, mimeType: entry.mimeType };
}

/**
 * Commits that touched the asset directory, newest first. A commit whose
 * Asset-Id trailer names another asset is dropped: memory directories can
 * nest ("categories" and "categories/x"), so a path match alone is not enough.
 */
export async function listAssetCommits(repo: HistoryRepo, gitPath: string, assetId: string, maxCount: number = ASSET_BROWSER.maxAssetCommits): Promise<LogEntry[]> {
  const log = await repo.log({ path: gitPath, maxCount });
  return log.filter((c) => {
    const id = c.trailers[TRAILERS.assetId];
    return id === undefined || id === assetId;
  });
}

/** Git notes (change reasons) for commits, keyed by commit hash. */
export async function readNotes(repo: HistoryRepo, hashes: readonly string[], notesRef: string): Promise<Map<string, string>> {
  const unique = [...new Set(hashes)];
  const notes = await mapLimit(unique, ASSET_BROWSER.gitReadConcurrency, (h) => repo.note(h, notesRef));
  const out = new Map<string, string>();
  unique.forEach((h, i) => {
    const n = notes[i];
    if (n) out.set(h, n);
  });
  return out;
}
