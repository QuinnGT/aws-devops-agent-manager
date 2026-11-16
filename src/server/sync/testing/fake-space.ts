import {
  DevOpsAgentClient,
  GetAssetCommand,
  GetAssetContentCommand,
  GetAssetFileCommand,
  ListAssetFilesCommand,
  ListAssetsCommand,
  ListAssetVersionsCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-devops-agent";
import { type AwsClientStub, mockClient } from "aws-sdk-client-mock";
import JSZip from "jszip";
import { apiFixture } from "../../../../test/helpers/fixtures";

/**
 * Tests only. An in-memory Agent Space behind aws-sdk-client-mock. Responses
 * follow the shapes of the captured fixtures in test/fixtures/api/test-space,
 * with small page sizes so pagination is exercised.
 */

export interface FakeFile {
  path: string;
  text?: string;
  bytes?: Uint8Array;
  mimeType?: string;
}

export interface FakeVersion {
  version: number;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  files: FakeFile[];
}

export interface FakeAsset {
  assetId: string;
  assetType: string;
  versions: FakeVersion[];
}

export interface FakeCall {
  command: string;
  input: Record<string, unknown>;
}

function notFound(what: string): ResourceNotFoundException {
  return new ResourceNotFoundException({ message: `${what} not found`, $metadata: {} });
}

export class FakeSpace {
  readonly assets = new Map<string, FakeAsset>();
  readonly calls: FakeCall[] = [];
  stub: AwsClientStub<DevOpsAgentClient> | null = null;

  constructor(
    readonly agentSpaceId: string,
    readonly pageCap = { assets: 7, versions: 10 },
  ) {}

  add(asset: FakeAsset): void {
    asset.versions.sort((a, b) => a.version - b.version);
    this.assets.set(asset.assetId, asset);
  }

  latest(assetId: string): FakeVersion {
    const a = this.assets.get(assetId);
    const v = a?.versions.at(-1);
    if (!v) throw new Error(`fake asset ${assetId} has no versions`);
    return v;
  }

  /** A new version (UpdateAsset or UpdateAssetFile): metadata patch and optional new files. */
  addVersion(assetId: string, change: { updatedAt: string; metadata?: Record<string, unknown>; files?: FakeFile[] }): FakeVersion {
    const prev = this.latest(assetId);
    const v: FakeVersion = {
      version: prev.version + 1,
      createdAt: prev.createdAt,
      updatedAt: change.updatedAt,
      metadata: { ...prev.metadata, ...(change.metadata ?? {}) },
      files: change.files ?? prev.files.map((f) => ({ ...f })),
    };
    this.assets.get(assetId)!.versions.push(v);
    return v;
  }

  /** A metadata-only update such as the Active switch: changes the current version in place. */
  updateInPlace(assetId: string, metadata: Record<string, unknown>, updatedAt: string): void {
    const v = this.latest(assetId);
    Object.assign(v.metadata, metadata);
    v.updatedAt = updatedAt;
  }

  remove(assetId: string): void {
    this.assets.delete(assetId);
  }

  callsOf(command: string): FakeCall[] {
    return this.calls.filter((c) => c.command === command);
  }

  private version(assetId: string, version?: number): { asset: FakeAsset; v: FakeVersion } {
    const asset = this.assets.get(assetId);
    if (!asset) throw notFound(`asset ${assetId}`);
    const v = version === undefined ? asset.versions.at(-1) : asset.versions.find((x) => x.version === version);
    if (!v) throw notFound(`version ${version} of ${assetId}`);
    return { asset, v };
  }

  private assetShape(asset: FakeAsset, v: FakeVersion) {
    return {
      assetId: asset.assetId,
      assetType: asset.assetType,
      metadata: structuredClone(v.metadata),
      version: v.version,
      createdAt: new Date(asset.versions[0]!.createdAt),
      updatedAt: new Date(v.updatedAt),
    };
  }

  private record(command: string, input: object): void {
    this.calls.push({ command, input: { ...(input as Record<string, unknown>) } });
  }

  private page<T>(items: T[], input: { maxResults?: number; nextToken?: string }, cap: number): { items: T[]; nextToken?: string } {
    const size = Math.min(input.maxResults ?? 100, cap);
    const start = input.nextToken ? Number(input.nextToken) : 0;
    const slice = items.slice(start, start + size);
    const next = start + size < items.length ? String(start + size) : undefined;
    return next ? { items: slice, nextToken: next } : { items: slice };
  }

  /** Install handlers on a client mock (all DevOpsAgentClient instances). */
  install(): AwsClientStub<DevOpsAgentClient> {
    this.stub?.restore();
    const m = mockClient(DevOpsAgentClient);
    this.stub = m;

    m.on(ListAssetsCommand).callsFake(async (input) => {
      this.record("ListAssets", input);
      if (input.agentSpaceId !== this.agentSpaceId) throw notFound("agent space");
      const after = input.updatedAfter ? new Date(input.updatedAfter).getTime() : null;
      const items = [...this.assets.values()]
        .map((a) => this.assetShape(a, a.versions.at(-1)!))
        .filter((a) => after === null || a.updatedAt.getTime() >= after)
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || (a.assetId < b.assetId ? -1 : 1));
      return this.page(items, input, this.pageCap.assets);
    });

    m.on(ListAssetVersionsCommand).callsFake(async (input) => {
      this.record("ListAssetVersions", input);
      const asset = this.assets.get(input.assetId!);
      if (!asset) throw notFound(`asset ${input.assetId}`);
      const items = [...asset.versions]
        .sort((a, b) => b.version - a.version)
        .map((v) => ({ version: v.version, createdAt: new Date(v.createdAt), updatedAt: new Date(v.updatedAt) }));
      return this.page(items, input, this.pageCap.versions);
    });

    m.on(GetAssetCommand).callsFake(async (input) => {
      this.record("GetAsset", input);
      const { asset, v } = this.version(input.assetId!, input.assetVersion);
      return { asset: this.assetShape(asset, v) };
    });

    m.on(ListAssetFilesCommand).callsFake(async (input) => {
      this.record("ListAssetFiles", input);
      const { v } = this.version(input.assetId!, input.assetVersion);
      const items = v.files.map((f) => ({ path: f.path, version: v.version, createdAt: new Date(v.updatedAt), updatedAt: new Date(v.updatedAt) }));
      return this.page(items, input, 100);
    });

    m.on(GetAssetFileCommand).callsFake(async (input) => {
      this.record("GetAssetFile", input);
      const { v } = this.version(input.assetId!, input.assetVersion);
      const f = v.files.find((x) => x.path === input.path);
      if (!f) throw notFound(`file ${input.path}`);
      return {
        file: {
          path: f.path,
          content: f.text !== undefined ? { text: f.text } : { bytes: f.bytes! },
          version: v.version,
          createdAt: new Date(v.updatedAt),
          updatedAt: new Date(v.updatedAt),
          metadata: { mimeType: f.mimeType ?? "text/markdown" },
        },
      };
    });

    m.on(GetAssetContentCommand).callsFake(async (input) => {
      this.record("GetAssetContent", input);
      const { v } = this.version(input.assetId!, input.assetVersion);
      const zip = new JSZip();
      for (const f of v.files) zip.file(f.path, f.text ?? f.bytes!, { unixPermissions: 0o100644 });
      const zipFile = await zip.generateAsync({ type: "uint8array", platform: "UNIX" });
      return { content: { zipFile }, version: v.version };
    });

    return m;
  }

  restore(): void {
    this.stub?.restore();
    this.stub = null;
  }
}

