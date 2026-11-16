import path from "node:path";
import { db } from "@/server/db/client";
import * as schema from "@/server/db/schema";
import type { HistoryRepo } from "@/server/git/history-repo";
import { packageToDesiredAssets } from "@/server/packages/desired";
import { getLayout } from "@/server/packages/layout";
import { readPackageFolder } from "@/server/packages/read";
import type { DesiredAsset, PackageContents } from "@/server/packages/types";
import type { Policy } from "@/server/policy";
import { commitVersion, type TestAsset } from "@/server/releases/test-support";
import type { Space } from "@/server/spaces/queries";
import { FakeSpace, type FakeFile } from "@/server/sync/testing/fake-space";
import { samplePackageDir } from "../../../test/helpers/fixtures";
import { AGENT_SPACE_ID, minutesAgo } from "../lib/common";

/**
 * The demo space's assets come from the sample instruction packages
 * (sample-data/packages, layouts anycompany-v1 and anycompany-v2 from the
 * sample policy overlay). The space starts on package v1, the version that was
 * live during the late October benchmark runs; the stories (the verification
 * plan, the revisions) bring in the changes that became v2. The revision
 * pages' seed commits the assets straight into the history repository the way
 * the sync worker writes them; the full seed serves them from a mocked Agent
 * Space instead and lets the sync engine commit them.
 */

export interface SourcePackage {
  contents: PackageContents;
  layout: ReturnType<typeof getLayout>;
  /** For log lines */
  source: string;
}

export interface SamplePackages {
  /** Package v1: what the space runs at the start */
  v1: SourcePackage;
  /** Package v2: the audited version; its files are the fixes the stories apply */
  v2: SourcePackage;
}

/** Read the sample packages with the space's policy (the sample overlay must be in it). */
export async function samplePackages(policy: Policy): Promise<SamplePackages> {
  const read = async (version: "v1" | "v2"): Promise<SourcePackage> => {
    const layout = getLayout(policy, `anycompany-${version}`);
    return { contents: await readPackageFolder(samplePackageDir(version), { policy, layout }), layout, source: `sample-data/packages/${version}` };
  };
  return { v1: await read("v1"), v2: await read("v2") };
}

/** The text of one file of a package. Throws when it is missing, so a changed sample package fails loudly. */
export function packageText(pkg: SourcePackage, file: string): string {
  const data = pkg.contents.files.get(file);
  if (!data) throw new Error(`${pkg.source} has no ${file}`);
  return data.toString("utf8");
}

function assetIdFor(n: number): string {
  return `ki-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Package assets as the sync worker would have committed them: IDs, references by ID, status. */
export function toTestAssets(desired: DesiredAsset[], policy: Policy): TestAsset[] {
  const types = policy.assetTypes.assetTypes;
  const idOf = new Map<string, string>();
  desired.forEach((a, i) => idOf.set(`${a.assetType}:${a.key}`, assetIdFor(i + 1)));
  const storeName = new Map<string, string>();
  for (const a of desired) if (a.assetType === "memory_store") storeName.set(a.key, String(a.metadata.name ?? a.key));
  return desired.map((a, i) => {
    const metadata: Record<string, unknown> = { ...a.metadata };
    for (const rule of types[a.assetType]?.references ?? []) {
      const ref = a.refs?.[rule.ref];
      const names = typeof ref === "string" ? [ref] : Array.isArray(ref) ? ref : [];
      const ids = names.map((n) => idOf.get(`${rule.assetType}:${n}`)).filter((x): x is string => Boolean(x));
      if (ids.length) metadata[rule.key] = rule.many ? ids : ids[0];
    }
    metadata.status ??= "ACTIVE";
    const files: Record<string, string | Buffer> = {};
    for (const f of a.files) files[f.path] = f.encoding === "base64" ? Buffer.from(f.content, "base64") : f.content;
    const store = typeof a.refs?.memoryStore === "string" ? storeName.get(a.refs.memoryStore) : undefined;
    return { assetId: assetIdFor(i + 1), assetType: a.assetType, metadata, version: 3, updatedAt: minutesAgo(60 * 24 * 3 + i).toISOString(), files, ...(store ? { storeName: store } : {}) };
  });
}

/** The package's assets as TestAssets. */
export function packageAssets(pkg: SourcePackage, policy: Policy): TestAsset[] {
  const mapped = packageToDesiredAssets(pkg.contents, pkg.layout, { policy });
  return toTestAssets(mapped.assets, policy);
}

/** Commit each asset straight into the history repository and index it, as a finished baseline sync would. */
export async function commitTestAssets(space: Space, repo: HistoryRepo, policy: Policy, assets: TestAsset[]): Promise<void> {
  for (const a of assets) {
    const { gitPath } = await commitVersion(repo, policy.historyLayout, space.alias, a);
    await db()
      .insert(schema.assetIndex)
      .values({
        spaceId: space.id,
        assetId: a.assetId,
        assetType: a.assetType,
        name: String(a.metadata.name ?? a.metadata.agent_type),
        parentAssetId: typeof a.metadata.memory_store_id === "string" ? a.metadata.memory_store_id : null,
        liveVersion: a.version,
        liveUpdatedAt: new Date(a.updatedAt),
        lastSyncedVersion: a.version,
        gitPath,
        metadata: a.metadata,
      });
  }
  await db()
    .insert(schema.syncState)
    .values({ spaceId: space.id, status: "succeeded", lastSyncStartedAt: minutesAgo(5), lastSyncCompletedAt: minutesAgo(4), lastReconcileAt: minutesAgo(4), baselineCompletedAt: minutesAgo(60 * 24 * 3) });
}

const MIME: Record<string, string> = { ".md": "text/markdown", ".json": "application/json", ".yaml": "application/yaml", ".yml": "application/yaml" };

/** A mocked Agent Space (aws-sdk-client-mock) that serves these assets, one version each. */
export function fakeSpaceFrom(assets: TestAsset[]): FakeSpace {
  const fake = new FakeSpace(AGENT_SPACE_ID);
  for (const a of assets) {
    const files: FakeFile[] = Object.entries(a.files).map(([p, c]) => {
      const mimeType = MIME[path.extname(p)] ?? "text/plain";
      return typeof c === "string" ? { path: p, text: c, mimeType } : { path: p, bytes: new Uint8Array(c), mimeType: "application/octet-stream" };
    });
    const created = new Date(new Date(a.updatedAt).getTime() - 7 * 24 * 60 * 60_000).toISOString();
    fake.add({
      assetId: a.assetId,
      assetType: a.assetType,
      versions: [{ version: a.version, createdAt: created, updatedAt: a.updatedAt, metadata: structuredClone(a.metadata), files }],
    });
  }
  return fake;
}
