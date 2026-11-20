import path from "node:path";
import { missingRoleReason } from "@/server/auth/role-words";
import type { LinkableFinding } from "@/server/audits/contract";
import { listLinkableFindings } from "@/server/audits/linkable";
import type { HistoryRepo, PathChange } from "@/server/git/history-repo";
import { policyForSpace } from "@/server/journals/policy";
import { packageToDesiredAssets, type FileRole } from "@/server/packages/desired";
import { pathProblem, sortPaths } from "@/server/packages/paths";
import type { Permission, Policy } from "@/server/policy";
import type { Space } from "@/server/spaces/queries";
import { renderChangelogSection } from "./changelog";
import { layoutOf, readContext } from "./context";
import { revisionNameKey } from "./names";
import { fileView, readRevisionPackage } from "./package-files";
import { existingReleaseIds, findingsForChangelog, findingStates, getRevision, getRevisionByNameKey, isUuid, listChanges, listChangesOf, listRevisionRows, planStates, type PlanStateRow, type RevisionChangeRow, type RevisionRow } from "./queries";
import { REVISION_PERMISSIONS } from "./service";
import { exportBlocker, OPEN_PLAN_STATES, planBlocker, saveBlocker } from "./states";
import { acceptedOnList } from "./to-address";
import type { RevisionBuild, RevisionError } from "./types";

/**
 * Loaders for the revision pages. The page checks `audits.read`
 * (REVISION_PERMISSIONS.read) for the space first and passes the viewer's
 * permissions and role, so the detail can say why an action is unavailable.
 * Reads only: Postgres and the history repository through git.
 */

export interface RevisionViewer {
  permissions: ReadonlySet<Permission> | readonly Permission[];
  /** The viewer's role in the space, for "Only Publishers and Admins can ..." */
  role?: string | null;
}

export interface BuildSummary {
  status: RevisionBuild["status"];
  errors: number;
  warnings: number;
  ranAt: string;
  /** False when the stored build is for an older commit than the branch head */
  current: boolean;
}

export interface PlanLink {
  planId: string;
  state: string;
  title: string;
  /** The plan was made from an earlier save than the branch head */
  outOfDate: boolean;
  /** The plan's last live-space check failed (its badge says "Check failed", not "Ready") */
  checkFailed: boolean;
  /** The plan has a validation error (its badge says "Validation failed") */
  validationFailed: boolean;
}

export interface ReleaseLink {
  releaseId: string | null;
  name: string;
  /** The release job finished and the release exists */
  created: boolean;
  runId: string | null;
  error: string | null;
}

