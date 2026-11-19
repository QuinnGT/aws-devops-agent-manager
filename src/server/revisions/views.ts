import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { diffText, type FileDiff } from "@/server/assets/diff";
import { audits, findings as findingsTable, jobRuns, revisions } from "@/server/db/schema";
import { db } from "@/server/db/client";
import type { HistoryRepo } from "@/server/git/history-repo";
import { listIndexedAssets } from "@/server/assets/queries";
import { fieldLabel, fieldValueLabel } from "@/server/audits/loaders";
import { listLinkableFindings } from "@/server/audits/linkable";
import { policyForSpace } from "@/server/journals/policy";
import type { PackageLayout } from "@/server/packages/layout";
import { pathProblem } from "@/server/packages/paths";
import { isText } from "@/server/packages/text";
import type { Policy } from "@/server/policy";
import type { AuditProfile } from "@/server/policy/sections/audits";
import type { Space } from "@/server/spaces/queries";
import type { ValidationResult } from "@/server/validation/types";
import { layoutOf, readContext } from "./context";
import { loadRevisionDetail, type RevisionDetail, type RevisionViewer, type TreeFile } from "./loaders";
import { fileView, readRevisionPackage } from "./package-files";
import { MAX_LEFT_ALONE_NOTES } from "./plan-input";
import { conflictSentence, leftAloneSentences, loadRevisionScope, scopeAfter } from "./scope";
import { revisionNameKey } from "./names";
import { findingsForChangelog, findingsForToAddress, getRevision, getRevisionByNameKey, isUuid, type ToAddressRow } from "./queries";

/**
 * What the revision pages add to loadRevisionDetail: per-file marks
 * for the tree (edited against the base, build errors, built by the
 * package), the diff against the base and each save's diff as line diffs
 * with +/− counts, the finding picker of the save dialog with each finding's
 * cited records, and one file read for the editor. Reads only (Postgres and
 * the history repository through git). The pure helpers are unit-tested.
 */

// ---------- pure helpers ----------

/**
 * Why a file is read only in the editor: written by the build or the change
 * record, never by a person. An asset folder's descriptor (`_asset.json` in
 * the Agent Space folder layout) has the manifest role but is the asset's
 * metadata, so it stays editable.
 */
export function isGeneratedFile(file: Pick<TreeFile, "path" | "role">, opts: { changelogPath: string | null; validationPath: string | null; descriptor?: string | null }): boolean {
  if (opts.descriptor && file.role === "manifest" && file.path.split("/").pop() === opts.descriptor) return false;
  return file.role === "build-artifact" || file.role === "manifest" || file.path === opts.changelogPath || file.path === opts.validationPath;
}

/**
 * The package file a validation result is about: its path when the package
 * has it, else the path inside the asset it names, else the asset's main
 * file (the shortest path of the asset's own files). Null when the result
 * names no file of the package.
 */
export function resultFile(r: Pick<ValidationResult, "path" | "assetKey">, tree: readonly Pick<TreeFile, "path" | "role" | "assetKey">[]): string | null {
  if (r.path && tree.some((f) => f.path === r.path)) return r.path;
  const own = r.assetKey ? tree.filter((f) => f.assetKey === r.assetKey && f.role === "asset") : [];
  if (r.path) {
    const inside = own.find((f) => f.path.endsWith(`/${r.path}`));
    if (inside) return inside.path;
  }
  if (!own.length) return null;
  return [...own].sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.length - b.path.length || a.path.localeCompare(b.path))[0]!.path;
}

/** Error count per package path, from the build's results. */
export function errorsByFile(results: readonly ValidationResult[], tree: readonly Pick<TreeFile, "path" | "role" | "assetKey">[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of results) {
    if (r.level !== "error") continue;
    const p = resultFile(r, tree);
    if (p) out.set(p, (out.get(p) ?? 0) + 1);
  }
  return out;
}

export interface PackageFolder {
  /** Top folder name, or null for files at the package root */
  name: string | null;
  /** Package paths, sorted */
  files: string[];
}

/**
 * The package's files grouped by top folder: root files first, then the
 * layout's folders in its order (instructions, skills, memory, then the
 * non-asset folders it lists), then any other folder by name.
 */
