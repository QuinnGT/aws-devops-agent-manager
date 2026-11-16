import { createHash } from "node:crypto";
import path from "node:path";
import { parseAssetJson } from "@/server/assets/repo";
import type { HistoryRepo } from "@/server/git/history-repo";
import { assetLabel } from "@/server/history/display-name";
import { spaceRoot } from "@/server/history/layout";
import { liveIdentityIndex, type Analysis, type LiveIndexEntry } from "@/server/package-io/analyze";
import { packageToDesiredAssets } from "@/server/packages/desired";
import type { PackageLayout } from "@/server/packages/layout";
import { assetKeyOf, type DesiredAsset, type PackageContents } from "@/server/packages/types";
import type { Policy } from "@/server/policy";
import { canonicalize } from "@/server/sync/content";
import { computeIdentity } from "@/server/validation/identity";
import { readRevisionPackage } from "./package-files";

/**
 * What a plan from a revision holds: only the assets whose package files
 * differ from the revision's base package (the branch's first commit), so
 * the saves' changes and the build outputs of those assets. An asset the
 * revision didn't touch but that differs between the base and the live space
 * (changed or deleted live after the base) is left alone and named in the
 * plan's notes. An asset the revision changed that also changed live after
 * the base is a conflict: its plan item carries the base version, so the
 * plan check flags it the way it flags a draft whose base moved.
 *
 * The comparison is package against package (both mapped with the layout),
 * so it does not depend on how faithfully a package round-trips the live
 * assets. The base versions come from the asset.json files at the base
 * commit. `revisionScope` is pure; `readBaseAssetStates` and
 * `loadRevisionScope` read git.
 */

/** One asset at the revision's base commit, from its asset.json. */
export interface BaseAssetState {
  assetId: string;
  assetType: string;
  metadata: Record<string, unknown>;
  version: number;
  updatedAt: string;
}

export type ScopeConflict =
  /** The revision changed it, and the live asset moved past the base version */
  | { kind: "changed-live"; baseVersion: number; liveVersion: number | null }
  /** The revision changed it, and it was deleted from the live space after the base */
  | { kind: "deleted-live"; baseVersion: number };

export interface ChangedAsset {
  assetKey: string;
  label: string;
  /** The asset at the base commit, when the base had it */
  base: BaseAssetState | null;
  /** The live space changed it too after the base */
  conflict: ScopeConflict | null;
}

export interface PlannedAsset {
  /** Index into the analysis's items and desired assets */
  index: number;
  assetKey: string;
  label: string;
  /** The asset at the base, when the plan item updates that same live asset: the plan check compares live with it */
  base: { assetId: string; version: number; updatedAt: string } | null;
  conflict: ScopeConflict | null;
}

export interface LeftAloneAsset {
  assetKey: string;
  label: string;
  /** The asset is not in the live space any more */
  deleted: boolean;
}

export interface RevisionScope {
  /** Assets whose package files differ from the base package (the saves and the build outputs of what they edited), in package order */
  changed: ChangedAsset[];
  /** Not changed by the revision, but changed or deleted in the live space after the base: left as they are live */
  leftAlone: LeftAloneAsset[];
  /** With an analysis: the changed assets that differ from the live space, which the plan holds */
  planned: PlannedAsset[];
  /** With an analysis: package assets that match the live space */
  unchanged: number;
  /** With an analysis: live assets the package doesn't have */
  untouched: number;
}