export interface RevisionListItem {
  id: string;
  name: string;
  state: RevisionRow["state"];
  /** releaseName: the release a "release" base starts from */
  base: { kind: RevisionRow["baseKind"]; label: string; releaseName?: string | null };
  layout: string;
  /** Distinct findings linked by its changes */
  linkedFindings: number;
  /** Findings sent to it from an audit that are accepted now and not linked yet */
  toAddress: number;
  changes: number;
  lastBuild: BuildSummary | null;
  plan: PlanLink | null;
  release: ReleaseLink | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

function buildSummary(row: RevisionRow): BuildSummary | null {
  const b = row.latestBuild;
  return b ? { status: b.status, errors: b.errors, warnings: b.warnings, ranAt: b.ranAt, current: Boolean(row.headCommit && b.commit === row.headCommit) } : null;
}

function planLink(row: RevisionRow, plans: Map<string, Pick<PlanStateRow, "state" | "title" | "checkFailed" | "validationFailed">>): PlanLink | null {
  if (!row.planId) return null;
  const p = plans.get(row.planId);
  return {
    planId: row.planId,
    state: p?.state ?? "unknown",
    title: p?.title ?? "",
    outOfDate: Boolean(row.plannedCommit && row.headCommit && row.plannedCommit !== row.headCommit),
    checkFailed: p?.checkFailed ?? false,
    validationFailed: p?.validationFailed ?? false,
  };
}

function releaseLink(row: RevisionRow, created: Set<string>): ReleaseLink | null {
  if (!row.releaseName && !row.releaseId) return null;
  return { releaseId: row.releaseId, name: row.releaseName ?? "", created: Boolean(row.releaseId && created.has(row.releaseId)), runId: row.releaseRunId, error: row.releaseError };
}

function listItem(row: RevisionRow, changes: readonly RevisionChangeRow[], plans: Map<string, PlanStateRow>, created: Set<string>, findingStatesById: ReadonlyMap<string, string>): RevisionListItem {
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    base: { kind: row.baseKind, label: row.base.label, releaseName: row.base.kind === "release" ? row.base.name : null },
    layout: row.layout,
    linkedFindings: new Set(changes.flatMap((c) => c.findingIds)).size,
    toAddress: acceptedOnList(row.toAddressFindingIds, findingStatesById),
    changes: changes.length,
    lastBuild: buildSummary(row),
    plan: planLink(row, plans),
    release: releaseLink(row, created),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The revisions list: newest first, one page. */
export async function loadRevisionList(space: Space, opts: { limit?: number; offset?: number } = {}): Promise<{ revisions: RevisionListItem[]; hasMore: boolean; pageSize: number }> {
  const { policy } = await policyForSpace(space);
  const pageSize = Math.min(Math.max(1, opts.limit ?? policy.revisions.pages.listPageSize), 500);
  const rows = await listRevisionRows(space.id, { limit: pageSize + 1, offset: Math.max(0, opts.offset ?? 0) });
  const page = rows.slice(0, pageSize);
  const changes = await listChangesOf(page.map((r) => r.id));
  const plans = await planStates(page.map((r) => r.planId).filter((x): x is string => Boolean(x)));
  const created = await existingReleaseIds(page.map((r) => r.releaseId));
  const states = await findingStates(space.id, page.flatMap((r) => r.toAddressFindingIds));
  return {
    revisions: page.map((r) =>
      listItem(
        r,
        changes.filter((c) => c.revisionId === r.id),
        plans,
        created,
        states,
      ),
    ),
    hasMore: rows.length > pageSize,
    pageSize,
  };
}

export interface TreeFile {
  /** Package-relative path */
  path: string;
  size: number;
  role: FileRole | null;
  /** The asset the file belongs to (`${assetType}:${key}`) */
  assetKey: string | null;
  /** Written by the build (indexes, skill zips, validation summary) rather than by a person */
  builtByLastSave: boolean;
}

export interface LinkedFindingView {
  id: string;
  title: string;
  auditId: string;
  auditName: string;
  incidentId: string | null;
  kind: string;
  /** Current state of the finding; a change keeps its link if the finding is later rejected */
  state: string;
  /** Changes that link it */
  changes: number;
}

export interface RevisionChangeView {
  id: string;
  message: string;
  commit: string;
  author: string;
  authorName: string | null;
  createdAt: Date;
  changedPaths: string[];
  buildPaths: string[];
  findingIds: string[];
  unlinkedReason: string | null;
  buildStatus: "passed" | "failed";
  /** The branch head the save was committed on */
  parentCommit?: string | null;
}

export interface ActionState {
  available: boolean;
  /** Why not, in plain words; null when available */
  reason: string | null;
}

export interface RevisionDetail {
  revision: RevisionListItem & {
    branch: string;
    packageDir: string;
    packageName: string;
    layoutLabel: string;
    baseCommit: string | null;
    createdCommit: string | null;
    headCommit: string | null;
    note: string | null;
    stateReason: string | null;
    abandonedBy: string | null;
    abandonedAt: Date | null;
    /** The release the revision starts from (base kind "release") */
    baseRelease?: { id: string; name: string } | null;
    /** Every finding on the to-address list, in the order they were added (accepted or not; the pages say which) */
    toAddressIds: string[];
  };
  repo: { ok: true } | { ok: false; message: string };
  /** Every file of the package at the branch head */
  tree: TreeFile[];
  /** The requested file at the head, or null */
  file: { path: string; view: ReturnType<typeof fileView> } | null;
  findings: LinkedFindingView[];
  build: RevisionBuild | null;
  /** The change record as the next save would write it (markdown; render with SafeMarkdown) */
  changelog: string;
  /** Against the base: from the branch's first commit to its head */
  diff: { from: string | null; to: string | null; files: PathChange[]; text: string | null; truncated: boolean };
  /** Newest first */
  changes: RevisionChangeView[];
  plan: PlanLink | null;
  release: ReleaseLink | null;
  actions: { save: ActionState; createPlan: ActionState; export: ActionState; abandon: ActionState };
}

function allowed(viewer: RevisionViewer | undefined, p: Permission): boolean {
  if (!viewer) return true;
  const perms = viewer.permissions;
  return perms instanceof Set ? perms.has(p) : (perms as readonly Permission[]).includes(p);
}

function action(policy: Pick<Policy, "roles">, viewer: RevisionViewer | undefined, permission: Permission, verb: string, blocker: string | null): ActionState {
  if (!allowed(viewer, permission)) return { available: false, reason: missingRoleReason(policy, viewer?.role ?? null, permission, verb) };
  return blocker ? { available: false, reason: blocker } : { available: true, reason: null };
}

/** The revision by ID or by name (the page URL uses the name). */
async function findRevision(space: Space, policy: Pick<Policy, "revisions">, idOrName: string): Promise<RevisionRow | null> {
  if (isUuid(idOrName)) {
    const byId = await getRevision(space.id, idOrName);
    if (byId) return byId;
  }
  return getRevisionByNameKey(space.id, revisionNameKey(policy, idOrName));
}

async function packageDiff(repo: HistoryRepo, row: RevisionRow, maxBytes: number, diffPath: string | null): Promise<RevisionDetail["diff"]> {
  const from = row.createdCommit;
  const to = row.headCommit;
  if (!from || !to) return { from, to, files: [], text: null, truncated: false };
  const prefix = `${row.packageDir}/`;
  const files = (await repo.diffNameStatus(from, to, row.packageDir))
    .filter((c) => c.path.startsWith(prefix))
    .map((c) => ({ ...c, path: c.path.slice(prefix.length) }));
  if (from === to) return { from, to, files, text: null, truncated: false };
  const target = diffPath && pathProblem(diffPath) === null ? path.posix.join(row.packageDir, diffPath) : row.packageDir;
  let text = await repo.diff(from, to, target);
  let truncated = false;
  if (Buffer.byteLength(text) > maxBytes) {
    text = Buffer.from(text).subarray(0, maxBytes).toString("utf8");
    truncated = true;
  }
  return { from, to, files, text, truncated };
}

/**
 * The revision detail: summary, file tree and one file at the head, linked
 * findings, build and validation results, change record preview, diff
 * against the base, plan and release links, and why each action is
 * unavailable. Null when there is no such revision in the space.
 */
export async function loadRevisionDetail(
  space: Space,
  idOrName: string,
  viewer?: RevisionViewer,
  opts: { path?: string | null; diffPath?: string | null } = {},
): Promise<RevisionDetail | null> {
  const loaded = await policyForSpace(space);
  const policy = loaded.policy;
  const row = await findRevision(space, policy, idOrName);
  if (!row) return null;
  const changes = await listChanges(row.id);
  const plans = await planStates(row.planId ? [row.planId] : []);
  const created = await existingReleaseIds([row.releaseId]);
  const item = listItem(row, changes, plans, created, await findingStates(space.id, row.toAddressFindingIds));
  let layoutLabel = row.layout;
  try {
    layoutLabel = layoutOf(policy, row.layout).label;
  } catch {
    // An unknown layout keeps its name.
  }

  const findingRows = await findingsForChangelog(space.id, changes.flatMap((c) => c.findingIds));
  const findingMap = new Map(findingRows.map((f) => [f.id, f]));
  const findings: LinkedFindingView[] = findingRows.map((f) => ({
    id: f.id,
    title: f.title,
    auditId: f.auditId,
    auditName: f.auditName,
    incidentId: f.incidentId,
    kind: f.kind,
    state: f.state,
    changes: changes.filter((c) => c.findingIds.includes(f.id)).length,
  }));
  const changelog = renderChangelogSection(policy.revisions.changelog, {
    name: row.name,
    baseLabel: row.base.label,
    changes: changes.map((c) => ({ message: c.message, changedPaths: c.changedPaths, findingIds: c.findingIds, unlinkedReason: c.unlinkedReason, createdAt: c.createdAt })),
    findings: findingMap,
  });

  let repoState: RevisionDetail["repo"] = { ok: true };
  let tree: TreeFile[] = [];
  let file: RevisionDetail["file"] = null;
  let diff: RevisionDetail["diff"] = { from: row.createdCommit, to: row.headCommit, files: [], text: null, truncated: false };
  try {
    const { repo } = await readContext(space);
    if (row.headCommit) {
      const contents = await readRevisionPackage(repo, row.headCommit, row.packageDir, row.packageName);
      let roles = new Map<string, { role: FileRole; assetKey?: string }>();
      try {
        roles = packageToDesiredAssets(contents, layoutOf(policy, row.layout), { policy }).roles;
      } catch {
        // Roles are display only.
      }
      const built = new Set(changes.at(-1)?.buildPaths ?? row.latestBuild?.buildPaths ?? []);
      tree = sortPaths(contents.files.keys()).map((p) => ({ path: p, size: contents.files.get(p)!.length, role: roles.get(p)?.role ?? null, assetKey: roles.get(p)?.assetKey ?? null, builtByLastSave: built.has(p) }));
      if (opts.path && contents.files.has(opts.path)) file = { path: opts.path, view: fileView(contents.files.get(opts.path), policy.revisions.pages.maxFileBytes) };
      diff = await packageDiff(repo, row, policy.revisions.pages.maxDiffBytes, opts.diffPath ?? null);
    }
  } catch (err) {
    repoState = { ok: false, message: (err as RevisionError).message ?? "The history repository can't be read." };
  }

  const plan = row.planId ? (plans.get(row.planId) ?? null) : null;
  const build = REVISION_PERMISSIONS.build;
  return {
    revision: {
      ...item,
      branch: row.branch,
      packageDir: row.packageDir,
      packageName: row.packageName,
      layoutLabel,
      baseCommit: row.baseCommit,
      createdCommit: row.createdCommit,
      headCommit: row.headCommit,
      note: row.note,
      stateReason: row.stateReason,
      abandonedBy: row.abandonedBy,
      abandonedAt: row.abandonedAt,
      baseRelease: row.base.kind === "release" ? { id: row.base.releaseId, name: row.base.name } : null,
      toAddressIds: row.toAddressFindingIds,
    },
    repo: repoState,
    tree,
    file,
    findings,
    build: row.latestBuild ?? null,
    changelog,
    diff,
    changes: [...changes].reverse().map((c) => ({
      id: c.id,
      message: c.message,
      commit: c.commit,
      author: c.author,
      authorName: c.authorName,
      createdAt: c.createdAt,
      changedPaths: c.changedPaths,
      buildPaths: c.buildPaths,
      findingIds: c.findingIds,
      unlinkedReason: c.unlinkedReason,
      buildStatus: c.buildStatus,
      parentCommit: c.parentCommit,
    })),
    plan: item.plan,
    release: item.release,
    actions: {
      save: action(policy, viewer, build, "edit revisions", saveBlocker(row)),
      createPlan: action(policy, viewer, REVISION_PERMISSIONS.plan, "create plans", planBlocker(row, plan)),
      export: action(policy, viewer, REVISION_PERMISSIONS.export, "download revisions", exportBlocker(row, policy.revisions)),
      abandon: action(
        policy,
        viewer,
        build,
        "abandon revisions",
        row.state !== "open" && row.state !== "failed" ? `The revision is ${row.state}.` : plan?.state === "applying" ? "A plan from this revision is applying." : null,
      ),
    },
  };
}

/** Findings a save may link: accepted, linkable, of this space (for the save form's picker). */
export async function loadLinkableFindings(space: Space, opts: { auditId?: string; limit?: number } = {}): Promise<LinkableFinding[]> {
  return listLinkableFindings(space.id, { auditId: opts.auditId && isUuid(opts.auditId) ? opts.auditId : undefined, limit: opts.limit });
}

/** True while some plan from the revision is still open. */
export function hasOpenPlan(plan: { state: string } | null): boolean {
  return Boolean(plan && (OPEN_PLAN_STATES as readonly string[]).includes(plan.state));
}