export function packageFolders(paths: readonly string[], layout: Pick<PackageLayout, "instructions" | "skills" | "memory" | "nonAssets">): PackageFolder[] {
  const order: string[] = [];
  const add = (d: string | undefined | null) => {
    const top = d?.split("/")[0];
    if (top && !top.includes("*") && !order.includes(top)) order.push(top);
  };
  add(layout.instructions?.dir);
  add(layout.skills?.dir);
  add(layout.memory?.dir);
  for (const g of layout.nonAssets ?? []) if (g.includes("/")) add(g);
  const groups = new Map<string | null, string[]>();
  for (const p of paths) {
    const i = p.indexOf("/");
    const key = i < 0 ? null : p.slice(0, i);
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const rank = (k: string | null) => (k === null ? -1 : order.includes(k) ? order.indexOf(k) : order.length);
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || (a ?? "").localeCompare(b ?? ""))
    .map(([name, files]) => ({ name, files: [...files].sort((x, y) => x.localeCompare(y)) }));
}

/** "14 skill zips and 5 memory indexes rebuilt, shared sections copied", from the package files. */
export function rebuiltLine(paths: readonly string[], layout: Pick<PackageLayout, "skills" | "memory" | "sharedSections">): string | null {
  const skillsDir = layout.skills?.dir ? `${layout.skills.dir}/` : null;
  const memoryDir = layout.memory?.dir ? `${layout.memory.dir}/` : null;
  const indexFile = layout.memory?.indexFile ?? null;
  const zips = skillsDir ? paths.filter((p) => p.startsWith(skillsDir) && p.endsWith(".zip")).length : 0;
  const indexes = memoryDir && indexFile ? paths.filter((p) => p.startsWith(memoryDir) && path.posix.basename(p) === indexFile).length : 0;
  const parts: string[] = [];
  if (zips) parts.push(`${zips} skill ${zips === 1 ? "zip" : "zips"}`);
  if (indexes) parts.push(`${indexes} memory ${indexes === 1 ? "index" : "indexes"}`);
  const built = parts.length ? `${parts.join(" and ")} rebuilt` : null;
  const shared = (layout.sharedSections?.length ?? 0) > 0 ? "shared sections copied" : null;
  if (built && shared) return `${built}, ${shared}`;
  return built ?? (shared ? `Shared sections copied` : null);
}

/** Record numbers a finding's citations confirm, in order, without repeats ("R114, R121"). */
export function citedRecords(citations: readonly { record: number; ok: boolean }[], max = 5): number[] {
  const out: number[] = [];
  for (const c of citations) if (c.ok && !out.includes(c.record)) out.push(c.record);
  return out.slice(0, max);
}

/** Line diff of one file between two versions; binary, unreadable and too-large files get a reason instead of lines. */
export function fileDiffOf(p: string, before: Buffer | null | undefined, after: Buffer | null | undefined, maxFileBytes: number): FileDiff {
  const base = { path: p, beforeSha: null, afterSha: null, hunks: [] as FileDiff["hunks"], added: 0, removed: 0 };
  const a = before ?? null;
  const b = after ?? null;
  if (!a && !b) return { ...base, status: "unchanged" };
  const status: FileDiff["status"] = !a ? "added" : !b ? "removed" : "modified";
  if (a && b && a.equals(b)) return { ...base, status: "unchanged" };
  if ((a && !isText(a)) || (b && !isText(b))) return { ...base, status: a && b ? "not-comparable" : status, reason: "Binary content" };
  if ((a?.length ?? 0) > maxFileBytes || (b?.length ?? 0) > maxFileBytes) return { ...base, status: a && b ? "not-comparable" : status, reason: "Too large to compare line by line" };
  const hunks = diffText(a?.toString("utf8") ?? "", b?.toString("utf8") ?? "");
  if (!hunks) return { ...base, status: a && b ? "not-comparable" : status, reason: "Too many changes to show" };
  const added = hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === "add").length, 0);
  const removed = hunks.reduce((n, h) => n + h.lines.filter((l) => l.kind === "del").length, 0);
  return { ...base, status, hunks, added, removed };
}

export function diffTotals(files: readonly Pick<FileDiff, "added" | "removed">[]): { added: number; removed: number } {
  return files.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 });
}

