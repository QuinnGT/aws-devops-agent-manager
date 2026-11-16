import path from "node:path";
import { z } from "zod";
import type { AssetJson } from "@/lib/assets/types";
import { parseAssetJson } from "@/server/assets/repo";
import { mapLimit } from "@/server/aws/paginate";
import type { HistoryRepo } from "@/server/git/history-repo";
import { assetContentHash, metadataHash } from "@/server/history/content-hash";
import { assetDisplayName, spaceRoot } from "@/server/history/layout";
import type { Policy } from "@/server/policy";
import { canonicalize, serializeJson } from "@/server/sync/content";
import { assetIdentity, computeIdentity } from "@/server/validation/identity";
import { warning, type ValidationResult } from "@/server/validation/types";
import { RELEASES } from "./config";

/**
 * Release manifests:
 * every asset of a space at one history commit, with its service version,
 * content hash and metadata (status included, because a status change does
 * not create a new service version). The assets come from the asset.json
 * files under the space root at that commit.
 */

export const MANIFEST_FORMAT = 1;

export interface ManifestAsset {
  assetId: string;
  assetType: string;
  /** Identity within the type (asset-types.yaml `identity`), e.g. a skill name or "<store>/<memory>" */
  key: string;
  /** Display name (historyLayout.nameKeys) */
  name: string;
  serviceVersion: number;
  serviceUpdatedAt: string;
  /** assetContentHash over every file of the version (path and SHA-256) */
  contentHash: string;
  /** metadataHash of `metadata` */
  metadataHash: string;
  metadata: Record<string, unknown>;
  /** Directory of the asset in the history repository at the source commit */
  gitPath: string;
}

export interface ReleaseInfo {
  id: string;
  name: string;
  tag: string;
  createdBy: string;
  createdAt: string;
  note: string | null;
  planId: string | null;
}

export interface ReleaseManifest {
  format: typeof MANIFEST_FORMAT;
  space: { alias: string; agentSpaceId: string; region: string };
  release: ReleaseInfo;
  /** The history commit whose assets are listed */
  sourceCommit: string;
  /** Sorted by asset type, key and asset ID */
  assets: ManifestAsset[];
}

/** An asset.json found under the space root. */
export interface ScannedAsset {
  gitPath: string;
  assetJson: AssetJson;
}

type ManifestPolicy = Pick<Policy, "assetTypes" | "historyLayout">;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Pick the asset.json files that describe assets. A committed file of one
 * asset may itself be named asset.json (for example skill/x/references/asset.json);
 * it belongs to that asset and is not an asset of its own. Shallower
 * directories are read first, so a parent always claims its files.
 */
export function selectAssets(candidates: readonly { path: string; text: string | null }[]): { assets: ScannedAsset[]; problems: ValidationResult[] } {
  const problems: ValidationResult[] = [];
  const claimed = new Set<string>();
  const seen = new Map<string, string>();
  const assets: ScannedAsset[] = [];
  const sorted = [...candidates].sort((a, b) => a.path.split("/").length - b.path.split("/").length || cmp(a.path, b.path));
  for (const c of sorted) {
    if (claimed.has(c.path)) continue;
    const json = parseAssetJson(c.text);
    if (!json) {
      problems.push(warning("manifest.asset-json-invalid", `${c.path} is not a valid asset.json, so it is not in the manifest.`, { path: c.path }));
      continue;
    }
    const dir = path.posix.dirname(c.path);
    for (const f of json.files) if (f.committed) claimed.add(path.posix.join(dir, f.path));
    const other = seen.get(json.assetId);
    if (other) {
      problems.push(warning("manifest.asset-duplicate", `${json.assetId} is recorded twice (${other} and ${dir}); the manifest uses ${other}.`, { path: c.path }));
      continue;
    }
    seen.set(json.assetId, dir);
    assets.push({ gitPath: dir, assetJson: json });
  }
  return { assets, problems };
}

