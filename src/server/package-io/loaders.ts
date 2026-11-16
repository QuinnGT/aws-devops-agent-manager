import { desc, eq } from "drizzle-orm";
import { openSpaceHistoryRepo } from "@/server/assets/repo";
import { db } from "@/server/db/client";
import { packageImports } from "@/server/db/schema";
import { policyForSpace } from "@/server/journals/policy";
import type { FileRole } from "@/server/packages/desired";
import { listLayouts, type PackageLayout } from "@/server/packages/layout";
import type { Policy } from "@/server/policy";
import type { Space } from "@/server/spaces/queries";
import type { ValidationResult } from "@/server/validation/types";
import { validationFailedText } from "./format";
import { listExportRefs, type ExportRef } from "./history";
import { defaultPlanTitle, getImportRow, type PackageImportRow } from "./service";
import {
  FILE_ROLES,
  IMPORT_ACTIONS,
  type ImportAction,
  type ImportCounts,
  type ImportFileEntry,
  type ImportItem,
  type ImportResults,
  type ImportStatus,
  type ImportSummary,
  type LayoutCandidate,
  type LeftOutItem,
  type UntouchedAsset,
} from "./types";

/**
 * Page loaders for the package import and export screens. The page
 * checks the permission first (requireUserOrRedirect, then can(user,
 * PACKAGE_IO_PERMISSIONS.read, space.id)); these only read. Dates are ISO
 * strings so the results can cross into client components.
 */

export interface ImportListItem {
  id: string;
  fileName: string;
  source: "zip" | "folder";
  sha256: string;
  sizeBytes: number;
  layout: string;
  /** Layout label from package-layouts.yaml (the name when the layout is gone) */
  layoutLabel: string;
  packageName: string | null;
  status: ImportStatus;
  ok: boolean;
  counts: ImportCounts;
  planId: string | null;
  importedBy: string;
  createdAt: string;
  expiresAt: string | null;
  /** The stored upload still exists, so a plan can be created from it */
  uploadAvailable: boolean;
}

const emptyCounts: ImportCounts = { create: 0, update: 0, unchanged: 0, untouched: 0, errors: 0, warnings: 0 };

function layoutLabel(policy: Pick<Policy, "packageLayouts">, name: string): string {
  return policy.packageLayouts.layouts[name]?.label ?? name;
}

function toListItem(row: PackageImportRow, policy: Pick<Policy, "packageLayouts">): ImportListItem {
  const summary = row.mappingSummary as ImportSummary | null;
  return {
    id: row.id,
    fileName: row.fileName,
    source: row.source,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    layout: row.layout,
    layoutLabel: layoutLabel(policy, row.layout),
    packageName: row.packageName,
    status: row.status,
    ok: summary?.ok ?? false,
    counts: summary?.counts ?? emptyCounts,
    planId: row.planId,
    importedBy: row.importedBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    uploadAvailable: Boolean(row.storedPath) && !row.fileDeletedAt,
  };
}

