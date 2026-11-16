import type { Policy } from "@/server/policy";
import type { SpaceRow } from "@/server/spaces/queries";
import { policyFor, toListRow, type AssetListRow } from "./browse";
import { assetDirectory, getSyncState, latestChangeByAsset, listIndexedAssets, type SyncStateRow } from "./queries";
import { openSpaceHistoryRepo, type SpaceRepo } from "./repo";
import { buildPathTree, type TreeNode } from "./tree";

/**
 * The asset list (design-system MASTER "Page index"): one section
 * per asset type in policy order, which is the console's order, with the
 * memories grouped by store and folder. Reads Postgres only.
 */

/** Rows per section before "Show all" (MASTER "Tables": over 50 rows, show more). */
export const SECTION_ROWS = 50;

export interface MemoryGroup {
  storeId: string | null;
  store: AssetListRow | null;
  tree: TreeNode<AssetListRow>[];
  count: number;
}

export interface AssetSection {
  assetType: string;
  label: string;
  /** Plural heading from the policy noun, "Memories" */
  heading: string;
  /** Assets of the type (with deleted ones when asked) */
  total: number;
  rows: AssetListRow[];
  /** Only memories: rows grouped by store, then by folder */
  memoryGroups?: MemoryGroup[];
  truncated: boolean;
}

export interface AssetSectionsView {
  sections: AssetSection[];
  /** The type filter, when it names a known section */
  selectedType: string | null;
  deletedCount: number;
  syncState: SyncStateRow | null;
  repo: SpaceRepo;
  policy: Policy;
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** "Memories", "Custom agents": the plural noun, else the label. */
export function sectionHeading(policy: Pick<Policy, "assetTypes">, assetType: string): string {
  const entry = policy.assetTypes.assetTypes[assetType];
  return entry?.noun ? capitalize(entry.noun.other) : (entry?.label ?? assetType);
}

/** Types in policy order, then types policy doesn't know in name order. Pure. */
export function orderTypes(policyOrder: readonly string[], present: Iterable<string>): string[] {
  const rank = (t: string) => (policyOrder.includes(t) ? policyOrder.indexOf(t) : Number.MAX_SAFE_INTEGER);
  return [...new Set(present)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Memories grouped by store name, stores without a known row last; folders within each. Pure. */
export function groupMemories(rows: readonly AssetListRow[], stores: ReadonlyMap<string, AssetListRow>): MemoryGroup[] {
  const byStore = new Map<string | null, AssetListRow[]>();
  for (const r of rows) byStore.set(r.parentAssetId, [...(byStore.get(r.parentAssetId) ?? []), r]);
  return [...byStore.entries()]
    .map(([storeId, memories]) => ({ storeId, store: storeId ? (stores.get(storeId) ?? null) : null, tree: buildPathTree(memories, (m) => m.name), count: memories.length }))
    .sort((a, b) => (a.store?.name ?? "\uffff").localeCompare(b.store?.name ?? "\uffff"));
}

export async function loadAssetSections(space: SpaceRow, opts: { assetType?: string | null; includeDeleted?: boolean } = {}): Promise<AssetSectionsView> {
  const repo = await openSpaceHistoryRepo(space);
  const policy = policyFor(repo);
  const [indexed, directory, lastChanges, syncState] = await Promise.all([
    listIndexedAssets(space.id, { includeDeleted: true }),
    assetDirectory(space.id),
    latestChangeByAsset(space.id),
    getSyncState(space.id),
  ]);
  const storeById = new Map([...directory].map(([id, d]) => [id, { name: d.name, assetType: d.assetType }]));
  const ctx = { policy, storeById, lastChanges };
  const all = indexed.map((r) => toListRow(r, ctx));
  const shown = opts.includeDeleted ? all : all.filter((r) => !r.deleted);
  const byType = new Map<string, AssetListRow[]>();
  for (const r of shown) byType.set(r.assetType, [...(byType.get(r.assetType) ?? []), r]);
  const types = orderTypes(Object.keys(policy.assetTypes.assetTypes), byType.keys());
  const selectedType = opts.assetType && types.includes(opts.assetType) ? opts.assetType : null;
  const stores = new Map(all.filter((r) => r.assetType === "memory_store").map((r) => [r.assetId, r]));

  const sections = (selectedType ? [selectedType] : types).map((assetType): AssetSection => {
    let rows = byType.get(assetType) ?? [];
    if (assetType === "memory") rows = groupMemories(rows, stores).flatMap((g) => flatten(g.tree));
    const cap = selectedType ? rows.length : SECTION_ROWS;
    const capped = rows.slice(0, cap);
    return {
      assetType,
      label: policy.assetTypes.assetTypes[assetType]?.label ?? assetType,
      heading: sectionHeading(policy, assetType),
      total: rows.length,
      rows: capped,
      ...(assetType === "memory" ? { memoryGroups: groupMemories(capped, stores) } : {}),
      truncated: capped.length < rows.length,
    };
  });
  return { sections, selectedType, deletedCount: all.filter((r) => r.deleted).length, syncState, repo, policy };
}

/** Items of a tree in display order (folders first, as buildPathTree sorts them). */
export function flatten<T>(nodes: readonly TreeNode<T>[]): T[] {
  return nodes.flatMap((n) => [...n.items, ...flatten(n.children)]);
}

/** Memories of one store, for the store's page. */
export async function loadStoreMemories(space: SpaceRow, storeId: string, policy: Policy): Promise<AssetListRow[]> {
  const [memories, directory] = await Promise.all([listIndexedAssets(space.id, { assetType: "memory" }), assetDirectory(space.id)]);
  const own = memories.filter((m) => m.parentAssetId === storeId);
  const lastChanges = await latestChangeByAsset(
    space.id,
    own.map((m) => m.assetId),
  );
  const storeById = new Map([...directory].map(([id, d]) => [id, { name: d.name, assetType: d.assetType }]));
  return flatten(buildPathTree(own.map((m) => toListRow(m, { policy, storeById, lastChanges })), (m) => m.name));
}