/**
 * The changed files a person edited (a save's own paths) and the ones the
 * build wrote (the change record, VALIDATION.json, indexes, zips, shared
 * section copies), with line totals for each. A read-only generated file
 * counts as built even when a save named it.
 */
export function splitBuiltFiles(
  files: readonly Pick<FileDiff, "path" | "added" | "removed">[],
  editedPaths: Iterable<string>,
  marks: Readonly<Record<string, Pick<PageFileMark, "generated"> | undefined>>,
): { edited: { added: number; removed: number }; built: { added: number; removed: number }; builtPaths: string[] } {
  const edited = new Set(editedPaths);
  const isBuilt = (p: string) => !edited.has(p) || Boolean(marks[p]?.generated);
  return {
    edited: diffTotals(files.filter((f) => !isBuilt(f.path))),
    built: diffTotals(files.filter((f) => isBuilt(f.path))),
    builtPaths: files.filter((f) => isBuilt(f.path)).map((f) => f.path),
  };
}

/** Keep the hunks of the first files until `maxLines` diff lines are used; later files keep their counts and get a reason. */
export function capDiffLines(files: FileDiff[], maxLines: number): FileDiff[] {
  let used = 0;
  return files.map((f) => {
    const lines = f.hunks.reduce((n, h) => n + h.lines.length, 0);
    if (!lines) return f;
    if (used + lines > maxLines) return { ...f, hunks: [], reason: f.reason ?? "Too large to show here. Download the package zip to compare it" };
    used += lines;
    return f;
  });
}

/** The longest title the to-address card shows. */
const MAX_FULL_TITLE_CHARS = 2000;

/**
 * A finding's title as the audit stored it is clipped with "..." at about 300
 * characters. When one of the finding's text values continues the clipped
 * title, this is the full text (the incident prefix of the title kept);
 * otherwise the title as it is.
 */
export function fullTitle(title: string, incidentId: string | null, values: Record<string, unknown>): string {
  if (!title.endsWith("...")) return title;
  const prefix = incidentId && title.startsWith(`${incidentId}: `) ? `${incidentId}: ` : "";
  const head = title.slice(prefix.length, -3).trimEnd();
  if (!head) return title;
  for (const v of Object.values(values)) {
    if (typeof v !== "string") continue;
    const t = v.replace(/\s+/g, " ").trim();
    if (t.length > head.length && t.startsWith(head)) return `${prefix}${t.length > MAX_FULL_TITLE_CHARS ? `${t.slice(0, MAX_FULL_TITLE_CHARS - 3).trimEnd()}...` : t}`;
  }
  return title;
}

/** The finding on its audit's page (the audit page selects the finding named in `finding`). */
export function findingHref(alias: string, auditId: string, findingId: string): string {
  return `/spaces/${encodeURIComponent(alias)}/audits/${encodeURIComponent(auditId)}/findings?finding=${encodeURIComponent(findingId)}`;
}

export function auditHref(alias: string, auditId: string): string {
  return `/spaces/${encodeURIComponent(alias)}/audits/${encodeURIComponent(auditId)}`;
}

/** Why a finding on the to-address list can't be linked now, in plain words; null while it is accepted. `state` is the finding's own state, or "missing" when it no longer exists. */
export function notAcceptedReason(state: string): string | null {
  if (state === "accepted") return null;
  if (state === "proposed") return "Reopened on its audit, so it isn't accepted now. It can be linked again once it is accepted.";
  if (state === "rejected") return "Rejected on its audit. It can't be linked unless it is accepted again.";
  if (state === "missing") return "This finding is no longer in the space.";
  return "Not accepted on its audit.";
}

/** The audits the findings come from, each once, in the order they first appear. */
export function sourceAuditsOf(alias: string, findings: readonly { auditId: string; auditName: string }[]): SourceAudit[] {
  const seen = new Set<string>();
  const out: SourceAudit[] = [];
  for (const f of findings) {
    if (!f.auditId || seen.has(f.auditId)) continue;
    seen.add(f.auditId);
    out.push({ id: f.auditId, name: f.auditName, href: auditHref(alias, f.auditId) });
  }
  return out;
}

// ---------- git reads ----------