/** A desired asset's content and metadata, independent of file order, key order and source paths. */
export function desiredSignature(d: Pick<DesiredAsset, "files" | "metadata" | "refs">): string {
  const files = d.files.map((f) => [f.path, f.encoding, f.content] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash("sha256")
    .update(JSON.stringify([files, canonicalize(d.metadata), canonicalize(d.refs ?? {})]))
    .digest("hex");
}

/** What the plan notes and the revision page call an asset: "Incident RCA instructions", "Skill low-sample-size-check". */
export function scopeAssetLabel(policy: Pick<Policy, "assetTypes" | "agentTypes" | "historyLayout">, d: Pick<DesiredAsset, "assetType" | "key" | "metadata">): string {
  const name = assetLabel(policy, { assetType: d.assetType, name: d.key, metadata: d.metadata });
  if (d.assetType === "agents_md") return name;
  const type = policy.assetTypes.assetTypes[d.assetType]?.label;
  return type ? `${type} ${name}` : name;
}

export interface ScopeInput {
  policy: Pick<Policy, "assetTypes" | "agentTypes" | "historyLayout">;
  /** The package at the branch head and at the branch's first commit, mapped with the layout */
  head: readonly DesiredAsset[];
  base: readonly DesiredAsset[];
  /** The assets at the base commit */
  baseAssets: readonly BaseAssetState[];
  /** The live space's assets (asset_index) */
  live: readonly Pick<LiveIndexEntry, "assetId" | "liveVersion">[];
  /** The package at the branch head mapped against the live space (analyzeImport); with it the scope says what the plan holds */
  analysis?: Pick<Analysis, "desired" | "results"> | null;
}

/**
 * Which assets the revision changed against its base, which of the others
 * changed in the live space after the base, and (with the head's analysis
 * against live) which changed assets the plan holds. Moves are judged by
 * version: an asset whose live version differs from its version at the base,
 * or that is no longer live.
 */
export function revisionScope(input: ScopeInput): RevisionScope {
  const { policy } = input;
  const baseSig = new Map(input.base.map((d) => [assetKeyOf(d), desiredSignature(d)]));
  const baseById = new Map(input.baseAssets.map((b) => [b.assetId, b]));
  const baseIndex = liveIdentityIndex(
    policy,
    input.baseAssets.map((b) => ({ assetId: b.assetId, assetType: b.assetType, name: "", metadata: b.metadata, liveVersion: b.version, committed: null })),
  );
  const liveById = new Map(input.live.map((l) => [l.assetId, l]));

  const baseOf = (d: DesiredAsset): BaseAssetState | undefined => {
    for (const id of [d.assetId, d.sourceAssetId]) {
      const own = id ? baseById.get(id) : undefined;
      if (own && own.assetType === d.assetType) return own;
    }
    const found = baseIndex.get(`${d.assetType}\0${computeIdentity(policy, d) ?? d.key}`);
    return found ? baseById.get(found.assetId) : undefined;
  };
  const movedLive = (b: BaseAssetState): ScopeConflict | null => {
    const l = liveById.get(b.assetId);
    if (!l) return { kind: "deleted-live", baseVersion: b.version };
    return l.liveVersion !== null && l.liveVersion !== b.version ? { kind: "changed-live", baseVersion: b.version, liveVersion: l.liveVersion } : null;
  };

  const changed: ChangedAsset[] = [];
  const leftAlone: LeftAloneAsset[] = [];
  const headKeys = new Set<string>();
  for (const d of input.head) {
    const assetKey = assetKeyOf(d);
    headKeys.add(assetKey);
    const before = baseSig.get(assetKey);
    const b = before === undefined ? undefined : baseOf(d);
    const moved = b ? movedLive(b) : null;
    const label = scopeAssetLabel(policy, d);
    if (before === undefined || before !== desiredSignature(d)) changed.push({ assetKey, label, base: b ?? null, conflict: moved });
    else if (moved) leftAlone.push({ assetKey, label, deleted: moved.kind === "deleted-live" });
  }

  const planned: PlannedAsset[] = [];
  const byKey = new Map(changed.map((c) => [c.assetKey, c]));
  const items = input.analysis?.results.items ?? [];
  items.forEach((item, index) => {
    if (item.action === "unchanged") return;
    const c = byKey.get(item.assetKey);
    // An asset the layout mapping can't pair with the head's is treated as changed, so it stays in the plan.
    if (!c && headKeys.has(item.assetKey)) return;
    const label = c?.label ?? scopeAssetLabel(policy, input.analysis!.desired[index]!);
    const b = c?.base ?? null;
    if (b && item.assetId && b.assetId === item.assetId) {
      planned.push({ index, assetKey: item.assetKey, label, base: { assetId: b.assetId, version: b.version, updatedAt: b.updatedAt }, conflict: c!.conflict });
      return;
    }
    // The live asset this item updates is not the base's: the base's was deleted and another took its name.
    const conflict: ScopeConflict | null = b && item.assetId ? { kind: "changed-live", baseVersion: b.version, liveVersion: liveById.get(item.assetId)?.liveVersion ?? null } : (c?.conflict ?? null);
    planned.push({ index, assetKey: item.assetKey, label, base: null, conflict });
  });

  return {
    changed,
    leftAlone,
    planned,
    unchanged: items.filter((i) => i.action === "unchanged").length,
    untouched: input.analysis?.results.untouched.length ?? 0,
  };
}

/** Every asset at a commit of the history repository, from its asset.json files (no file contents). */
export async function readBaseAssetStates(repo: HistoryRepo, layout: Policy["historyLayout"], spaceAlias: string, commit: string): Promise<BaseAssetState[]> {
  const root = spaceRoot(layout, spaceAlias);
  const jsonPaths = (await repo.listFiles(root, commit)).filter((p) => path.posix.basename(p) === layout.assetJson && p !== path.posix.join(root, layout.assetJson));
  if (!jsonPaths.length) return [];
  const blobs = await repo.readBlobs(commit, jsonPaths);
  const parsed = jsonPaths.map((p) => ({ path: p, dir: path.posix.dirname(p), json: parseAssetJson(blobs.get(p)?.toString("utf8") ?? null) }));
  // An asset.json that is itself a file of another asset (a skill reference named asset.json) is content, not an asset.
  const contentPaths = new Set(parsed.flatMap((x) => (x.json ? x.json.files.map((f) => path.posix.join(x.dir, f.path)) : [])));
  return parsed.flatMap((x) =>
    x.json && !contentPaths.has(x.path) ? [{ assetId: x.json.assetId, assetType: x.json.assetType, metadata: x.json.metadata, version: x.json.serviceVersion, updatedAt: x.json.serviceUpdatedAt }] : [],
  );
}

export interface RevisionScopeRow {
  packageDir: string;
  packageName: string;
  /** The branch's first commit: the package as derived from the base */
  createdCommit: string | null;
  /** The history commit the package was derived from */
  baseCommit: string | null;
}

/**
 * The scope of the revision at `head` (already read by the caller; with its
 * analysis against live, also what a plan holds). Null when the revision has
 * no first commit or base commit recorded, in which case a plan holds the
 * whole package.
 */
export async function loadRevisionScope(args: {
  repo: HistoryRepo;
  policy: Policy;
  layout: PackageLayout;
  spaceAlias: string;
  row: RevisionScopeRow;
  head: PackageContents;
  analysis?: Pick<Analysis, "desired" | "results"> | null;
  live: readonly Pick<LiveIndexEntry, "assetId" | "liveVersion">[];
}): Promise<RevisionScope | null> {
  const { repo, policy, layout, row } = args;
  if (!row.createdCommit || !row.baseCommit) return null;
  const [created, baseAssets] = await Promise.all([
    readRevisionPackage(repo, row.createdCommit, row.packageDir, row.packageName),
    readBaseAssetStates(repo, policy.historyLayout, args.spaceAlias, row.baseCommit),
  ]);
  return revisionScope({
    policy,
    analysis: args.analysis ?? null,
    head: packageToDesiredAssets(args.head, layout, { policy }).assets,
    base: packageToDesiredAssets(created, layout, { policy }).assets,
    baseAssets,
    live: args.live,
  });
}

// ---------- words ----------

/** "v1.2" for a release base; "this revision started" for the live space. */
export function scopeAfter(base: { kind: "live" | "release"; name?: string | null }): string {
  return base.kind === "release" && base.name ? base.name : "this revision started";
}

/** "v4 in v1.2" or "v4 when this revision started". */
function baseVersionText(version: number, base: { kind: "live" | "release"; name?: string | null }): string {
  return base.kind === "release" && base.name ? `v${version} in ${base.name}` : `v${version} when this revision started`;
}

/** The sentence for an asset left as it is live (plan notes say "this plan", the revision page "a plan from this revision"). */
export function leftAloneSentence(a: Pick<LeftAloneAsset, "label">, base: { kind: "live" | "release"; name?: string | null }, subject: string): string {
  return `${a.label} changed in the live space after ${scopeAfter(base)}; ${subject} leaves it as it is.`;
}

/** The sentence for a conflict: the revision changed the asset, and so did the live space. */
export function conflictSentence(a: Pick<PlannedAsset, "label" | "conflict">, base: { kind: "live" | "release"; name?: string | null }, subject: string): string | null {
  const c = a.conflict;
  if (!c) return null;
  const after = scopeAfter(base);
  if (c.kind === "deleted-live") {
    return `${a.label} changed in this revision but was deleted from the live space after ${after}. ${capitalize(subject)} creates it again; discard the plan if it should stay deleted.`;
  }
  const versions = c.liveVersion !== null ? ` (${baseVersionText(c.baseVersion, base)}, v${c.liveVersion} live)` : "";
  return `${a.label} changed in this revision and in the live space after ${after}${versions}. Apply skips it until you compare both versions and re-check the plan.`;
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Sentences for the assets left alone, at most `max`, then one line for the rest. */
export function leftAloneSentences(list: readonly Pick<LeftAloneAsset, "label">[], base: { kind: "live" | "release"; name?: string | null }, subject: string, max: number): string[] {
  const shown = list.slice(0, max).map((a) => leftAloneSentence(a, base, subject));
  const rest = list.length - shown.length;
  if (rest > 0) shown.push(`${rest} more ${rest === 1 ? "asset" : "assets"} changed in the live space after ${scopeAfter(base)}; ${subject} leaves ${rest === 1 ? "it as it is" : "them as they are"}.`);
  return shown;
}
