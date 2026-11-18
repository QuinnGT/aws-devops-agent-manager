import { packageToDesiredAssets } from "@/server/packages/desired";
import type { PackageLayout } from "@/server/packages/layout";
import { sortPaths } from "@/server/packages/paths";
import { isText } from "@/server/packages/text";
import type { DesiredAsset, PackageContents } from "@/server/packages/types";
import type { Policy } from "@/server/policy";
import type { RevisionFileEdit } from "./types";

/**
 * The first save of a revision started from a package import: the edits that
 * lay the uploaded package over the revision's base package (the live space
 * in the import's layout), by asset rather than by path. Each package asset
 * replaces the files of the base asset it matches (same type and source asset
 * ID, else same type and key), wherever the base keeps them, so a package
 * folder skill/x.v2 replaces the base's skill/x__<id>. Every package file is
 * then written as it is. Base files of assets the package doesn't mention
 * stay, as an import leaves those assets alone, and the folder index lists
 * both. Pure.
 */
export function importOverlayEdits(base: PackageContents, upload: PackageContents, layout: PackageLayout, policy: Policy): Required<RevisionFileEdit>[] {
  const byId = new Map<string, DesiredAsset>();
  const byKey = new Map<string, DesiredAsset>();
  for (const a of packageToDesiredAssets(base, layout, { policy }).assets) {
    if (a.sourceAssetId) byId.set(`${a.assetType}\0${a.sourceAssetId}`, a);
    byKey.set(`${a.assetType}\0${a.key}`, a);
  }
  const files = new Map(base.files);
  for (const a of packageToDesiredAssets(upload, layout, { policy }).assets) {
    const match = (a.sourceAssetId ? byId.get(`${a.assetType}\0${a.sourceAssetId}`) : undefined) ?? byKey.get(`${a.assetType}\0${a.key}`);
    if (match?.source) for (const p of ownedPaths(base, match.source)) files.delete(p);
  }
  for (const [p, data] of upload.files) files.set(p, data);

  const index = layout.assetFolders?.index;
  const merged = index ? mergedIndex(base.files.get(index), upload.files.get(index), files) : null;
  if (index && merged) files.set(index, merged);

  const edits: Required<RevisionFileEdit>[] = [];
  for (const p of sortPaths(files.keys())) {
    const data = files.get(p)!;
    if (base.files.get(p)?.equals(data)) continue;
    edits.push(isText(data) ? { path: p, encoding: "utf8", content: data.toString("utf8") } : { path: p, encoding: "base64", content: data.toString("base64") });
  }
  for (const p of sortPaths(base.files.keys())) if (!files.has(p)) edits.push({ path: p, encoding: "utf8", content: null });
  return edits;
}

/** The base files of an asset: its file (a STORE.md, a memory), or everything in its folder. */
function ownedPaths(contents: PackageContents, source: string): string[] {
  if (contents.files.has(source)) return [source];
  const prefix = `${source.replace(/\/+$/, "")}/`;
  return [...contents.files.keys()].filter((p) => p.startsWith(prefix));
}

type IndexEntry = { dir: string } & Record<string, unknown>;

function parseIndex(data: Buffer | undefined): { doc: Record<string, unknown>; assets: IndexEntry[] } | null {
  if (!data) return null;
  try {
    const doc = JSON.parse(data.toString("utf8")) as unknown;
    if (!doc || typeof doc !== "object" || !Array.isArray((doc as { assets?: unknown }).assets)) return null;
    const assets = ((doc as { assets: unknown[] }).assets).filter((a): a is IndexEntry => typeof a === "object" && a !== null && typeof (a as { dir?: unknown }).dir === "string");
    return { doc: doc as Record<string, unknown>, assets };
  } catch {
    return null;
  }
}

/** The package's folder index plus the base's entries for folders the package doesn't have and the result still holds; null when either can't be read. */
function mergedIndex(base: Buffer | undefined, upload: Buffer | undefined, files: ReadonlyMap<string, Buffer>): Buffer | null {
  const b = parseIndex(base);
  const u = parseIndex(upload);
  if (!b || !u) return null;
  const dirs = new Set(u.assets.map((a) => a.dir.replace(/\/+$/, "")));
  const paths = [...files.keys()];
  const kept = b.assets.filter((a) => {
    const dir = a.dir.replace(/\/+$/, "");
    return !dirs.has(dir) && paths.some((p) => p.startsWith(`${dir}/`));
  });
  return Buffer.from(`${JSON.stringify({ ...u.doc, assets: [...u.assets, ...kept] }, null, 2)}\n`, "utf8");
}
