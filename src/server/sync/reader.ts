import {
  type Asset,
  type DevOpsAgentClient,
  GetAssetCommand,
  GetAssetContentCommand,
  GetAssetFileCommand,
  ListAssetFilesCommand,
  ListAssetsCommand,
  ListAssetVersionsCommand,
  type AssetFileSummary,
} from "@aws-sdk/client-devops-agent";
import JSZip from "jszip";
import type { AssetFileSnapshot, AssetSnapshot } from "@/lib/assets/types";
import { mapLimit, pages } from "@/server/aws/paginate";
import type { LiveVersion } from "./changes";
import { fileSnapshot, safeAssetFilePath } from "./content";

/**
 * Read-only access to one Agent Space's assets for the sync job. Every call
 * goes through the DevOps Agent client passed in (the space's read role).
 */

export interface LiveAsset {
  assetId: string;
  assetType: string;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReaderOptions {
  agentSpaceId: string;
  pageSize: number;
  versionsPageSize: number;
  concurrency: number;
  zipMinFiles: number;
  maxCommittedFileBytes: number;
}

/** The asset (or the version) no longer exists in the space. */
export class AssetGoneError extends Error {
  constructor(readonly assetId: string, detail: string) {
    super(`Asset ${assetId} is no longer available: ${detail}`);
    this.name = "AssetGoneError";
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.name === "ResourceNotFoundException";
}

export function toDate(v: Date | string | number | undefined): Date {
  if (v instanceof Date) return v;
  if (v === undefined) throw new Error("missing timestamp in API response");
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid timestamp in API response: ${String(v)}`);
  return d;
}

function toMetadata(m: unknown): Record<string, unknown> {
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

export function toLiveAsset(a: Asset): LiveAsset {
  if (!a.assetId || !a.assetType || a.version === undefined) throw new Error("asset without assetId, assetType or version in API response");
  return {
    assetId: a.assetId,
    assetType: a.assetType,
    metadata: toMetadata(a.metadata),
    version: a.version,
    createdAt: toDate(a.createdAt),
    updatedAt: toDate(a.updatedAt),
  };
}

function mimeTypeOf(m: unknown): string | undefined {
  const v = toMetadata(m).mimeType;
  return typeof v === "string" && v ? v : undefined;
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** Unzip GetAssetContent output. Returns null if any entry is unsafe (absolute, `..`, symlink). */
export async function unzipAssetContent(bytes: Uint8Array): Promise<Map<string, Uint8Array> | null> {
  const zip = await JSZip.loadAsync(bytes);
  const out = new Map<string, Uint8Array>();
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const perms = entry.unixPermissions;
    if (typeof perms === "number" && (perms & S_IFMT) === S_IFLNK) return null;
    const original = (entry.unsafeOriginalName ?? entry.name).replace(/\\/g, "/");
    const p = safeAssetFilePath(original);
    if (!p || p !== original) return null;
    out.set(p, await entry.async("uint8array"));
  }
  return out;
}

export class SpaceReader {
  constructor(
    private readonly client: DevOpsAgentClient,
    private readonly opts: ReaderOptions,
  ) {}

  /** All assets, or those updated after `updatedAfter`, across every page. */
  async listAssets(updatedAfter?: Date): Promise<LiveAsset[]> {
    const out: LiveAsset[] = [];
    const request = { agentSpaceId: this.opts.agentSpaceId, maxResults: this.opts.pageSize, ...(updatedAfter ? { updatedAfter } : {}) };
    for await (const page of pages((req: typeof request & { nextToken?: string }) => this.client.send(new ListAssetsCommand(req)), request)) {
      for (const a of page.items ?? []) out.push(toLiveAsset(a));
    }
    return out;
  }

  /** The current asset, or null when it no longer exists. */
  async getAsset(assetId: string): Promise<LiveAsset | null> {
    try {
      const res = await this.client.send(new GetAssetCommand({ agentSpaceId: this.opts.agentSpaceId, assetId }));
      return res.asset ? toLiveAsset(res.asset) : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** Every version of an asset (all pages), oldest first. */
  async listVersions(assetId: string): Promise<LiveVersion[]> {
    const out: LiveVersion[] = [];
    const request = { agentSpaceId: this.opts.agentSpaceId, assetId, maxResults: this.opts.versionsPageSize };
    try {
      for await (const page of pages((req: typeof request & { nextToken?: string }) => this.client.send(new ListAssetVersionsCommand(req)), request)) {
        for (const v of page.items ?? []) {
          if (v.version === undefined) continue;
          out.push({ version: v.version, createdAt: toDate(v.createdAt), updatedAt: toDate(v.updatedAt) });
        }
      }
    } catch (err) {
      if (isNotFound(err)) throw new AssetGoneError(assetId, "ListAssetVersions returned not found");
      throw err;
    }
    return out.sort((a, b) => a.version - b.version);
  }

  /**
   * One version of an asset with its metadata and files. `version` comes from
   * ListAssetVersions; its timestamps are kept as the snapshot's own.
   */
  async snapshot(asset: { assetId: string; assetType: string }, version: LiveVersion): Promise<AssetSnapshot> {
    const base = { agentSpaceId: this.opts.agentSpaceId, assetId: asset.assetId, assetVersion: version.version };
    try {
      const got = await this.client.send(new GetAssetCommand(base));
      if (!got.asset) throw new AssetGoneError(asset.assetId, `GetAsset returned no asset for version ${version.version}`);
      const summaries: AssetFileSummary[] = [];
      for await (const page of pages((req: typeof base & { nextToken?: string }) => this.client.send(new ListAssetFilesCommand(req)), base)) {
        summaries.push(...(page.items ?? []));
      }
      const files = await this.readFiles(base, summaries);
      return {
        assetId: asset.assetId,
        assetType: got.asset.assetType ?? asset.assetType,
        version: version.version,
        createdAt: version.createdAt.toISOString(),
        updatedAt: version.updatedAt.toISOString(),
        metadata: toMetadata(got.asset.metadata),
        files,
      };
    } catch (err) {
      if (isNotFound(err)) throw new AssetGoneError(asset.assetId, `version ${version.version} not found`);
      throw err;
    }
  }

  private async readFiles(
    base: { agentSpaceId: string; assetId: string; assetVersion: number },
    summaries: AssetFileSummary[],
  ): Promise<AssetFileSnapshot[]> {
    const paths = summaries.map((s) => s.path).filter((p): p is string => typeof p === "string" && p.length > 0);
    const summaryMime = new Map(summaries.map((s) => [s.path, mimeTypeOf(s.metadata)]));
    let zipped: Map<string, Uint8Array> | null = null;
    if (this.opts.zipMinFiles > 0 && paths.length >= this.opts.zipMinFiles) {
      const res = await this.client.send(new GetAssetContentCommand(base));
      if (res.content?.zipFile) zipped = await unzipAssetContent(res.content.zipFile);
    }
    const max = this.opts.maxCommittedFileBytes;
    return mapLimit(paths, this.opts.concurrency, async (p) => {
      const fromZip = zipped?.get(p);
      if (fromZip) return fileSnapshot(p, fromZip, { maxCommittedFileBytes: max, mimeType: summaryMime.get(p) });
      const res = await this.client.send(new GetAssetFileCommand({ ...base, path: p }));
      const body = res.file?.content;
      let bytes: Uint8Array;
      if (body?.text !== undefined) bytes = Buffer.from(body.text, "utf8");
      else if (body?.bytes !== undefined) bytes = body.bytes;
      else throw new Error(`GetAssetFile returned no content for ${base.assetId} ${p}`);
      return fileSnapshot(p, bytes, { maxCommittedFileBytes: max, mimeType: mimeTypeOf(res.file?.metadata) ?? summaryMime.get(p) });
    });
  }
}
