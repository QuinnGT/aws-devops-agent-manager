import path from "node:path";
import type { Policy } from "@/server/policy";

/**
 * Path helpers for the history repository layout (policy/history-layout.yaml).
 * Shared by sync (writer) and the asset browser (reader). Pure; unit-tested.
 */

type Layout = Policy["historyLayout"];

/** Make one path segment safe: lowercase-friendly, no slashes, no dots-only names. */
export function safeSegment(s: string): string {
  const cleaned = s
    .normalize("NFKC")
    .replace(/[^\w.@-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 128);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "_";
}

/** A slash-separated name (memory names like "databases/rds-failover") made safe segment by segment. */
export function safeNestedPath(s: string): string {
  return s
    .split("/")
    .filter(Boolean)
    .map(safeSegment)
    .join("/") || "_";
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = values[key];
    if (v === undefined) throw new Error(`layout template ${template} needs {${key}}`);
    return v;
  });
}

export function spaceRoot(layout: Layout, spaceAlias: string): string {
  return fillTemplate(layout.spaceRoot, { spaceAlias: safeSegment(spaceAlias) });
}

export interface AssetPathInput {
  assetId: string;
  assetType: string;
  metadata: Record<string, unknown>;
  /** For memories: the parent store's name (looked up from memory_store_id) */
  storeName?: string | null;
}

/** Display name for an asset from its metadata, per layout.nameKeys. */
export function assetDisplayName(layout: Layout, a: Pick<AssetPathInput, "assetId" | "assetType" | "metadata">): string {
  const key = layout.nameKeys[a.assetType] ?? layout.nameKeys.default ?? "name";
  const v = a.metadata[key];
  return typeof v === "string" && v ? v : a.assetId;
}

/** Directory of an asset in the history repository, relative to the repo root. */
export function assetDir(layout: Layout, spaceAlias: string, a: AssetPathInput): string {
  const template = layout.assetDirs[a.assetType] ?? layout.assetDirs.default!;
  const name = assetDisplayName(layout, a);
  const agentType = typeof a.metadata.agent_type === "string" ? a.metadata.agent_type : a.assetId;
  const rel = fillTemplate(template, {
    assetType: safeSegment(a.assetType),
    assetId: safeSegment(a.assetId),
    name: a.assetType === "memory" ? safeNestedPath(name) : safeSegment(name),
    agentType: safeSegment(agentType),
    storeName: safeSegment(a.storeName ?? String(a.metadata.memory_store_id ?? "_unknown-store")),
  });
  return path.posix.join(spaceRoot(layout, spaceAlias), rel);
}

export function assetJsonPath(layout: Layout, spaceAlias: string, a: AssetPathInput): string {
  return path.posix.join(assetDir(layout, spaceAlias, a), layout.assetJson);
}

export function releaseManifestPath(layout: Layout, spaceAlias: string, release: string): string {
  return fillTemplate(layout.releaseManifest, { spaceAlias: safeSegment(spaceAlias), release: safeSegment(release) });
}

export function releaseTagName(layout: Layout, spaceAlias: string, release: string): string {
  return fillTemplate(layout.releaseTag, { spaceAlias: safeSegment(spaceAlias), release: safeSegment(release) });
}