/** The space's imports, newest first. */
export async function loadImportList(space: Space, opts: { limit?: number; offset?: number } = {}): Promise<{ imports: ImportListItem[]; hasMore: boolean; pageSize: number }> {
  const { policy } = await policyForSpace(space);
  const pageSize = Math.min(Math.max(opts.limit ?? policy.packageIo.import.listPageSize, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const rows = await db()
    .select()
    .from(packageImports)
    .where(eq(packageImports.spaceId, space.id))
    .orderBy(desc(packageImports.createdAt), desc(packageImports.id))
    .limit(pageSize + 1)
    .offset(offset);
  return { imports: rows.slice(0, pageSize).map((r) => toListItem(r, policy)), hasMore: rows.length > pageSize, pageSize };
}

export interface ImportItemGroup {
  assetType: string;
  /** Asset type label from asset-types.yaml */
  label: string;
  counts: Record<ImportAction, number>;
  items: ImportItem[];
}

export interface ImportFileGroup {
  role: FileRole;
  files: ImportFileEntry[];
}

export interface UntouchedGroup {
  assetType: string;
  label: string;
  assets: UntouchedAsset[];
}

export interface ImportDetail {
  import: ImportListItem & { analyzedAt: string | null; plannedAt: string | null; plannedBy: string | null; historyCommit: string | null };
  summary: ImportSummary | null;
  /** The mapping table, grouped by asset type in asset-types.yaml order */
  groups: ImportItemGroup[];
  /** File roles, grouped in the order asset, build-artifact, manifest, non-asset, skipped, unmapped */
  files: ImportFileGroup[];
  validation: { errors: ValidationResult[]; warnings: ValidationResult[] };
  /** Live assets the package doesn't mention (left alone; import never deletes) */
  untouched: UntouchedGroup[];
  /**
   * Whether the import's state allows "Create plan" (the page still checks
   * PACKAGE_IO_PERMISSIONS.plan). `reason` says why not, in plain words.
   * `defaultTitle` is the policy's plan title for this import.
   */
  plan: { planId: string | null; canCreate: boolean; reason: string | null; defaultTitle: string };
  /** Assets with at least one validation error */
  failedAssets: number;
  /** The import's layout, for folder names on the page; null when the layout is no longer in policy */
  layout: ImportLayoutInfo | null;
  /** Package assets that are not planned, with the reason (duplicates; types left out when the plan was made) */
  leftOut: LeftOutItem[];
  /**
   * Layout detection: every layout's fit, best first, whether the import's
   * layout was detected or chosen, and whether it can still change (no plan
   * yet, the upload still stored).
   */
  layouts: { candidates: LayoutCandidate[]; choice: "detected" | "chosen" | null; canChange: boolean };
  /**
   * The asset types the plan can include, in asset-types.yaml order, with
   * their changes and the validation errors about them. `unattributedErrors`
   * are errors about no type (the whole package): they block any selection
   * while `blockOnErrors`. `stateReason` is why no plan can be made whatever
   * the selection (planned, rejected, deleted upload), or null.
   */
  planTypes: { types: PlanTypeOption[]; unattributedErrors: number; blockOnErrors: boolean; stateReason: string | null };
}

export interface PlanTypeOption {
  assetType: string;
  /** "Skills", "Memory stores" */
  label: string;
  /** Count noun for one and several ("skill", "skills") */
  nounOne: string;
  nounOther: string;
  assets: number;
  /** Create and update items */
  changes: number;
  /** Items that already match live */
  unchanged?: number;
  /** Package assets of the type left out anyway (duplicates, can't be created here) */
  leftOut?: number;
  /** Assets of the type with validation errors, and the errors and warnings about the type */
  failedAssets: number;
  errors: number;
  warnings?: number;
}

export interface ImportLayoutInfo {
  name: string;
  label: string;
  /** Package folder per asset type ("instructions", "skills", "memory") */
  typeDirs: Record<string, string>;
  /** The layout's non-asset patterns ("README.md", "evaluation/**") */
  nonAssets: string[];
  manifest: string | null;
}

/** Package folder per asset type in a layout. Pure. */
export function layoutTypeDirs(layout: Pick<PackageLayout, "instructions" | "skills" | "memory" | "customAgents"> & Partial<Pick<PackageLayout, "assetFolders">>): Record<string, string> {
  const dirs: Record<string, string> = {};
  if (layout.instructions) dirs.agents_md = layout.instructions.dir;
  if (layout.skills) dirs.skill = layout.skills.dir;
  for (const [t, rule] of Object.entries(layout.assetFolders?.types ?? {})) dirs[t] = rule.dir;
  if (layout.memory) {
    dirs.memory_store = layout.memory.dir;
    dirs.memory = layout.memory.dir;
  }
  if (layout.customAgents) dirs.custom_agent = layout.customAgents.dir;
  return dirs;
}

/**
 * The asset types a validation result is about: its asset's type, the type
 * of the asset its file belongs to, or the types whose folder holds its path.
 * Empty: the result is about the whole package. Same rule as checkPackage's
 * type selection.
 */
export function resultTypes(r: ValidationResult, files: readonly Pick<ImportFileEntry, "path" | "assetKey">[], typeDirs: Record<string, string>): string[] {
  const typeOf = (assetKey: string) => assetKey.slice(0, assetKey.indexOf(":"));
  if (r.assetKey) return [typeOf(r.assetKey)];
  if (!r.path) return [];
  const owner = files.find((f) => f.path === r.path)?.assetKey;
  if (owner) return [typeOf(owner)];
  return Object.entries(typeDirs)
    .filter(([, dir]) => r.path === dir || r.path!.startsWith(`${dir}/`))
    .map(([t]) => t);
}

function planTypeOptions(
  policy: Pick<Policy, "assetTypes">,
  groups: readonly ImportItemGroup[],
  results: Pick<ImportResults, "validation" | "files" | "leftOut">,
  typeDirs: Record<string, string>,
): { types: PlanTypeOption[]; unattributedErrors: number } {
  const errorsByType = new Map<string, number>();
  const warningsByType = new Map<string, number>();
  const failedByType = new Map<string, Set<string>>();
  let unattributedErrors = 0;
  for (const r of results.validation) {
    const types = resultTypes(r, results.files, typeDirs);
    if (r.level !== "error") {
      for (const t of types) warningsByType.set(t, (warningsByType.get(t) ?? 0) + 1);
      continue;
    }
    if (!types.length) unattributedErrors++;
    for (const t of types) {
      errorsByType.set(t, (errorsByType.get(t) ?? 0) + 1);
      if (r.assetKey) failedByType.set(t, (failedByType.get(t) ?? new Set()).add(r.assetKey));
    }
  }
  const present = new Map(groups.map((g) => [g.assetType, g]));
  // Types the stored mapping left out by choice are still offered.
  for (const l of results.leftOut ?? []) if (l.reason === "type-not-selected" && !present.has(l.assetType)) present.set(l.assetType, { assetType: l.assetType, label: typeLabel(policy, l.assetType), counts: { create: 0, update: 0, unchanged: 0 }, items: [] });
  const noun = (t: string, n: number) => {
    const e = policy.assetTypes.assetTypes[t];
    const one = e?.noun?.one ?? (e?.label ?? t).toLowerCase();
    return n === 1 ? one : (e?.noun?.other ?? `${one}s`);
  };
  const types = byTypeOrder(policy, [...present.values()]).map((g) => {
    const other = noun(g.assetType, 2);
    return {
      assetType: g.assetType,
      label: other.charAt(0).toUpperCase() + other.slice(1),
      nounOne: noun(g.assetType, 1),
      nounOther: other,
      assets: g.items.length,
      changes: g.counts.create + g.counts.update,
      unchanged: g.counts.unchanged,
      leftOut: (results.leftOut ?? []).filter((l) => l.assetType === g.assetType && l.reason !== "type-not-selected").length,
      failedAssets: failedByType.get(g.assetType)?.size ?? 0,
      errors: errorsByType.get(g.assetType) ?? 0,
      warnings: warningsByType.get(g.assetType) ?? 0,
    };
  });
  return { types, unattributedErrors };
}

/** "14 assets have validation errors (22 errors in all)", or the error count when no error names an asset (format.ts). */
export { validationFailedText } from "./format";

function typeLabel(policy: Pick<Policy, "assetTypes">, assetType: string): string {
  return policy.assetTypes.assetTypes[assetType]?.label ?? assetType;
}

function byTypeOrder<T extends { assetType: string }>(policy: Pick<Policy, "assetTypes">, groups: T[]): T[] {
  const order = Object.keys(policy.assetTypes.assetTypes);
  const rank = (t: string) => (order.includes(t) ? order.indexOf(t) : order.length);
  return groups.sort((a, b) => rank(a.assetType) - rank(b.assetType) || a.assetType.localeCompare(b.assetType));
}

/** Shape stored results for the detail page. Pure; exported for tests. */
export function buildImportDetail(row: PackageImportRow, policy: Pick<Policy, "assetTypes" | "packageLayouts" | "packageIo">, space: { alias: string } = { alias: "" }): ImportDetail {
  const summary = row.mappingSummary as ImportSummary | null;
  const results = (row.results as ImportResults | null) ?? { items: [], files: [], untouched: [], validation: [], historyCommit: null, analyzedAt: "" };

  const itemGroups = new Map<string, ImportItemGroup>();
  for (const item of results.items) {
    let g = itemGroups.get(item.assetType);
    if (!g) {
      g = { assetType: item.assetType, label: typeLabel(policy, item.assetType), counts: Object.fromEntries(IMPORT_ACTIONS.map((a) => [a, 0])) as Record<ImportAction, number>, items: [] };
      itemGroups.set(item.assetType, g);
    }
    g.items.push(item);
    g.counts[item.action]++;
  }

  const files = FILE_ROLES.map((role) => ({ role, files: results.files.filter((f) => f.role === role) })).filter((g) => g.files.length > 0);

  const untouchedGroups = new Map<string, UntouchedGroup>();
  for (const a of results.untouched) {
    let g = untouchedGroups.get(a.assetType);
    if (!g) {
      g = { assetType: a.assetType, label: typeLabel(policy, a.assetType), assets: [] };
      untouchedGroups.set(a.assetType, g);
    }
    g.assets.push(a);
  }

  const base = toListItem(row, policy);
  const layout = policy.packageLayouts.layouts[row.layout];
  const failedAssets = new Set(results.validation.filter((r) => r.level === "error" && r.assetKey).map((r) => r.assetKey)).size;
  const typeDirs = layout ? layoutTypeDirs(layout) : {};
  const groups = byTypeOrder(policy, [...itemGroups.values()]);
  const state = planState(row, summary, policy, base.uploadAvailable, failedAssets);
  const stateReason = state.canCreate || state.validation ? null : state.reason;
  const options = planTypeOptions(policy, groups, results, typeDirs);
  return {
    import: {
      ...base,
      analyzedAt: row.analyzedAt?.toISOString() ?? null,
      plannedAt: row.plannedAt?.toISOString() ?? null,
      plannedBy: row.plannedBy,
      historyCommit: results.historyCommit,
    },
    summary,
    groups,
    files,
    validation: {
      errors: results.validation.filter((r) => r.level === "error"),
      warnings: results.validation.filter((r) => r.level === "warning"),
    },
    untouched: byTypeOrder(policy, [...untouchedGroups.values()]),
    plan: { planId: row.planId, canCreate: state.canCreate, reason: state.reason, defaultTitle: defaultPlanTitle(policy, row, space) },
    failedAssets,
    layout: layout ? { name: row.layout, label: layout.label, typeDirs, nonAssets: [...layout.nonAssets], manifest: layout.manifest } : null,
    leftOut: results.leftOut ?? [],
    layouts: {
      candidates: results.layouts ?? [],
      choice: results.layoutChoice ?? null,
      canChange: (row.status === "analyzed" || row.status === "failed") && base.uploadAvailable,
    },
    planTypes: { ...options, blockOnErrors: policy.packageIo.import.blockPlanOnErrors, stateReason },
  };
}

/**
 * Whether the whole package can become a plan. `validation` marks a refusal
 * that only validation errors cause, which a type selection may avoid.
 */
function planState(
  row: PackageImportRow,
  summary: ImportSummary | null,
  policy: Pick<Policy, "packageIo">,
  uploadAvailable: boolean,
  failedAssets: number,
): { canCreate: boolean; reason: string | null; validation?: boolean } {
  const no = (reason: string) => ({ canCreate: false, reason });
  if (row.status === "planned") return no("A plan was already created from this import.");
  if (row.status === "planning") return no("A plan is being created from this import.");
  if (row.status === "rejected") return no("The upload was rejected. Fix the package and upload it again.");
  if (!uploadAvailable) return no("The uploaded package was deleted after its retention period. Upload it again.");
  if (row.status === "analyzed" && summary) {
    if (policy.packageIo.import.blockPlanOnErrors && !summary.ok) return { ...no(`${validationFailedText(failedAssets, summary.counts.errors)}. Fix the package and upload it again.`), validation: true };
    if (summary.counts.create + summary.counts.update === 0) return no("Nothing to import: every asset in the package matches live.");
  }
  return { canCreate: true, reason: null };
}

/** One import of the space with its mapping, or null when there is no such import in this space. */
export async function loadImportDetail(space: Space, importId: string): Promise<ImportDetail | null> {
  const row = await getImportRow(space.id, importId);
  if (!row) return null;
  const { policy } = await policyForSpace(space);
  return buildImportDetail(row, policy, space);
}

export interface ExportOptions {
  layouts: { name: string; label: string; isDefault: boolean }[];
  defaultLayout: string | null;
  /** Null when the space has no history repository working copy (`repo` says why) */
  refs: { head: ExportRef | null; releases: ExportRef[]; commits: ExportRef[] } | null;
  repo: { ok: true } | { ok: false; reason: "no-repo" | "not-cloned"; message: string };
}

/** Layouts and export points (HEAD, release tags, recent commits) for the export form. */
export async function loadExportOptions(space: Space): Promise<ExportOptions> {
  const { policy } = await policyForSpace(space);
  const layouts = listLayouts(policy);
  const defaultLayout = policy.packageLayouts.defaultLayout ?? null;
  const repo = await openSpaceHistoryRepo(space, policy.historyLayout);
  if (!repo.ok) return { layouts, defaultLayout, refs: null, repo: { ok: false, reason: repo.reason, message: repo.message } };
  const refs = await listExportRefs(repo.repo, policy.historyLayout, space.alias, policy.packageIo.export.recentCommits);
  return { layouts, defaultLayout, refs, repo: { ok: true } };
}
