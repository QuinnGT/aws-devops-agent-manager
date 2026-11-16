/**
 * Types shared by the package tools (read, map, build, export) and the
 * validation engine. See README.md in this folder for the API.
 */

/** A package held in memory: package-relative path (forward slashes) -> bytes. */
export interface PackageContents {
  /** Package name: the folder name, the zip's single top folder, or the zip file name without .zip */
  name: string;
  files: Map<string, Buffer>;
}

/** One file of a desired asset, in the same shape as AssetFileSnapshot content. */
export interface DesiredFile {
  /** Path inside the asset, forward slashes: "SKILL.md", "references/x.md", "AGENTS.md" */
  path: string;
  encoding: "utf8" | "base64";
  content: string;
  /** Package path this file came from, when it came from a package */
  sourcePath?: string;
}

/**
 * An asset as it should exist in the space: a draft from the editor, an asset
 * from a package, or a live asset converted for comparison.
 */
export interface DesiredAsset {
  assetType: string;
  /**
   * Unique key of the asset within its type, from asset-types.yaml `identity`
   * (skill and store name, agents_md agent_type, "<store>/<memory name>").
   * Computed by assetIdentity(); recompute after editing metadata or refs.
   */
  key: string;
  /** Service asset ID when the asset already exists in the space */
  assetId?: string;
  metadata: Record<string, unknown>;
  files: DesiredFile[];
  /**
   * References by identity key, used before asset IDs are known, for example
   * { memoryStore: "glossary" } or { skills: ["a", "b"] }. Names come
   * from asset-types.yaml `references[].ref`. The plan resolves them to IDs.
   */
  refs?: Record<string, string | string[]>;
  /** Package path of the asset's main source file or folder, for messages */
  source?: string;
  /**
   * The asset ID the package says the asset had where it came from (an
   * Agent Space folder's descriptor). Not an ID in the target space: the
   * import planner sets `assetId` from it only when that space holds the ID.
   */
  sourceAssetId?: string;
}

/** A live asset known to the space (for references, counts and uniqueness). */
export interface LiveAssetRef {
  assetId: string;
  assetType: string;
  metadata: Record<string, unknown>;
}

/** A text file of an asset as it appears in a package (consumed by analyzers). */
export interface PackageFile {
  assetType: string;
  /** The asset's identity key (DesiredAsset.key), for example a skill name or "<store>/<memory name>" */
  name: string;
  /** Package path, for example "memory/incident-patterns/patterns/x.md" */
  path: string;
  /** UTF-8 text as it is uploaded */
  body: string;
}

/** `${assetType}:${key}`, the assetKey used in validation results. */
export function assetKeyOf(a: Pick<DesiredAsset, "assetType" | "key">): string {
  return `${a.assetType}:${a.key}`;
}