// ---------- the test space from the captured fixtures ----------

type AssetFx = { assetId: string; assetType: string; metadata: Record<string, unknown>; version: number; createdAt: string; updatedAt: string };

export const TEST_SPACE_ID = "00000000-0000-4000-8000-0000000000bb";
const FIXTURE_TYPES = ["agents_md", "artifact", "memory", "memory_store", "skill"] as const;

function tryFixture<T>(name: string): { request: Record<string, unknown>; response: T } | null {
  try {
    return apiFixture<T>(name) as { request: Record<string, unknown>; response: T };
  } catch {
    return null;
  }
}

/** Marker added to every version except the latest, so each version has its own content. */
export function versionMarker(v: number): string {
  return `\n<!-- test version ${v} -->\n`;
}

/** Contents of the GetAssetContent.skill zip fixture, by path. */
export async function skillZipFixture(): Promise<Map<string, string>> {
  const fx = apiFixture<{ content: { zipFile: { __base64: string } } }>("GetAssetContent.skill");
  const zip = await JSZip.loadAsync(Buffer.from(fx.response.content.zipFile.__base64, "base64"));
  const out = new Map<string, string>();
  for (const e of Object.values(zip.files)) if (!e.dir) out.set(e.name, await e.async("string"));
  return out;
}

/**
 * A fake of the test space: every asset in ListAssets.page1. Assets with
 * captured version, metadata and file fixtures use them; the others get
 * synthetic versions and one markdown file.
 */
