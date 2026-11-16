import path from "node:path";
import type { AssetFileSnapshot } from "@/lib/assets/types";
import { DEPLOYED_VS_READ_DEFAULTS, deployedPathOf } from "@/server/analyzers/deployed-vs-read";
import type { PackageFile } from "@/server/analyzers/types";
import { isManagedAsset } from "@/server/drafts/rules";
import type { HistoryRepo } from "@/server/git/history-repo";
import { assetContentHash } from "@/server/history/content-hash";
import { mapLimit } from "@/server/aws/paginate";
import type { DesiredAsset } from "@/server/packages/types";
import type { Policy } from "@/server/policy";
import type { ManifestAsset, ReleaseManifest } from "@/server/releases/manifest";
import { readAssetFilesAt, readAssetJsonAt } from "@/server/releases/source";
import { VERIFY } from "./config";
import type { SkippedAsset } from "./types";

/**
 * The package files of a release, in the shape the deployed-vs-read analyzer
 * takes (src/server/analyzers/types.ts): for a memory, `name` is its store
 * and `path` the file under the store ("db/failover.md" for the memory
 * "db/failover"), so the analyzer's template gives the path the agent reads
 * (/aidevops/memory/<store>/<memory name>.md); for a skill, `name` is the
 * skill and `path` the file inside it.
 *
 * Note: src/server/packages' PackageFile uses `name` for the asset key and
 * `path` for the package path, which is a different shape; the analyzer
 * can't take it as is. This module maps assets (from a release's commit or
 * from a package's desired assets) to the analyzer's shape.
 */

type FilesPolicy = Pick<Policy, "assetTypes" | "releases" | "verify">;

/** One asset with its text files, from git or from a package. */
export interface AssetWithFiles {
  assetId: string;
  assetType: string;
  /** Display name */
  name: string;
  metadata: Record<string, unknown>;
  /** Name of the memory store a memory belongs to; null for other types */
  storeName: string | null;
  version: number;
  /** Files with content; files without it (not in git) are counted in `missingFiles` */
  files: { path: string; content: string }[];
  missingFiles: number;
  /** Set when the asset could not be read at all */
  unreadable?: boolean;
  managed?: boolean;
}

/** Where a package file came from, keyed by fileKey(). */
export interface FileOrigin {
  assetId: string;
  assetType: string;
  assetName: string;
  store: string | null;
  version: number;
  filePath: string;
  deployedPath: string;
  /** Directory of the asset in the history repository at the release's commit (null for a package) */
  gitPath: string | null;
}

export function fileKey(f: Pick<PackageFile, "assetType" | "name" | "path">): string {
  return `${f.assetType}\0${f.name}\0${f.path}`;
}