/** Line diffs of package paths between two commits of a revision branch (from null: every file is added). */
export async function diffPackagePaths(repo: HistoryRepo, from: string | null, to: string, packageDir: string, paths: readonly string[], maxFileBytes: number): Promise<FileDiff[]> {
  const safe = paths.filter((p) => pathProblem(p) === null);
  const full = safe.map((p) => path.posix.join(packageDir, p));
  const [before, after] = await Promise.all([from ? repo.readBlobs(from, full) : Promise.resolve(new Map<string, Buffer | null>()), repo.readBlobs(to, full)]);
  return safe.map((p, i) => fileDiffOf(p, before.get(full[i]!), after.get(full[i]!), maxFileBytes));
}

// ---------- page loader ----------

export interface PageFileMark {
  /** Changed against the base (the branch's first commit) */
  edited: boolean;
  /** Errors of the latest build that name this file */
  errors: number;
  /** Written by the build or the change record: read only */
  generated: boolean;
  /** An instructions file: the editor shows the size meter */
  instructions: boolean;
}

export interface SaveView {
  id: string;
  /** 1 for the oldest save */
  number: number;
  message: string;
  commit: string;
  author: string;
  authorName: string | null;
  createdAt: Date;
  /** The person's files (not the build's) */
  files: FileDiff[];
  added: number;
  removed: number;
  findings: { id: string; label: string; href: string | null }[];
  unlinkedReason: string | null;
  buildStatus: "passed" | "failed";
}

export interface ResultLink {
  /** Index into build.results */
  index: number;
  /** Package path the result is about, or null */
  file: string | null;
}

/** A finding on the revision's to-address list, as the "To address" card shows it. */
export interface ToAddressView {
  id: string;
  /** The finding's full title: the audit clips its stored title at about 300 characters, and this continues it from the finding's values */
  title: string;
  incidentId: string | null;
  kind: string;
  kindLabel: string;
  /** The fix owner in the audit profile's words ("Instruction and skill package"), when the finding has one */
  owner: string | null;
  /** The profile's name for the owner field ("Owner") */
  ownerLabel: string | null;
  auditId: string;
  auditName: string;
  /** The audit page; null when the finding no longer exists */
  auditHref: string | null;
  /** The finding on its audit's page; null when the finding no longer exists */
  href: string | null;
  /** The finding's state on its audit: accepted, proposed (reopened), rejected, or missing */
  state: string;
  /** Accepted now: a save can link it */
  accepted: boolean;
  /** Why it can't be linked now; null while accepted */
  notAcceptedReason: string | null;
}

export interface SourceAudit {
  id: string;
  name: string;
  href: string;
}

export interface RevisionPage {
  detail: RevisionDetail;
  /** The to-address list, in the order the findings were added */
  toAddress: ToAddressView[];
  /** The audits the revision's findings (to address and linked) come from */
  sourceAudits: SourceAudit[];
  /** Per package path */
  marks: Record<string, PageFileMark>;
  /** The package's files grouped by top folder, in the layout's order */
  folders: PackageFolder[];
  /** The file each build result is about, by result index */
  resultFiles: (string | null)[];
  /** "<N> skill zips and <N> memory indexes rebuilt, shared sections copied" */
  rebuilt: string | null;
  /** Every changed file against the base, with totals for all of them, for the files the saves edited, and for the files the build wrote */
  baseDiff: { files: FileDiff[]; added: number; removed: number; edited: { added: number; removed: number }; built: { added: number; removed: number; paths: string[] } };
  /** Newest first */
  saves: SaveView[];
  findingLinks: Record<string, { label: string; href: string | null; kindLabel: string }>;
  limits: { agentsMdMaxBytes: number; agentsMdRecommendedLines: number; maxFileBytes: number };
  /** The release the revision starts from, for links */
  baseRelease: { id: string; name: string } | null;
  changelogPath: string | null;
  /** A create or save job of the revision that is queued or running */
  pendingRun: { kind: "create" | "save"; runId: string } | null;
  /** The revision has commits but its branch is gone from the history repository */
  branchMissing: boolean;
  /** What a plan from the revision would hold, and what it leaves as it is live (open revisions with saves) */
  scope: ScopeView | null;
}

export interface ScopeView {
  /** Labels of the assets the revision changed against its base */
  changed: string[];
  /** "<asset> changed in the live space after v1.2; a plan from this revision leaves it as it is." */
  leftAlone: string[];
  /** Assets the revision changed that also changed live after the base */
  conflicts: string[];
  /** "v1.2" or "this revision started" */
  after: string;
}

