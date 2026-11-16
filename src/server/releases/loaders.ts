import { z } from "zod";
import { latestChangeByAsset, listIndexedAssets } from "@/server/assets/queries";
import { openSpaceHistoryRepo } from "@/server/assets/repo";
import type { Actor } from "@/server/aws/clients";
import { mapLimit } from "@/server/aws/paginate";
import type { HistoryRepo } from "@/server/git/history-repo";
import { assetContentHash } from "@/server/history/content-hash";
import { fillTemplate, safeSegment } from "@/server/history/layout";
import { getAppPolicy, getPolicyForRepo, type Policy } from "@/server/policy";
import type { SpaceRow } from "@/server/spaces/queries";
import type { ValidationResult } from "@/server/validation/types";
import { RELEASES } from "./config";
import {
  assetsNeedingContentHash,
  comparableFromIndex,
  comparableFromManifest,
  diffManifests,
  type DriftKind,
  type ManifestDiff,
  type ManifestDiffEntry,
} from "./diff";
import { ReleaseError } from "./errors";
import { parseManifest, type ManifestAsset } from "./manifest";
import { changeTimesAfter, getRelease, getReleaseByName, latestRelease, listReleases, type ReleaseRow } from "./queries";
import { planRollback, type RollbackDeps, type RollbackPreview, type RollbackTargetRequest } from "./rollback";
import { readAssetJsonAt } from "./source";
import { buildReleaseTable, countAfter, groupRollbackRows, releaseAnchor, type ReleaseChangeCounts, type ReleaseTableRow, type RollbackGroups } from "./views";

/**
 * Data for the release pages. Read-only. Each loader takes the
 * space row the page already authorized (`history.read`).
 */

export interface ReleaseSummary {
  id: string;
  name: string;
  tag: string;
  commit: string;
  sourceCommit: string;
  manifestPath: string;
  assetCount: number;
  note: string | null;
  planId: string | null;
  createdBy: string;
  createdAt: string;
  /** Recorded asset changes after the release (service time after the newest asset in its manifest); set by the list loaders */
  changesSince?: number;
}