export async function fixtureSpace(): Promise<FakeSpace> {
  const fake = new FakeSpace(TEST_SPACE_ID);
  const items = apiFixture<{ items: AssetFx[] }>("ListAssets.page1").response.items;
  const skillZip = await skillZipFixture();

  for (const item of items) {
    const byType = (prefix: string) => {
      const t = FIXTURE_TYPES.find((x) => x === item.assetType);
      if (!t) return null;
      const fx = tryFixture<unknown>(`${prefix}.${t}`);
      return fx && fx.request.assetId === item.assetId ? fx : null;
    };
    const versionsFx = byType("ListAssetVersions") as { response: { items: { version: number; createdAt: string; updatedAt: string }[] } } | null;
    const currentFx = byType("GetAsset") as { response: { asset: AssetFx } } | null;
    const oldFx = (() => {
      const t = FIXTURE_TYPES.find((x) => x === item.assetType);
      const fx = t ? tryFixture<{ asset: AssetFx }>(`GetAsset.${t}.oldVersion`) : null;
      return fx && fx.request.assetId === item.assetId ? fx : null;
    })();
    const filesFx = byType("ListAssetFiles") as { response: { items: { path: string }[] } } | null;
    const fileFx = byType("GetAssetFile") as { response: { file: { path: string; content: { text: string }; metadata?: { mimeType?: string } } } } | null;

    const timeline =
      versionsFx?.response.items.map((v) => ({ ...v })) ??
      Array.from({ length: item.version }, (_, n) => {
        const version = n + 1;
        const t = version === item.version ? item.updatedAt : new Date(new Date(item.createdAt).getTime() + n * 60_000).toISOString();
        return { version, createdAt: item.createdAt, updatedAt: t };
      });

    let latestFiles: FakeFile[];
    if (item.assetType === "skill" && fileFx && skillZip.size) {
      latestFiles = [...skillZip.entries()].map(([p, text]) => ({ path: p, text, mimeType: "text/markdown" }));
    } else if (filesFx && fileFx) {
      latestFiles = filesFx.response.items.map((f) =>
        f.path === fileFx.response.file.path
          ? { path: f.path, text: fileFx.response.file.content.text, mimeType: fileFx.response.file.metadata?.mimeType ?? "text/markdown" }
          : { path: f.path, text: `# ${f.path}\n`, mimeType: "text/markdown" },
      );
    } else {
      const name = String(item.metadata.name ?? item.metadata.title ?? item.assetId).split("/").pop()!;
      latestFiles = [{ path: `${name}.md`, text: `# ${name}\n\nSynthetic content for ${item.assetId}.\n`, mimeType: "text/markdown" }];
    }
    const latestMeta = currentFx?.response.asset.metadata ?? item.metadata;
    const sorted = [...timeline].sort((a, b) => a.version - b.version);
    const last = sorted.at(-1)!.version;
    fake.add({
      assetId: item.assetId,
      assetType: item.assetType,
      versions: sorted.map((t) => ({
        version: t.version,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        metadata: structuredClone(t.version === last ? latestMeta : t.version === 1 && oldFx ? oldFx.response.asset.metadata : latestMeta),
        files: latestFiles.map((f) => ({ ...f, text: t.version === last ? f.text : `${f.text}${versionMarker(t.version)}` })),
      })),
    });
  }
  return fake;
}