/** The scope of an open revision with saves at its head, for the page; null when it can't be read. */
async function scopeView(space: Space, r: RevisionDetail["revision"], policy: Policy, layout: PackageLayout | null): Promise<ScopeView | null> {
  if (!layout || r.state !== "open" || !r.changes || !r.headCommit || !r.createdCommit || !r.baseCommit) return null;
  try {
    const { repo } = await readContext(space);
    const [head, live] = await Promise.all([readRevisionPackage(repo, r.headCommit, r.packageDir, r.packageName), listIndexedAssets(space.id)]);
    const scope = await loadRevisionScope({ repo, policy, layout, spaceAlias: space.alias, row: r, head, live });
    if (!scope) return null;
    const base = { kind: r.base.kind, name: r.base.releaseName ?? null };
    const subject = "a plan from this revision";
    return {
      changed: scope.changed.map((c) => c.label),
      leftAlone: leftAloneSentences(scope.leftAlone, base, subject, MAX_LEFT_ALONE_NOTES),
      conflicts: scope.changed.flatMap((c) => conflictSentence(c, base, subject) ?? []),
      after: scopeAfter(base),
    };
  } catch {
    // The page still works without it; the plan computes it again.
    return null;
  }
}

/** Diff lines kept in the page payload for the Diff tab and for all saves together. */
const MAX_PAGE_DIFF_LINES = 6000;

/** The profiles the audits ran with (audits.profile_snapshot), by audit ID. */
async function auditProfiles(auditIds: readonly string[]): Promise<Map<string, AuditProfile>> {
  const ids = [...new Set(auditIds)].filter(isUuid);
  if (!ids.length) return new Map();
  const rows = await db().select({ id: audits.id, profile: audits.profileSnapshot }).from(audits).where(inArray(audits.id, ids));
  return new Map(rows.filter((r) => r.profile && typeof r.profile === "object").map((r) => [r.id, r.profile as AuditProfile]));
}

/** Kind labels of the audits' profiles (findings[].label), by audit ID and kind. */
async function kindLabels(auditIds: readonly string[], profiles?: Map<string, AuditProfile>): Promise<Map<string, string>> {
  const byAudit = profiles ?? (await auditProfiles(auditIds));
  const out = new Map<string, string>();
  for (const [id, profile] of byAudit) {
    const kinds = (profile as { findings?: { kind?: unknown; label?: unknown }[] }).findings ?? [];
    for (const k of kinds) if (typeof k.kind === "string" && typeof k.label === "string") out.set(`${id}:${k.kind}`, k.label);
  }
  return out;
}

const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Item IDs of findings, for links to the incident review page. */
async function itemIds(findingIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(findingIds)].filter(isUuid);
  if (!ids.length) return new Map();
  const rows = await db().select({ id: findingsTable.id, itemId: findingsTable.auditItemId }).from(findingsTable).where(inArray(findingsTable.id, ids));
  return new Map(rows.map((r) => [r.id, r.itemId]));
}

/**
 * The revision detail page: loadRevisionDetail plus the marks, diffs and
 * finding labels the editor, Diff and Saves tabs show. The caller has
 * checked `audits.read` for the space. Null when there is no such revision.
 */