/** The file's path under its store: the memory name's folders, then the file. */
export function memoryPathInStore(memoryName: string, filePath: string): string {
  const dir = path.posix.dirname(memoryName);
  return dir === "." || dir === "" ? filePath : path.posix.join(dir, filePath);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** Whether the analyzer would compare this file (its type has a deployed path, and the file is not an index or outside onlyPaths). */
export function analyzerCompares(f: Pick<PackageFile, "assetType" | "path">, d = DEPLOYED_VS_READ_DEFAULTS): boolean {
  if (!d.deployedPaths[f.assetType]) return false;
  const base = f.path.split("/").pop() ?? f.path;
  if (d.skipFileNames.includes(base)) return false;
  const only = d.onlyPaths[f.assetType];
  return !only?.length || only.includes(f.path);
}

/**
 * Package files for the analyzer, and the assets left out. Pure.
 * Types the analyzer has no deployed path for (instructions, which reach the
 * agent in its prompt rather than as a file it reads) are listed as not compared.
 */
export function analyzerPackageFiles(
  assets: readonly AssetWithFiles[],
  policy: FilesPolicy,
  gitPaths: ReadonlyMap<string, string> = new Map(),
): { files: PackageFile[]; origins: Map<string, FileOrigin>; skipped: SkippedAsset[] } {
  const statusKey = policy.releases.rollback.statusKey;
  const inactive = policy.releases.rollback.inactiveValue;
  const opts = policy.verify.reads;
  const files: PackageFile[] = [];
  const origins = new Map<string, FileOrigin>();
  const skipped: SkippedAsset[] = [];
  const skip = (a: AssetWithFiles, reason: SkippedAsset["reason"]) => skipped.push({ assetId: a.assetId, assetType: a.assetType, name: a.name, reason });

  for (const a of assets) {
    if (!DEPLOYED_VS_READ_DEFAULTS.deployedPaths[a.assetType]) {
      skip(a, "not-compared");
      continue;
    }
    if (opts.inactive === "skip" && a.metadata[statusKey] === inactive) {
      skip(a, "inactive");
      continue;
    }
    if (opts.managed === "skip" && a.managed) {
      skip(a, "managed");
      continue;
    }
    if (a.unreadable) {
      skip(a, "not-in-git");
      continue;
    }
    const metaName = str(a.metadata.name) ?? a.name;
    let added = 0;
    for (const f of a.files) {
      let pf: PackageFile;
      if (a.assetType === "memory") {
        if (!a.storeName) continue;
        pf = { assetType: a.assetType, name: a.storeName, path: memoryPathInStore(metaName, f.path), body: f.content };
      } else {
        pf = { assetType: a.assetType, name: metaName, path: f.path, body: f.content };
      }
      if (!analyzerCompares(pf)) continue;
      const deployedPath = deployedPathOf(pf);
      if (!deployedPath) continue;
      const key = fileKey(pf);
      if (origins.has(key)) continue;
      files.push(pf);
      added++;
      origins.set(key, {
        assetId: a.assetId,
        assetType: a.assetType,
        assetName: metaName,
        store: a.assetType === "memory" ? a.storeName : null,
        version: a.version,
        filePath: f.path,
        deployedPath,
        gitPath: gitPaths.get(a.assetId) ?? null,
      });
    }
    if (!added && a.missingFiles > 0) skip(a, "not-in-git");
  }
  return { files, origins, skipped };
}

/** The store name of each memory among manifest assets, through its required single reference (memory_store_id). */
function parentNames(assets: readonly Pick<ManifestAsset, "assetId" | "assetType" | "metadata" | "name">[], policy: Pick<Policy, "assetTypes">): Map<string, string> {
  const byId = new Map(assets.map((a) => [a.assetId, a]));
  const out = new Map<string, string>();
  for (const a of assets) {
    for (const rule of policy.assetTypes.assetTypes[a.assetType]?.references ?? []) {
      if (rule.many || !rule.required) continue;
      const id = a.metadata[rule.key];
      const parent = typeof id === "string" ? byId.get(id) : undefined;
      if (parent && parent.assetType === rule.assetType) {
        out.set(a.assetId, str(parent.metadata.name) ?? parent.name);
        break;
      }
    }
  }
  return out;
}

function managedOf(policy: Pick<Policy, "assetTypes">, a: Pick<ManifestAsset, "assetType" | "metadata">, names: (t: string, id: string) => string | undefined): boolean {
  return isManagedAsset(policy, { assetType: a.assetType, metadata: a.metadata }, names);
}

function textFiles(files: readonly AssetFileSnapshot[]): { files: { path: string; content: string }[]; missing: number } {
  const out: { path: string; content: string }[] = [];
  let missing = 0;
  for (const f of files) {
    if (f.content === undefined) missing++;
    else if (f.encoding === "utf8") out.push({ path: f.path, content: f.content });
  }
  return { files: out, missing };
}

/**
 * The release's assets with their files at the release's source commit.
 * Only types the analyzer compares are read from git. An asset whose
 * asset.json is missing or whose content hash differs from the manifest is
 * unreadable (listed as not-in-git).
 */
export async function releaseAssetsAt(repo: HistoryRepo, manifest: ReleaseManifest, policy: Pick<Policy, "assetTypes" | "historyLayout">): Promise<AssetWithFiles[]> {
  const stores = parentNames(manifest.assets, policy);
  const byId = new Map(manifest.assets.map((a) => [a.assetId, a]));
  const names = (t: string, id: string) => {
    const a = byId.get(id);
    return a && a.assetType === t ? (str(a.metadata.name) ?? a.name) : undefined;
  };
  return mapLimit(manifest.assets, VERIFY.gitReadConcurrency, async (a): Promise<AssetWithFiles> => {
    const base = {
      assetId: a.assetId,
      assetType: a.assetType,
      name: a.name,
      metadata: a.metadata,
      storeName: stores.get(a.assetId) ?? null,
      version: a.serviceVersion,
      managed: managedOf(policy, a, names),
    };
    if (!DEPLOYED_VS_READ_DEFAULTS.deployedPaths[a.assetType]) return { ...base, files: [], missingFiles: 0 };
    const json = await readAssetJsonAt(repo, manifest.sourceCommit, a.gitPath, policy.historyLayout);
    if (!json || json.assetId !== a.assetId || assetContentHash(json.files) !== a.contentHash) return { ...base, files: [], missingFiles: 0, unreadable: true };
    // Read only the files the analyzer compares (a skill's SKILL.md, not its references and assets).
    const memoryName = str(a.metadata.name) ?? a.name;
    const compared = json.files.filter((f) => analyzerCompares({ assetType: a.assetType, path: a.assetType === "memory" ? memoryPathInStore(memoryName, f.path) : f.path }));
    const { files, missing } = textFiles(await readAssetFilesAt(repo, manifest.sourceCommit, a.gitPath, { ...json, files: compared }));
    return { ...base, files, missingFiles: missing };
  });
}

/** Package files of a release at its source commit. */
export async function releasePackageFiles(
  repo: HistoryRepo,
  manifest: ReleaseManifest,
  policy: FilesPolicy & Pick<Policy, "historyLayout">,
): Promise<{ files: PackageFile[]; origins: Map<string, FileOrigin>; skipped: SkippedAsset[] }> {
  const assets = await releaseAssetsAt(repo, manifest, policy);
  return analyzerPackageFiles(assets, policy, new Map(manifest.assets.map((a) => [a.assetId, a.gitPath])));
}

/**
 * Assets of a package (packageToDesiredAssets) as AssetWithFiles, with the
 * store name from refs.memoryStore. For checks of a package that is not a
 * release yet, and for tests on sample packages.
 */
export function desiredAssetsWithFiles(assets: readonly DesiredAsset[], policy: Pick<Policy, "assetTypes">, version = 0): AssetWithFiles[] {
  const storeRef = (a: DesiredAsset) => {
    for (const rule of policy.assetTypes.assetTypes[a.assetType]?.references ?? []) {
      if (rule.many || !rule.required) continue;
      const v = a.refs?.[rule.ref];
      if (typeof v === "string" && v) return v;
    }
    return null;
  };
  return assets.map((a) => ({
    assetId: a.assetId ?? `${a.assetType}:${a.key}`,
    assetType: a.assetType,
    name: str(a.metadata.name) ?? a.key,
    metadata: a.metadata,
    storeName: storeRef(a),
    version,
    files: a.files.filter((f) => f.encoding === "utf8").map((f) => ({ path: f.path, content: f.content })),
    missingFiles: 0,
    managed: isManagedAsset(policy, a, () => undefined),
  }));
}