/** Every asset.json under the space root at `commit`. */
export async function scanSpaceAssets(
  repo: HistoryRepo,
  layout: ManifestPolicy["historyLayout"],
  spaceAlias: string,
  commit: string,
): Promise<{ assets: ScannedAsset[]; problems: ValidationResult[] }> {
  const root = spaceRoot(layout, spaceAlias);
  const files = await repo.listFiles(root, commit);
  const paths = files.filter((f) => path.posix.basename(f) === layout.assetJson);
  const texts = await mapLimit(paths, RELEASES.gitReadConcurrency, (p) => repo.show(commit, p));
  return selectAssets(paths.map((p, i) => ({ path: p, text: texts[i] ?? null })));
}

/** Manifest entries for scanned assets, sorted. Identity references resolve within the set. */
export function manifestAssets(scanned: readonly ScannedAsset[], policy: ManifestPolicy): ManifestAsset[] {
  const byId = new Map(scanned.map((s) => [s.assetJson.assetId, s.assetJson]));
  const lookup = (assetType: string, id: string) => {
    const a = byId.get(id);
    return a && a.assetType === assetType ? (computeIdentity(policy, a) ?? undefined) : undefined;
  };
  return scanned
    .map(({ gitPath, assetJson: a }) => {
      const metadata = canonicalize(a.metadata) as Record<string, unknown>;
      return {
        assetId: a.assetId,
        assetType: a.assetType,
        key: assetIdentity(policy, { assetType: a.assetType, assetId: a.assetId, metadata }, lookup),
        name: assetDisplayName(policy.historyLayout, { assetId: a.assetId, assetType: a.assetType, metadata }),
        serviceVersion: a.serviceVersion,
        serviceUpdatedAt: a.serviceUpdatedAt,
        contentHash: assetContentHash(a.files),
        metadataHash: metadataHash(metadata),
        metadata,
        gitPath,
      };
    })
    .sort((x, y) => cmp(x.assetType, y.assetType) || cmp(x.key, y.key) || cmp(x.assetId, y.assetId));
}

export function buildManifest(input: {
  scanned: readonly ScannedAsset[];
  policy: ManifestPolicy;
  space: { alias: string; agentSpaceId: string; region: string };
  sourceCommit: string;
  release: ReleaseInfo;
}): ReleaseManifest {
  return {
    format: MANIFEST_FORMAT,
    space: { alias: input.space.alias, agentSpaceId: input.space.agentSpaceId, region: input.space.region },
    release: { ...input.release },
    sourceCommit: input.sourceCommit,
    assets: manifestAssets(input.scanned, input.policy),
  };
}

/** Deterministic JSON: keys sorted at every level, assets in manifest order, trailing newline. */
export function serializeManifest(m: ReleaseManifest): string {
  return serializeJson(canonicalize(m));
}

const manifestAssetSchema = z.object({
  assetId: z.string(),
  assetType: z.string(),
  key: z.string(),
  name: z.string(),
  serviceVersion: z.number().int(),
  serviceUpdatedAt: z.string(),
  contentHash: z.string(),
  metadataHash: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  gitPath: z.string(),
});

const manifestSchema = z.object({
  format: z.literal(MANIFEST_FORMAT),
  space: z.object({ alias: z.string(), agentSpaceId: z.string(), region: z.string() }),
  release: z.object({
    id: z.string(),
    name: z.string(),
    tag: z.string(),
    createdBy: z.string(),
    createdAt: z.string(),
    note: z.string().nullable(),
    planId: z.string().nullable(),
  }),
  sourceCommit: z.string(),
  assets: z.array(manifestAssetSchema),
});

/** Parse a manifest from the database or a manifest file; null when it is not a valid manifest. */
export function parseManifest(value: unknown): ReleaseManifest | null {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  const r = manifestSchema.safeParse(v);
  return r.success ? (r.data as ReleaseManifest) : null;
}