export async function loadRevisionPage(space: Space, idOrName: string, viewer?: RevisionViewer, opts: { path?: string | null } = {}): Promise<RevisionPage | null> {
  const detail = await loadRevisionDetail(space, idOrName, viewer, { path: opts.path ?? null });
  if (!detail) return null;
  const { policy } = await policyForSpace(space);
  const r = detail.revision;
  let layout: PackageLayout | null = null;
  try {
    layout = layoutOf(policy, r.layout);
  } catch {
    layout = null;
  }
  // Read alongside the diffs: what a plan would hold and what it leaves as it is live.
  const scopePromise = scopeView(space, r, policy, layout);
  const changelogPath = policy.revisions.changelog.path ?? null;
  const validationPath = layout?.build.validationResult ?? null;
  const maxFileBytes = policy.revisions.pages.maxFileBytes;

  const edited = new Set(detail.diff.files.map((f) => f.path));
  const results = detail.build?.results ?? [];
  const errors = errorsByFile(results, detail.tree);
  const marks: Record<string, PageFileMark> = {};
  for (const f of detail.tree) {
    marks[f.path] = {
      edited: edited.has(f.path),
      errors: errors.get(f.path) ?? 0,
      generated: isGeneratedFile(f, { changelogPath, validationPath, descriptor: layout?.assetFolders?.descriptor ?? null }),
      instructions: f.role === "asset" && (f.assetKey?.startsWith("agents_md:") ?? false),
    };
  }

  let baseFiles: FileDiff[] = [];
  let saves: SaveView[] = [];
  let branchMissing = false;
  const allFindingIds = detail.changes.flatMap((c) => c.findingIds);
  const toAddressRows = await findingsForToAddress(space.id, r.toAddressIds);
  const [profiles, items] = await Promise.all([auditProfiles([...detail.findings.map((f) => f.auditId), ...toAddressRows.map((f) => f.auditId)]), itemIds(allFindingIds)]);
  const labels = await kindLabels([], profiles);
  const base = `/spaces/${encodeURIComponent(space.alias)}/audits`;
  const findingLinks: RevisionPage["findingLinks"] = {};
  for (const f of detail.findings) {
    const kindLabel = labels.get(`${f.auditId}:${f.kind}`) ?? sentence(f.kind);
    const item = items.get(f.id);
    findingLinks[f.id] = { label: `${f.incidentId ?? f.title} · ${kindLabel}`, href: item ? `${base}/${encodeURIComponent(f.auditId)}/items/${encodeURIComponent(item)}` : null, kindLabel };
  }

  if (detail.repo.ok && r.headCommit) {
    try {
      const { repo } = await readContext(space);
      branchMissing = !(await repo.branchHead(r.branch));
      if (r.createdCommit) baseFiles = await diffPackagePaths(repo, r.createdCommit, r.headCommit, r.packageDir, detail.diff.files.map((f) => f.path), maxFileBytes);
      const changes = [...detail.changes];
      const perSave = await Promise.all(changes.map((c) => (c.parentCommit ? diffPackagePaths(repo, c.parentCommit, c.commit, r.packageDir, c.changedPaths, maxFileBytes) : Promise.resolve([] as FileDiff[]))));
      saves = changes.map((c, i) => {
        const files = perSave[i]!;
        const totals = diffTotals(files);
        return {
          id: c.id,
          number: changes.length - i,
          message: c.message,
          commit: c.commit,
          author: c.author,
          authorName: c.authorName,
          createdAt: c.createdAt,
          files,
          added: totals.added,
          removed: totals.removed,
          findings: c.findingIds.map((id) => ({ id, label: findingLinks[id]?.label ?? "A finding", href: findingLinks[id]?.href ?? null })),
          unlinkedReason: c.unlinkedReason,
          buildStatus: c.buildStatus,
        };
      });
    } catch {
      // The detail already says when the repository can't be read.
    }
  }
  const toAddress = toAddressViews(space.alias, r.toAddressIds, toAddressRows, profiles, labels);
  const baseTotals = diffTotals(baseFiles);
  // The person's files and the build's: a 4-line edit should not read as +15 because the change record and VALIDATION.json changed too.
  const { edited: editedTotals, built: builtTotals, builtPaths } = splitBuiltFiles(baseFiles, detail.changes.flatMap((c) => c.changedPaths), marks);
  // One budget for the page: the Diff tab first, then the saves newest first.
  const cappedBase = capDiffLines(baseFiles, MAX_PAGE_DIFF_LINES);
  const usedByBase = cappedBase.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0);
  let left = Math.max(0, MAX_PAGE_DIFF_LINES - usedByBase);
  saves = saves.map((s) => {
    const files = capDiffLines(s.files, left);
    left -= files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0);
    return { ...s, files };
  });

  const [pendingRun, scope] = await Promise.all([pendingRunOf(detail.revision.id), scopePromise]);
  return {
    detail,
    pendingRun,
    scope,
    toAddress,
    sourceAudits: sourceAuditsOf(space.alias, [...toAddress, ...detail.findings]),
    branchMissing,
    marks,
    folders: layout ? packageFolders(detail.tree.map((f) => f.path), layout) : [{ name: null, files: detail.tree.map((f) => f.path) }],
    resultFiles: results.map((x) => resultFile(x, detail.tree)),
    rebuilt: layout ? rebuiltLine(detail.tree.map((f) => f.path), layout) : null,
    baseDiff: { files: cappedBase, ...baseTotals, edited: editedTotals, built: { ...builtTotals, paths: builtPaths } },
    saves,
    findingLinks,
    limits: { agentsMdMaxBytes: policy.limits.agentsMdMaxBytes, agentsMdRecommendedLines: policy.limits.agentsMdRecommendedLines, maxFileBytes },
    baseRelease: r.baseRelease ?? null,
    changelogPath,
  };
}

