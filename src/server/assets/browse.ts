import path from "node:path";
import type { ChangeSource } from "@/lib/assets/types";
import { assetLabel, assetLabelKey } from "@/server/history/display-name";
import { getPolicyForRepo, type Policy } from "@/server/policy";
import type { SpaceRow } from "@/server/spaces/queries";
import {
  assetStatus,
  collectAssetReferences,
  groupReferences,
  instructionSlots,
  managedLabel,
  resolveAssetTypeTabs,
  skillFields,
  type AssetRef,
  type AssetTypeTab,
  type InstructionSlot,
  type ManagedLabel,
  type SkillFields,
} from "./catalog";
import { splitFrontmatter, type Frontmatter } from "./frontmatter";
import { resolveSource } from "./history";
import { liveAssetTypes, liveGetAsset, type LiveDeps } from "./live";
import {
  assetDirectory,
  countAssetsByType,
  getIndexedAsset,
  getSyncState,
  latestChangeByAsset,
  listIndexedAssets,
  type AssetChange,
  type IndexedAsset,
  type SyncStateRow,
} from "./queries";
import { openSpaceHistoryRepo, readCommittedAsset, type CommittedAsset, type SpaceRepo } from "./repo";
import { measureInstructions, type SizeMeter } from "./size-meter";
import { compareCommittedToLive, type LiveRead, type SyncStatus } from "./sync-status";
import { buildPathTree, type TreeNode } from "./tree";

/**
 * Data for the asset browser pages (read-only). Each function takes the space
 * row the page already authorized and optional live dependencies, so tests can
 * run them against a test database, a temp history repository and mocked API
 * clients.
 */

export interface LastChange {
  source: ChangeSource;
  label: string;
  principal: string | null;
  at: string;
  version: number;
  changeKind: string;
}

