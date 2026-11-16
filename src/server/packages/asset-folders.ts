import { isDeepStrictEqual } from "node:util";
import type { AssetFoldersRule, PackageLayout } from "@/server/policy/sections/package-layouts";
import { fill, matchesAny, sortPaths } from "./paths";
import { decodeText } from "./text";

/**
 * Agent Space folder layouts (layout `assetFolders`): one folder per asset
 * under a folder per asset type, each with a descriptor (`_asset.json`)
 * holding assetId, assetType and metadata. Pure helpers shared by the
 * mapping, the package checks and the export.
 */

export interface AssetFolder {
  /** Asset type of the type folder the asset folder sits in */
  assetType: string;
  /** Package path of the asset folder ("skill/verity") */
  dir: string;
  /** The folder's own name ("verity", "verity__ki-...") */
  folder: string;
  /** Package path of the descriptor */
  descriptorPath: string;
  hasDescriptor: boolean;
  /** Package paths of every other file in the folder, sorted */
  files: string[];
}

export interface AssetDescriptor {
  assetId?: string;
  assetType?: string;
  metadata: Record<string, unknown>;
  /** Top-level keys that are neither assetId, assetType, metadata nor bookkeeping (dropKeys) */
  extraKeys: string[];
}

const DESCRIPTOR_KEYS = new Set(["assetId", "assetType", "metadata"]);

/** Asset folders of every type folder in the rule, in type order then path order. */
export function listAssetFolders(paths: Iterable<string>, rule: AssetFoldersRule): AssetFolder[] {
  const all = sortPaths(paths);
  const out: AssetFolder[] = [];
  for (const [assetType, typeRule] of Object.entries(rule.types)) {
    const prefix = `${typeRule.dir}/`;
    const byFolder = new Map<string, string[]>();
    for (const p of all) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) continue; // a file directly in the type folder belongs to no asset
      const folder = rest.slice(0, slash);
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), p]);
    }
    for (const [folder, files] of byFolder) {
      const dir = `${prefix}${folder}`;
      const descriptorPath = `${dir}/${rule.descriptor}`;
      out.push({ assetType, dir, folder, descriptorPath, hasDescriptor: files.includes(descriptorPath), files: files.filter((p) => p !== descriptorPath) });
    }
  }
  return out;
}

/** Parse a descriptor. A problem means the file is not a usable descriptor. */
export function parseDescriptor(bytes: Buffer, rule: Pick<AssetFoldersRule, "dropKeys">): { descriptor: AssetDescriptor | null; problem?: string } {
  const text = decodeText(bytes);
  if (text === null) return { descriptor: null, problem: "it is not UTF-8 text" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { descriptor: null, problem: (e as Error).message };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { descriptor: null, problem: "it is not a JSON object" };
  const o = raw as Record<string, unknown>;
  for (const k of ["assetId", "assetType"] as const) {
    if (o[k] !== undefined && (typeof o[k] !== "string" || !o[k])) return { descriptor: null, problem: `${k} must be a non-empty string` };
  }
  const metadata = o.metadata ?? {};
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return { descriptor: null, problem: "metadata must be a JSON object" };
  const extraKeys = Object.keys(o).filter((k) => !DESCRIPTOR_KEYS.has(k) && !rule.dropKeys.includes(k));
  return {
    descriptor: {
      ...(typeof o.assetId === "string" ? { assetId: o.assetId } : {}),
      ...(typeof o.assetType === "string" ? { assetType: o.assetType } : {}),
      metadata: { ...(metadata as Record<string, unknown>) },
      extraKeys,
    },
  };
}

/** The asset's main file inside its folder ({name} metadata.name, falling back to the folder name; {folder}). */
export function assetMainFile(rule: AssetFoldersRule, assetType: string, metadata: Record<string, unknown>, folder: string): string | null {
  const t = rule.types[assetType];
  if (!t) return null;
  const name = typeof metadata.name === "string" && metadata.name ? metadata.name : folder;
  return fill(t.mainFile, { name, folder });
}

/** Files of an asset folder that are uploaded: everything but the descriptor and `neverUpload`. */
export function uploadedFiles(folder: AssetFolder, rule: Pick<AssetFoldersRule, "neverUpload">): { uploaded: string[]; never: string[] } {
  const uploaded: string[] = [];
  const never: string[] = [];
  for (const p of folder.files) (matchesAny(p.slice(folder.dir.length + 1), rule.neverUpload) ? never : uploaded).push(p);
  return { uploaded, never };
}

/**
 * Package path of the main file of the first asset folder whose descriptor
 * has this type and these metadata values, or null. Used by package checks
 * that name an asset instead of a path.
 */
export function findAssetMainFile(files: ReadonlyMap<string, Buffer>, layout: Pick<PackageLayout, "assetFolders">, selector: { assetType: string; metadata: Record<string, unknown> }): string | null {
  const rule = layout.assetFolders;
  if (!rule) return null;
  for (const f of listAssetFolders(files.keys(), rule)) {
    if (f.assetType !== selector.assetType || !f.hasDescriptor) continue;
    const { descriptor } = parseDescriptor(files.get(f.descriptorPath)!, rule);
    if (!descriptor || (descriptor.assetType !== undefined && descriptor.assetType !== f.assetType)) continue;
    if (!Object.entries(selector.metadata).every(([k, v]) => isDeepStrictEqual(descriptor.metadata[k], v))) continue;
    const main = assetMainFile(rule, f.assetType, descriptor.metadata, f.folder);
    const p = main ? `${f.dir}/${main}` : null;
    if (p && files.has(p)) return p;
  }
  return null;
}

/** Metadata matches a duplicates `keep` rule, with `defaults` for keys the asset leaves out. */
export function matchesKeep(metadata: Record<string, unknown>, rule: Pick<PackageLayout, "duplicates">["duplicates"]): boolean {
  return Object.entries(rule.keep).every(([k, v]) => isDeepStrictEqual(metadata[k] ?? rule.defaults[k], v));
}