/** The to-address list as the card shows it: in list order, each with its labels and links; an ID with no finding left stays so it can be removed. */
export function toAddressViews(alias: string, ids: readonly string[], rows: readonly ToAddressRow[], profiles: ReadonlyMap<string, AuditProfile>, kindLabelsByAudit: ReadonlyMap<string, string>): ToAddressView[] {
  const byId = new Map(rows.map((x) => [x.id, x]));
  return ids.map((id): ToAddressView => {
    const f = byId.get(id);
    if (!f) {
      return { id, title: "A finding that is no longer in this space", incidentId: null, kind: "", kindLabel: "", owner: null, ownerLabel: null, auditId: "", auditName: "", auditHref: null, href: null, state: "missing", accepted: false, notAcceptedReason: notAcceptedReason("missing") };
    }
    return {
      id,
      title: fullTitle(f.title, f.incidentId, f.values),
      incidentId: f.incidentId,
      kind: f.kind,
      kindLabel: kindLabelsByAudit.get(`${f.auditId}:${f.kind}`) ?? sentence(f.kind),
      ...ownerOf(profiles.get(f.auditId), f.kind, f.values),
      auditId: f.auditId,
      auditName: f.auditName,
      auditHref: auditHref(alias, f.auditId),
      href: findingHref(alias, f.auditId, f.id),
      state: f.state,
      accepted: f.state === "accepted",
      notAcceptedReason: notAcceptedReason(f.state),
    };
  });
}

/** The revision's create or last save job, when it is still queued or running. */
async function pendingRunOf(revisionId: string): Promise<RevisionPage["pendingRun"]> {
  const [row] = await db().select({ createRunId: revisions.createRunId, lastSaveRunId: revisions.lastSaveRunId, state: revisions.state }).from(revisions).where(eq(revisions.id, revisionId));
  const runId = row?.state === "creating" ? row.createRunId : (row?.lastSaveRunId ?? null);
  if (!row || !runId) return null;
  const [run] = await db().select({ status: jobRuns.status }).from(jobRuns).where(eq(jobRuns.id, runId));
  return run && (run.status === "queued" || run.status === "running") ? { kind: row.state === "creating" ? "create" : "save", runId } : null;
}

// ---------- one file for the editor ----------

export type RevisionFileView = ReturnType<typeof fileView>;

/**
 * One package file at the revision branch head, for the editor's file
 * switch (Route Handler). The caller has checked `audits.read`. Null when
 * the revision, its head or the file doesn't exist.
 */
export async function readRevisionFile(space: Space, idOrName: string, filePath: string): Promise<{ path: string; head: string; view: NonNullable<RevisionFileView> } | null> {
  if (!filePath || pathProblem(filePath) !== null) return null;
  const { policy } = await policyForSpace(space);
  const row = (isUuid(idOrName) ? await getRevision(space.id, idOrName) : null) ?? (await getRevisionByNameKey(space.id, revisionNameKey(policy, idOrName)));
  if (!row?.headCommit) return null;
  const { repo } = await readContext(space);
  const full = path.posix.join(row.packageDir, filePath);
  const view = fileView((await repo.readBlobs(row.headCommit, [full])).get(full) ?? undefined, policy.revisions.pages.maxFileBytes);
  return view ? { path: filePath, head: row.headCommit, view } : null;
}

// ---------- the save dialog's finding picker ----------