export interface AssetListRow {
  assetId: string;
  assetType: string;
  /** Display name (assetLabel): "Global instructions", an artifact's title */
  name: string;
  /** The key the display name hides, for mono meta text ("GENERIC"), else null */
  nameKey?: string | null;
  status: string | null;
  version: number | null;
  updatedAt: string | null;
  deleted: boolean;
  managed: ManagedLabel;
  lastChange: LastChange | null;
  parentAssetId: string | null;
  metadata: Record<string, unknown>;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function metadataOf(row: Pick<IndexedAsset, "metadata">): Record<string, unknown> {
  const m = row.metadata;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

export function toLastChange(c: AssetChange | undefined, labels: Policy["attribution"]["labels"]): LastChange | null {
  if (!c) return null;
  const { source, label } = resolveSource(c, null, labels);
  return { source, label, principal: c.principal, at: c.serviceUpdatedAt.toISOString(), version: c.serviceVersion, changeKind: c.changeKind };
}

export function policyFor(repo: SpaceRepo): Policy {
  return getPolicyForRepo(repo.ok ? repo.repo.dir : null, repo.ok ? repo.layout.policyDir : undefined).policy;
}

/** One index row as an AssetListRow (status, version, Managed label and last change). */
export function toListRow(
  r: IndexedAsset,
  ctx: { policy: Policy; storeById: ReadonlyMap<string, { name: string; assetType: string }>; lastChanges: ReadonlyMap<string, AssetChange> },
): AssetListRow {
  return {
    assetId: r.assetId,
    assetType: r.assetType,
    name: assetLabel(ctx.policy, r),
    nameKey: assetLabelKey(ctx.policy, r),
    status: assetStatus(r.metadata),
    version: r.liveVersion ?? r.lastSyncedVersion,
    updatedAt: iso(r.liveUpdatedAt ?? r.lastSyncedUpdatedAt),
    deleted: Boolean(r.deletedAt),
    managed: managedLabel(ctx.policy.assetTypes.assetTypes, r, ctx.storeById),
    lastChange: toLastChange(ctx.lastChanges.get(r.assetId), ctx.policy.attribution.labels),
    parentAssetId: r.parentAssetId,
    metadata: metadataOf(r),
  };
}

// ---------- list page ----------

export interface InstructionView {
  row: AssetListRow;
  meter: SizeMeter | null;
  /** Main file content from git, for the instructions view */
  content: string | null;
}

export interface MemoryStoreView {
  store: AssetListRow | null;
  storeId: string | null;
  tree: TreeNode<AssetListRow>[];
  count: number;
}

export interface AssetListView {
  tabs: AssetTypeTab[];
  tabSource: "live" | "policy";
  liveTypesError: string | null;
  selectedType: string;
  typeLabel: string;
  rows: AssetListRow[];
  syncState: SyncStateRow | null;
  repo: SpaceRepo;
  instructions?: InstructionSlot<InstructionView>[];
  memoryStores?: MemoryStoreView[];
  references?: Map<string, { assetType: string | null; refs: AssetRef[] }[]>;
  skills?: Map<string, SkillFields>;
  memoryCounts?: Map<string, number>;
  policy: Policy;
}

export async function loadAssetList(space: SpaceRow, opts: { assetType?: string | null; includeDeleted?: boolean; live: LiveDeps | null }): Promise<AssetListView> {
  const repo = await openSpaceHistoryRepo(space);
  const policy = policyFor(repo);
  const typesPolicy = policy.assetTypes.assetTypes;
  const [counts, liveTypes, syncState, directory] = await Promise.all([
    countAssetsByType(space.id),
    opts.live ? liveAssetTypes(opts.live) : Promise.resolve(null),
    getSyncState(space.id),
    assetDirectory(space.id),
  ]);
  const { tabs, source } = resolveAssetTypeTabs(liveTypes?.ok ? liveTypes.value : null, typesPolicy, counts);
  const selectedType = opts.assetType && tabs.some((t) => t.assetType === opts.assetType) ? opts.assetType : (tabs[0]?.assetType ?? "agents_md");
  const typeLabel = tabs.find((t) => t.assetType === selectedType)?.label ?? selectedType;

  const indexed = await listIndexedAssets(space.id, { assetType: selectedType, includeDeleted: opts.includeDeleted });
  const lastChanges = await latestChangeByAsset(
    space.id,
    indexed.map((r) => r.assetId),
  );
  const storeById = new Map([...directory].map(([id, d]) => [id, { name: d.name, assetType: d.assetType }]));
  const labels = policy.attribution.labels;
  const rows: AssetListRow[] = indexed.map((r) => ({
    assetId: r.assetId,
    assetType: r.assetType,
    name: assetLabel(policy, r),
    nameKey: assetLabelKey(policy, r),
    status: assetStatus(r.metadata),
    version: r.liveVersion ?? r.lastSyncedVersion,
    updatedAt: iso(r.liveUpdatedAt ?? r.lastSyncedUpdatedAt),
    deleted: Boolean(r.deletedAt),
    managed: managedLabel(typesPolicy, r, storeById),
    lastChange: toLastChange(lastChanges.get(r.assetId), labels),
    parentAssetId: r.parentAssetId,
    metadata: metadataOf(r),
  }));

  const view: AssetListView = {
    tabs,
    tabSource: source,
    liveTypesError: liveTypes && !liveTypes.ok ? liveTypes.error : opts.live ? null : "Live reads are off",
    selectedType,
    typeLabel,
    rows,
    syncState,
    repo,
    policy,
  };

  if (selectedType === "agents_md") {
    const mainFile = typesPolicy.agents_md?.mainFile ?? "AGENTS.md";
    const byId = new Map(indexed.map((r) => [r.assetId, r]));
    const items = await Promise.all(
      rows.map(async (row): Promise<InstructionView & { assetId: string; metadata: unknown }> => {
        const gitPath = byId.get(row.assetId)?.gitPath;
        const content = repo.ok && gitPath ? await repo.repo.show("HEAD", path.posix.join(gitPath, mainFile)) : null;
        return { assetId: row.assetId, metadata: row.metadata, row, content, meter: content === null ? null : measureInstructions(content, policy.limits) };
      }),
    );
    view.instructions = instructionSlots(policy.agentTypes.agentTypes, items, policy.historyLayout.nameKeys.agents_md ?? "agent_type");
  }

  if (selectedType === "memory") {
    const groups = new Map<string | null, AssetListRow[]>();
    for (const r of rows) groups.set(r.parentAssetId, [...(groups.get(r.parentAssetId) ?? []), r]);
    const stores = await listIndexedAssets(space.id, { assetType: "memory_store", includeDeleted: true });
    const storeRows = new Map(stores.map((s) => [s.assetId, s]));
    view.memoryStores = [...groups.entries()]
      .map(([storeId, memories]): MemoryStoreView => {
        const s = storeId ? storeRows.get(storeId) : undefined;
        return {
          storeId,
          store: s
            ? {
                assetId: s.assetId,
                assetType: s.assetType,
                name: s.name,
                nameKey: null,
                status: assetStatus(s.metadata),
                version: s.liveVersion ?? s.lastSyncedVersion,
                updatedAt: iso(s.liveUpdatedAt ?? s.lastSyncedUpdatedAt),
                deleted: Boolean(s.deletedAt),
                managed: managedLabel(typesPolicy, s, storeById),
                lastChange: null,
                parentAssetId: null,
                metadata: metadataOf(s),
              }
            : null,
          tree: buildPathTree(memories, (m) => m.name),
          count: memories.length,
        };
      })
      .sort((a, b) => (a.store?.name ?? "\uffff").localeCompare(b.store?.name ?? "\uffff"));
  }

  if (selectedType === "memory_store") {
    const memories = await listIndexedAssets(space.id, { assetType: "memory" });
    const counts = new Map<string, number>();
    for (const m of memories) if (m.parentAssetId) counts.set(m.parentAssetId, (counts.get(m.parentAssetId) ?? 0) + 1);
    view.memoryCounts = counts;
  }

  if (selectedType === "skill") {
    view.skills = new Map(rows.map((r) => [r.assetId, skillFields(r.metadata, null)]));
  }

  if (selectedType === "custom_agent") {
    view.references = new Map(rows.map((r) => [r.assetId, groupReferences(collectAssetReferences(r.metadata, directory, r.assetId))]));
  }

  return view;
}

// ---------- detail page ----------

export interface AssetDetailView {
  asset: IndexedAsset;
  /** What the page calls the asset (assetLabel); asset.name stays the stored identity */
  displayName: string;
  /** The key the display name hides ("GENERIC"), for mono meta text, else null */
  nameKey?: string | null;
  metadata: Record<string, unknown>;
  typeLabel: string;
  managed: ManagedLabel;
  repo: SpaceRepo;
  committed: CommittedAsset | null;
  live: LiveRead;
  syncStatus: SyncStatus;
  lastChange: LastChange | null;
  /** Files listed in asset.json, as a folder tree */
  fileTree: TreeNode<CommittedAsset["files"][number]>[];
  mainFile: string | null;
  /** Frontmatter of the main file (SKILL.md, memory markdown) */
  frontmatter: Frontmatter | null;
  skill: SkillFields | null;
  meter: SizeMeter | null;
  /** memory_store: its memories as a folder tree */
  memoryTree: TreeNode<{ assetId: string; name: string; status: string | null; deleted: boolean }>[] | null;
  /** memory: its store */
  store: { assetId: string; name: string } | null;
  /** custom_agent: referenced skills and memory stores */
  references: { assetType: string | null; refs: AssetRef[] }[] | null;
  policy: Policy;
}

/** The file to feature for an asset: policy mainFile if present, else the only file, else the first markdown file. */
export function pickMainFile(files: readonly { path: string }[], mainFile: string | undefined): string | null {
  if (mainFile && files.some((f) => f.path === mainFile)) return mainFile;
  if (files.length === 1) return files[0]!.path;
  return files.find((f) => /\.md$/i.test(f.path) && !f.path.includes("/"))?.path ?? null;
}

/**
 * `at` reads the content at one commit instead of HEAD. Callers pass only a
 * commit taken from the asset's own history, never one from the URL as is.
 */
export async function loadAssetDetail(space: SpaceRow, assetId: string, opts: { live: LiveDeps | null; at?: string | null }): Promise<AssetDetailView | null> {
  const asset = await getIndexedAsset(space.id, assetId);
  if (!asset) return null;
  const repo = await openSpaceHistoryRepo(space);
  const policy = policyFor(repo);
  const typesPolicy = policy.assetTypes.assetTypes;
  const typePolicy = typesPolicy[asset.assetType];
  const [committed, live, directory, lastChanges] = await Promise.all([
    repo.ok && asset.gitPath ? readCommittedAsset(repo.repo, asset.gitPath, repo.layout, opts.at ?? "HEAD") : Promise.resolve(null),
    opts.live ? liveGetAsset(opts.live, asset.assetId) : Promise.resolve<LiveRead>({ ok: false, notFound: false, error: "Live reads are off" }),
    assetDirectory(space.id),
    latestChangeByAsset(space.id, [asset.assetId]),
  ]);
  const metadata = committed?.assetJson.metadata ?? metadataOf(asset);
  const storeById = new Map([...directory].map(([id, d]) => [id, { name: d.name, assetType: d.assetType }]));
  const files = committed?.files ?? [];
  const mainFile = pickMainFile(files, typePolicy?.mainFile);
  const mainContent = mainFile ? (files.find((f) => f.path === mainFile)?.content ?? null) : null;
  const frontmatter = mainContent !== null && /\.md$/i.test(mainFile ?? "") ? splitFrontmatter(mainContent) : null;

  let memoryTree: AssetDetailView["memoryTree"] = null;
  if (asset.assetType === "memory_store") {
    const memories = (await listIndexedAssets(space.id, { assetType: "memory" })).filter((m) => m.parentAssetId === asset.assetId);
    memoryTree = buildPathTree(
      memories.map((m) => ({ assetId: m.assetId, name: m.name, status: assetStatus(m.metadata), deleted: Boolean(m.deletedAt) })),
      (m) => m.name,
    );
  }
  const parent = asset.parentAssetId ? directory.get(asset.parentAssetId) : undefined;

  const labelInput = { assetId: asset.assetId, assetType: asset.assetType, name: asset.name, metadata };
  return {
    asset,
    displayName: assetLabel(policy, labelInput),
    nameKey: assetLabelKey(policy, labelInput),
    metadata,
    typeLabel: typePolicy?.label ?? asset.assetType,
    managed: managedLabel(typesPolicy, asset, storeById),
    repo,
    committed,
    live,
    syncStatus: compareCommittedToLive(
      committed ? { serviceVersion: committed.assetJson.serviceVersion, serviceUpdatedAt: committed.assetJson.serviceUpdatedAt, metadata: committed.assetJson.metadata } : null,
      live,
    ),
    lastChange: toLastChange(lastChanges.get(asset.assetId), policy.attribution.labels),
    fileTree: buildPathTree(files, (f) => f.path),
    mainFile,
    frontmatter,
    skill: asset.assetType === "skill" ? skillFields(metadata, frontmatter?.data ?? null) : null,
    meter: asset.assetType === "agents_md" && mainContent !== null ? measureInstructions(mainContent, policy.limits) : null,
    memoryTree,
    store: asset.parentAssetId ? { assetId: asset.parentAssetId, name: parent?.name ?? asset.parentAssetId } : null,
    references: asset.assetType === "custom_agent" ? groupReferences(collectAssetReferences(metadata, directory, asset.assetId)) : null,
    policy,
  };
}
