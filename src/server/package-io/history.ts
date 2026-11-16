import path from "node:path";
import type { AssetFileSnapshot, AssetSnapshot } from "@/lib/assets/types";
import { isSafeAssetFilePath, openSpaceHistoryRepo, parseAssetJson, type SpaceRepo } from "@/server/assets/repo";
import { listIndexedAssets } from "@/server/assets/queries";
import { mapLimit } from "@/server/aws/paginate";
import type { HistoryRepo } from "@/server/git/history-repo";
import { fillTemplate, safeSegment, spaceRoot } from "@/server/history/layout";
import type { Policy } from "@/server/policy";
import type { SpaceRow } from "@/server/spaces/queries";
import { isUtf8Text } from "@/server/sync/content";
import type { LiveIndexEntry } from "./analyze";

/**
 * Reads from the asset index and the space's history repository. Never
 * writes and never creates a working copy, so it is safe in the web process.
 */

type HistoryLayout = Policy["historyLayout"];

/** The space's live assets (asset_index, not deleted), each with its asset.json at the history repository's HEAD. */
export async function loadLiveIndex(
  space: SpaceRow,
  policy: Pick<Policy, "historyLayout" | "packageIo">,
): Promise<{ entries: LiveIndexEntry[]; historyCommit: string | null; repo: SpaceRepo }> {
  const rows = await listIndexedAssets(space.id);
  const repo = await openSpaceHistoryRepo(space, policy.historyLayout);
  const head = repo.ok ? await repo.repo.head() : null;
  const layout = policy.historyLayout;
  const entries = await mapLimit(rows, policy.packageIo.export.gitReadConcurrency, async (r): Promise<LiveIndexEntry> => {
    let committed: LiveIndexEntry["committed"] = null;
    if (repo.ok && head && r.gitPath) {
      const json = parseAssetJson(await repo.repo.show(head, path.posix.join(r.gitPath, layout.assetJson)));
      if (json && json.assetId === r.assetId) {
        committed = { metadata: json.metadata, files: json.files.map((f) => ({ path: f.path, sha256: f.sha256 })) };
      }
    }
    return {
      assetId: r.assetId,
      assetType: r.assetType,
      name: r.name,
      metadata: (r.metadata as Record<string, unknown> | null) ?? {},
      liveVersion: r.liveVersion,
      committed,
      gitPath: r.gitPath ?? null,
    };
  });
  return { entries, historyCommit: head, repo };
}

/**
 * Every asset of the space at a commit, read from its asset.json files and
 * committed file contents (bytes, so binary files survive). Files above the
 * commit threshold have no content; snapshotsToDesiredAssets warns about them.
 */
export async function readSnapshotsAtCommit(
  repo: HistoryRepo,
  layout: HistoryLayout,
  spaceAlias: string,
  commit: string,
  concurrency = 4,
): Promise<AssetSnapshot[]> {
  const root = spaceRoot(layout, spaceAlias);
  const jsonPaths = (await repo.listFiles(root, commit)).filter((p) => path.posix.basename(p) === layout.assetJson && p !== path.posix.join(root, layout.assetJson));
  const parsed = await mapLimit(jsonPaths, concurrency, async (p) => ({ dir: path.posix.dirname(p), json: parseAssetJson(await repo.show(commit, p)), path: p }));
  // An asset.json that is itself a file of another asset (a skill reference named asset.json) is content, not an asset.
  const contentPaths = new Set(parsed.flatMap((x) => (x.json ? x.json.files.map((f) => path.posix.join(x.dir, f.path)) : [])));
  const assets = parsed.filter((x): x is typeof x & { json: NonNullable<typeof x.json> } => x.json !== null && !contentPaths.has(x.path));
  const snapshots = await mapLimit(assets, concurrency, async ({ dir, json }): Promise<AssetSnapshot> => {
    const files: AssetFileSnapshot[] = [];
    for (const f of json.files) {
      const base: AssetFileSnapshot = { path: f.path, sha256: f.sha256, size: f.size, encoding: "utf8", ...(f.mimeType ? { mimeType: f.mimeType } : {}) };
      const bytes = f.committed && isSafeAssetFilePath(f.path) ? await repo.showBytes(commit, path.posix.join(dir, f.path)) : null;
      if (!bytes) {
        files.push(base);
        continue;
      }
      const text = isUtf8Text(bytes);
      files.push({ ...base, encoding: text ? "utf8" : "base64", content: text ? bytes.toString("utf8") : bytes.toString("base64") });
    }
    return {
      assetId: json.assetId,
      assetType: json.assetType,
      version: json.serviceVersion,
      createdAt: json.serviceCreatedAt,
      updatedAt: json.serviceUpdatedAt,
      metadata: json.metadata,
      files,
    };
  });
  return snapshots.sort((a, b) => (a.assetType + "\0" + a.assetId < b.assetType + "\0" + b.assetId ? -1 : 1));
}