export interface SaveFinding {
  id: string;
  title: string;
  incidentId: string | null;
  kind: string;
  kindLabel: string;
  auditName: string;
  /** Owner of a fix in the profile's words ("Customer memory or runbook content"), when there is one */
  owner: string | null;
  /** The profile's name for the owner field ("Owner") */
  ownerLabel: string | null;
  acceptedBy: string | null;
  /** Record numbers its citations confirm */
  records: number[];
  /** Linked by an earlier save of this revision */
  linkedBefore: boolean;
  /** Sent to this revision from an audit and not linked yet: the save dialog preselects it */
  toAddress: boolean;
  /** The finding's own text (title and text values), for matching it to the edited files */
  text: string;
}

/** A profile with every list fieldValueLabel reads, so an older snapshot without one still labels. */
function labelProfile(p: AuditProfile | undefined): Parameters<typeof fieldValueLabel>[0] | null {
  if (!p) return null;
  return { failureModes: p.failureModes ?? [], fixOwners: p.fixOwners ?? [], cohorts: p.cohorts ?? [], findings: p.findings ?? [] };
}

/** A fix's owner in the profile's words, and the profile's name for the field. Null when the finding has no owner. */
function ownerOf(profile: AuditProfile | undefined, kind: string, values: Record<string, unknown>): { owner: string | null; ownerLabel: string | null } {
  const raw = typeof values.owner === "string" ? values.owner : null;
  if (raw === null) return { owner: null, ownerLabel: null };
  const labels = labelProfile(profile);
  return labels ? { owner: fieldValueLabel(labels, "owner", raw, kind), ownerLabel: fieldLabel(labels, "owner", kind) } : { owner: raw, ownerLabel: "Owner" };
}

/** The text values of a finding (fix text, one-line diagnosis, detail), joined for matching. */
function findingText(title: string, values: Record<string, unknown>): string {
  const parts = [title];
  for (const v of Object.values(values)) {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") parts.push(x);
  }
  return parts.join("\n").slice(0, 1200);
}

/**
 * Findings the save dialog offers: accepted and linkable (listLinkableFindings).
 * The revision's to-address findings (`opts.toAddress`, those still accepted)
 * come first, in the order they were added, then those already linked by
 * earlier saves, each with the records its citations confirm for the changelog
 * preview and its owner in the profile's words. The dialog preselects the
 * to-address ones and puts the findings that name an edited file next. The
 * caller has checked `audits.read`.
 */
export async function loadSaveFindings(space: Space, linkedBefore: readonly string[] = [], opts: { limit?: number; toAddress?: readonly string[] } = {}): Promise<SaveFinding[]> {
  // The to-address findings are always offered, also when their item was reviewed again since (a finding's accepted decision stays linkable).
  const wanted = [...new Set(opts.toAddress ?? [])];
  const [listed, sent] = await Promise.all([listLinkableFindings(space.id, { limit: opts.limit ?? 500 }), wanted.length ? listLinkableFindings(space.id, { ids: wanted, limit: wanted.length }) : Promise.resolve([])]);
  const rows = [...sent, ...listed.filter((f) => !sent.some((x) => x.id === f.id))];
  const profiles = await auditProfiles(rows.map((f) => f.auditId));
  const [cited, labels] = await Promise.all([findingsForChangelog(space.id, rows.map((f) => f.id)), kindLabels(rows.map((f) => f.auditId), profiles)]);
  const citations = new Map(cited.map((f) => [f.id, f.citations]));
  const before = new Set(linkedBefore);
  const toAddress = new Set(wanted);
  const out = rows.map((f): SaveFinding => {
    return {
      id: f.id,
      title: f.title,
      incidentId: f.incidentId,
      kind: f.kind,
      kindLabel: labels.get(`${f.auditId}:${f.kind}`) ?? sentence(f.kind),
      auditName: f.auditName,
      ...ownerOf(profiles.get(f.auditId), f.kind, f.values as Record<string, unknown>),
      acceptedBy: f.reviewedBy,
      records: citedRecords(citations.get(f.id) ?? []),
      linkedBefore: before.has(f.id),
      toAddress: toAddress.has(f.id),
      text: findingText(f.title, f.values as Record<string, unknown>),
    };
  });
  // The to-address findings in the order they were added, then the ones earlier saves linked, then the rest.
  const sentInOrder = wanted.flatMap((id) => out.find((f) => f.id === id) ?? []);
  return [...sentInOrder, ...out.filter((f) => !f.toAddress && f.linkedBefore), ...out.filter((f) => !f.toAddress && !f.linkedBefore)];
}