function summary(row: ReleaseRow): ReleaseSummary {
  return {
    id: row.id,
    name: row.name,
    tag: row.tag,
    commit: row.commit,
    sourceCommit: row.sourceCommit,
    manifestPath: row.manifestPath,
    assetCount: row.assetCount,
    note: row.note,
    planId: row.planId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export type RepoState = { ok: true; head: string | null } | { ok: false; reason: "no-repo" | "not-cloned"; message: string };

async function openRepo(space: SpaceRow): Promise<{ state: RepoState; repo: HistoryRepo | null; policy: Policy }> {
  const opened = await openSpaceHistoryRepo(space);
  if (!opened.ok) return { state: { ok: false, reason: opened.reason, message: opened.message }, repo: null, policy: getAppPolicy().policy };
  return { state: { ok: true, head: await opened.repo.head() }, repo: opened.repo, policy: getPolicyForRepo(opened.repo.dir).policy };
}

export interface ReleaseListView {
  releases: ReleaseSummary[];
  /** Whether a release can be created: the history repository exists and has commits */
  repo: RepoState;
  /** Release name rule for the create form */
  nameRule: { pattern: string; hint: string; maxLength: number };
  noteMaxChars: number;
  /** Whether a release of HEAD syncs the space first (policy releases.syncBeforeCreate) */
  syncBeforeCreate?: boolean;
  /** The git tag and manifest path of a new release, with "{release}" where its name goes */
  tagTemplate?: string;
  manifestTemplate?: string;
}

/** Summaries with `changesSince`, from one read of the space's change times. */
async function withChangesSince(spaceId: string, rows: readonly ReleaseRow[]): Promise<ReleaseSummary[]> {
  const anchors = rows.map((r) => releaseAnchor(parseManifest(r.manifest)?.assets ?? []));
  const known = anchors.filter((a): a is Date => a !== null);
  const earliest = known.length ? new Date(Math.min(...known.map((a) => a.getTime()))) : null;
  const times = earliest ? await changeTimesAfter(spaceId, earliest) : [];
  return rows.map((r, i) => ({ ...summary(r), changesSince: countAfter(times, anchors[i] ?? null) }));
}

export async function loadReleaseList(space: SpaceRow): Promise<ReleaseListView> {
  const [{ state, policy }, rows] = await Promise.all([openRepo(space), listReleases(space.id)]);
  const rule = policy.releases.name;
  return {
    releases: await withChangesSince(space.id, rows),
    repo: state,
    nameRule: { pattern: rule.pattern, hint: rule.hint, maxLength: rule.maxLength },
    noteMaxChars: policy.releases.noteMaxChars,
    syncBeforeCreate: policy.releases.syncBeforeCreate,
    tagTemplate: fillTemplate(policy.historyLayout.releaseTag, { spaceAlias: safeSegment(space.alias), release: "{release}" }),
    manifestTemplate: fillTemplate(policy.historyLayout.releaseManifest, { spaceAlias: safeSegment(space.alias), release: "{release}" }),
  };
}

export interface ManifestTableRow {
  assetId: string;
  assetType: string;
  typeLabel: string;
  key: string;
  name: string;
  serviceVersion: number;
  serviceUpdatedAt: string;
  status: string | null;
  contentHash: string;
  metadataHash: string;
  /** How the asset differs in the current index */
  drift: DriftKind;
  currentAssetId: string | null;
  currentVersion: number | null;
  /** Live changes not in the history repository yet */
  pendingSync: boolean;
}

export interface DriftView extends ManifestDiff {
  /** HEAD of the history repository used for content hashes, or null */
  headCommit: string | null;
}

/**
 * Drift of manifest assets against the current index (live assets as last
 * synced). Content is compared by service version, and by the HEAD
 * asset.json's content hash where the versions differ.
 */
export async function driftAgainstIndex(space: SpaceRow, assets: readonly ManifestAsset[], repo: HistoryRepo | null, policy: Policy): Promise<DriftView> {
  const rows = await listIndexedAssets(space.id, { includeDeleted: true });
  const manifest = comparableFromManifest(assets);
  const head = repo ? await repo.head() : null;
  const hashes = new Map<string, { serviceVersion: number; contentHash: string }>();
  if (repo && head) {
    const rowById = new Map(rows.map((r) => [r.assetId, r]));
    const need = assetsNeedingContentHash(manifest, comparableFromIndex(rows, policy));
    await mapLimit(need, RELEASES.gitReadConcurrency, async (id) => {
      const gitPath = rowById.get(id)?.gitPath;
      const json = gitPath ? await readAssetJsonAt(repo, head, gitPath, policy.historyLayout) : null;
      if (json && json.assetId === id) hashes.set(id, { serviceVersion: json.serviceVersion, contentHash: assetContentHash(json.files) });
    });
  }
  const diff = diffManifests(manifest, comparableFromIndex(rows, policy, hashes), { statusKey: policy.releases.rollback.statusKey });
  return { ...diff, headCommit: head };
}

export interface ReleaseDetailView {
  release: ReleaseSummary;
  /** False when the stored manifest can't be parsed (rows and drift are then empty) */
  manifestOk: boolean;
  rows: ManifestTableRow[];
  /** The release against the current index: removed, added, content or metadata changes */
  drift: DriftView;
  /** Whether the tag exists in the working copy; null when the repository is not available */
  tagPresent: boolean | null;
  repo: RepoState;
}

export async function loadReleaseDetail(space: SpaceRow, releaseId: string): Promise<ReleaseDetailView | null> {
  const row = await getRelease(space.id, releaseId);
  if (!row) return null;
  const { state, repo, policy } = await openRepo(space);
  const manifest = parseManifest(row.manifest);
  const tagPresent = repo ? (await repo.tags()).includes(row.tag) : null;
  if (!manifest) {
    return { release: summary(row), manifestOk: false, rows: [], drift: { entries: [], counts: { added: 0, removed: 0, content: 0, metadata: 0, unchanged: 0 }, headCommit: null }, tagPresent, repo: state };
  }
  const drift = await driftAgainstIndex(space, manifest.assets, repo, policy);
  const byBefore = new Map<string, ManifestDiffEntry>();
  for (const e of drift.entries) if (e.before) byBefore.set(e.before.assetId, e);
  const statusKey = policy.releases.rollback.statusKey;
  const rows: ManifestTableRow[] = manifest.assets.map((a) => {
    const e = byBefore.get(a.assetId);
    const status = a.metadata[statusKey];
    return {
      assetId: a.assetId,
      assetType: a.assetType,
      typeLabel: policy.assetTypes.assetTypes[a.assetType]?.label ?? a.assetType,
      key: a.key,
      name: a.name,
      serviceVersion: a.serviceVersion,
      serviceUpdatedAt: a.serviceUpdatedAt,
      status: typeof status === "string" ? status : null,
      contentHash: a.contentHash,
      metadataHash: a.metadataHash,
      drift: e?.kind ?? "removed",
      currentAssetId: e?.after?.assetId ?? null,
      currentVersion: e?.after?.serviceVersion ?? null,
      pendingSync: e?.pendingSync ?? false,
    };
  });
  return { release: summary(row), manifestOk: true, rows, drift, tagPresent, repo: state };
}

export interface ReleaseCompareView {
  from: ReleaseSummary;
  to: ReleaseSummary;
  /** Changes from `from` to `to` */
  diff: ManifestDiff;
}

/** Two releases of the same space compared. Null when either is missing or unreadable. */
export async function loadReleaseCompare(space: SpaceRow, fromId: string, toId: string): Promise<ReleaseCompareView | null> {
  const [a, b] = await Promise.all([getRelease(space.id, fromId), getRelease(space.id, toId)]);
  const ma = a ? parseManifest(a.manifest) : null;
  const mb = b ? parseManifest(b.manifest) : null;
  if (!a || !b || !ma || !mb) return null;
  const { policy } = await openRepo(space);
  return { from: summary(a), to: summary(b), diff: diffManifests(comparableFromManifest(ma.assets), comparableFromManifest(mb.assets), { statusKey: policy.releases.rollback.statusKey }) };
}

/** The rollback preview without file contents (safe to send to the browser). */
export type RollbackPreviewView = Omit<RollbackPreview, "items"> & { itemCount: number };

export type RollbackPreviewResult =
  | { ok: true; preview: RollbackPreviewView }
  | { ok: false; message: string; fieldErrors: Record<string, string>; problems: ValidationResult[] };

/**
 * What a rollback plan will contain before it is created: one row per asset
 * with its action (update, create, deactivate, delete, keep, skip), notes,
 * removed metadata keys, refs, problems and validation results.
 */
export async function loadRollbackPreview(space: SpaceRow, target: RollbackTargetRequest, actor: Actor, deps: RollbackDeps = {}): Promise<RollbackPreviewResult> {
  try {
    const { items, ...rest } = await planRollback(space, target, actor, deps);
    return { ok: true, preview: { ...rest, itemCount: items.length } };
  } catch (err) {
    if (err instanceof ReleaseError) return { ok: false, message: err.message, fieldErrors: err.fieldErrors, problems: err.problems };
    if (err instanceof z.ZodError) return { ok: false, message: "Choose a release, a commit or an asset version to roll back to.", fieldErrors: {}, problems: [] };
    throw err;
  }
}

/** The newest release with its changes since, for the Releases card on Home. Null when the space has none. */
export async function loadLatestRelease(space: SpaceRow): Promise<ReleaseSummary | null> {
  const row = await latestRelease(space.id);
  if (!row) return null;
  const [withCount] = await withChangesSince(space.id, [row]);
  return withCount ?? null;
}

export interface ReleasePageView extends ReleaseDetailView {
  /** The newest release of the space */
  latest: boolean;
  /** Manifest assets and assets added since, with their change word and last change (releases.md "Release detail") */
  table: ReleaseTableRow[];
  counts: ReleaseChangeCounts;
}

async function tableFor(space: SpaceRow, detail: ReleaseDetailView, row: ReleaseRow, policy: Policy): Promise<{ table: ReleaseTableRow[]; counts: ReleaseChangeCounts }> {
  const manifest = detail.manifestOk ? parseManifest(row.manifest) : null;
  if (!manifest) return { table: [], counts: { unchanged: 0, changed: 0, content: 0, status: 0, metadata: 0, removed: 0, added: 0 } };
  const [index, latest] = await Promise.all([listIndexedAssets(space.id, { includeDeleted: true }), latestChangeByAsset(space.id)]);
  const built = buildReleaseTable({ assets: manifest.assets, drift: detail.drift, index, latest, policy });
  return { table: built.rows, counts: built.counts };
}

/** Release detail by name (the route uses the name). Null when the space has no release of that name. */
export async function loadReleasePage(space: SpaceRow, name: string): Promise<ReleasePageView | null> {
  const row = await getReleaseByName(space.id, name);
  if (!row) return null;
  const [detail, newest, { policy }] = await Promise.all([loadReleaseDetail(space, row.id), latestRelease(space.id), openRepo(space)]);
  if (!detail) return null;
  return { ...detail, latest: newest?.id === row.id, ...(await tableFor(space, detail, row, policy)) };
}

export interface RollbackPageView {
  release: ReleaseSummary;
  preview: RollbackPreviewResult;
  /** Preview rows grouped for the table; null when the preview failed */
  groups: RollbackGroups | null;
}

/** The rollback preview of a release, grouped as on the page. Reads only. */
export async function loadRollbackPage(space: SpaceRow, name: string, actor: Actor, deps: RollbackDeps = {}): Promise<RollbackPageView | null> {
  const row = await getReleaseByName(space.id, name);
  if (!row) return null;
  const [detail, { policy }] = await Promise.all([loadReleaseDetail(space, row.id), openRepo(space)]);
  if (!detail) return null;
  const preview = await loadRollbackPreview(space, { kind: "release", releaseId: row.id }, actor, deps);
  const manifest = parseManifest(row.manifest);
  if (!preview.ok || !manifest) return { release: detail.release, preview, groups: null };
  const { table } = await tableFor(space, detail, row, policy);
  return { release: detail.release, preview, groups: groupRollbackRows({ rows: preview.preview.rows, table, assets: manifest.assets, policy }) };
}