// ---------- export points ----------

export type ExportRefKind = "head" | "release" | "commit";

export interface ExportRef {
  kind: ExportRefKind;
  /** What the caller passes back: "HEAD", the release tag name, or the full commit hash */
  ref: string;
  /** Short label: the release name or the short commit hash */
  label: string;
  commit: string;
  date: string | null;
  subject: string | null;
}

/** Release tags of the space from the history layout's releaseTag template. */
export async function listReleaseTags(repo: HistoryRepo, layout: HistoryLayout, spaceAlias: string): Promise<ExportRef[]> {
  const marker = "{release}";
  const at = layout.releaseTag.indexOf(marker);
  if (at < 0) return [];
  const prefix = fillTemplate(layout.releaseTag.slice(0, at), { spaceAlias: safeSegment(spaceAlias) });
  const suffix = fillTemplate(layout.releaseTag.slice(at + marker.length), { spaceAlias: safeSegment(spaceAlias) });
  const tags = await repo.tagDetails(prefix);
  return tags
    .filter((t) => t.name.startsWith(prefix) && t.name.endsWith(suffix) && t.name.length > prefix.length + suffix.length && t.commit)
    .map((t) => ({
      kind: "release" as const,
      ref: t.name,
      label: t.name.slice(prefix.length, t.name.length - suffix.length),
      commit: t.commit,
      date: t.date || null,
      subject: t.subject || null,
    }));
}

const COMMIT_REF = /^[0-9a-f]{7,64}$/;
const short = (c: string) => c.slice(0, 12);

/** HEAD, the release tags and recent commits that touched the space, newest first. */
export async function listExportRefs(
  repo: HistoryRepo,
  layout: HistoryLayout,
  spaceAlias: string,
  recentCommits: number,
): Promise<{ head: ExportRef | null; releases: ExportRef[]; commits: ExportRef[] }> {
  const log = recentCommits > 0 ? await repo.log({ path: spaceRoot(layout, spaceAlias), maxCount: recentCommits }) : [];
  const headCommit = await repo.head();
  const headEntry = headCommit ? (log.find((c) => c.hash === headCommit) ?? (await repo.log({ maxCount: 1 }))[0]) : undefined;
  const head: ExportRef | null = headCommit
    ? { kind: "head", ref: "HEAD", label: short(headCommit), commit: headCommit, date: headEntry?.date ?? null, subject: headEntry?.message ?? null }
    : null;
  const commits = log.map((c) => ({ kind: "commit" as const, ref: c.hash, label: short(c.hash), commit: c.hash, date: c.date, subject: c.message }));
  return { head, releases: await listReleaseTags(repo, layout, spaceAlias), commits };
}

/**
 * Resolve what the user picked: "HEAD", a commit hash (7 to 64 hex
 * characters), or one of this space's release tags. Anything else is null,
 * so a ref of another space or an option-like string never reaches git.
 */
export async function resolveExportRef(repo: HistoryRepo, layout: HistoryLayout, spaceAlias: string, ref: string): Promise<ExportRef | null> {
  const r = ref.trim();
  if (r === "HEAD") {
    const commit = await repo.head();
    return commit ? { kind: "head", ref: "HEAD", label: short(commit), commit, date: null, subject: null } : null;
  }
  if (COMMIT_REF.test(r)) {
    const commit = await repo.resolveCommit(r);
    return commit ? { kind: "commit", ref: commit, label: short(commit), commit, date: null, subject: null } : null;
  }
  const release = (await listReleaseTags(repo, layout, spaceAlias)).find((t) => t.ref === r);
  return release ?? null;
}
