import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, eq, inArray, lt, or } from "drizzle-orm";
import { isSafeAssetFilePath, openSpaceHistoryRepo, type SpaceRepo } from "@/server/assets/repo";
import type { Actor } from "@/server/aws/clients";
import { recordAuditEvent } from "@/server/audit-log";
import { db } from "@/server/db/client";
import { packageImports } from "@/server/db/schema";
import { safeSegment } from "@/server/history/layout";
import { policyForSpace } from "@/server/journals/policy";
import { exportPackageZip } from "@/server/packages/export";
import { rankLayouts } from "@/server/packages/detect";
import { getLayout, type PackageLayout } from "@/server/packages/layout";
import { snapshotsToDesiredAssets } from "@/server/packages/live";
import { fill } from "@/server/packages/paths";
import { joinAnd, typePlanCountsText, type TypePlanCounts } from "./format";
import { assetKeyOf, type PackageContents } from "@/server/packages/types";
import { createPlan } from "@/server/plans";
import type { Policy } from "@/server/policy";
import type { Space } from "@/server/spaces/queries";
import { sha256Hex } from "@/server/sync/content";
import { error, ValidationFailure, type ValidationResult } from "@/server/validation/types";
import { addDiffStats, analyzeImport, planItemsFromAnalysis, summarize, type Analysis } from "./analyze";
import { loadLiveIndex, readSnapshotsAtCommit, resolveExportRef, type ExportRef } from "./history";
import { deleteStoredUpload, readStoredUploadFile, storedPathFor, writeStoredUpload } from "./storage";
import { PackageIoError, type ImportResults, type ImportStatus, type ImportSummary, type LayoutCandidate } from "./types";
import { refuseIfInRevision } from "./to-revision";
import { readStoredUpload, readUpload, type PackageUpload } from "./upload";

/**
 * Package import and export services. Server Actions and the download Route
 * Handler call these after the DAL check (PACKAGE_IO_PERMISSIONS) on the
 * space; every function takes the acting user from the session.
 */

export type ServiceActor = Actor & { name?: string | null };

export type PackageImportRow = typeof packageImports.$inferSelect;

/** A claim on an import while its plan is created; older claims are treated as abandoned. */
const PLAN_CLAIM_STALE_MS = 5 * 60 * 1000;

/** The layout named in a request, or the policy default. */
export function resolveLayout(policy: Pick<Policy, "packageLayouts">, name?: string | null): PackageLayout {
  try {
    return getLayout(policy, name ?? undefined);
  } catch {
    throw new PackageIoError("unknown-layout", `There is no package layout named ${JSON.stringify(name)}.`);
  }
}

/** An import of this space, or null. The ID alone never grants access to another space's import. */
export async function getImportRow(spaceId: string, importId: string): Promise<PackageImportRow | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(importId)) return null;
  const [row] = await db()
    .select()
    .from(packageImports)
    .where(and(eq(packageImports.spaceId, spaceId), eq(packageImports.id, importId)));
  return row ?? null;
}

// ---------- import ----------

export interface ImportPackageRequest {
  upload: PackageUpload;
  /**
   * Layout name from package-layouts.yaml. None: detected, the layout that
   * maps the most files (rankLayouts; ties go to the policy's defaultLayout).
   */
  layout?: string | null;
}

export interface ImportPackageResult {
  importId: string;
  status: ImportStatus;
  summary: ImportSummary;
  /** Why the upload was rejected or the analysis failed; empty when analyzed */
  problems: ValidationResult[];
  /** The layout the package was read with, and whether it was detected (always set by importPackage) */
  layout?: string;
  layoutChoice?: "detected" | "chosen";
}

function emptyResults(validation: ValidationResult[], now: Date): ImportResults {
  return { items: [], files: [], untouched: [], validation, historyCommit: null, analyzedAt: now.toISOString() };
}

function failedSummary(results: ImportResults, packageName: string | null): ImportSummary {
  return summarize({ ok: false, results: results.validation }, results, packageName);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

/**
 * Lines added and removed for updated items, read from the history
 * repository at the commit the mapping used. Display only: a failed read
 * leaves the counts out instead of failing the import.
 */
async function withDiffStats(analysis: Analysis, live: Awaited<ReturnType<typeof loadLiveIndex>>, policy: Policy): Promise<void> {
  const { repo, historyCommit } = live;
  if (!repo.ok || !historyCommit) return;
  try {
    await addDiffStats(analysis, live.entries, policy, (entry, file) =>
      entry.gitPath && isSafeAssetFilePath(file) ? repo.repo.showBytes(historyCommit, path.posix.join(entry.gitPath, file)) : Promise.resolve(null),
    );
  } catch {
    // Leave the counts out.
  }
}

/**
 * Upload a package (zip or folder), store it, and map it against the
 * space's current index: per asset create, update or unchanged, each file's
 * role, and the validation results. Needs `plans.create` on the space.
 * Rejected uploads (unsafe paths, over the size caps) are recorded without
 * storing the file.
 */
export async function importPackage(space: Space, request: ImportPackageRequest, actor: ServiceActor): Promise<ImportPackageResult> {
  const { policy } = await policyForSpace(space);
  const layoutChoice = request.layout ? "chosen" : "detected";
  let layout = resolveLayout(policy, request.layout);
  let read = readUpload(request.upload, { policy, layout });
  const candidates = read.ok ? layoutCandidates(read.contents, policy) : [];
  if (read.ok && layoutChoice === "detected" && candidates[0] && candidates[0].layout !== layout.name) {
    // Read again with the detected layout: layouts may differ in what they ignore or strip.
    layout = resolveLayout(policy, candidates[0].layout);
    read = readUpload(request.upload, { policy, layout });
  }
  const id = randomUUID();
  const now = new Date();
  const base = { id, spaceId: space.id, fileName: read.fileName, source: read.source, sha256: read.sha256, sizeBytes: read.sizeBytes, layout: layout.name, importedBy: actor.email };
  const audit = (result: "ok" | "error", details: Record<string, unknown>) =>
    recordAuditEvent({
      actor,
      action: "package.import",
      spaceId: space.id,
      targetType: "package_import",
      targetId: id,
      result,
      details: { fileName: read.fileName, source: read.source, sha256: read.sha256, sizeBytes: read.sizeBytes, layout: layout.name, layoutChoice, ...details },
    });

  if (!read.ok) {
    const results = emptyResults(read.results, now);
    const summary = failedSummary(results, null);
    await db()
      .insert(packageImports)
      .values({ ...base, status: "rejected", mappingSummary: summary, results, analyzedAt: now });
    await audit("error", { status: "rejected", problems: read.results.slice(0, 20).map((r) => ({ code: r.code, path: r.path })) });
    return { importId: id, status: "rejected", summary, problems: read.results, layout: layout.name, layoutChoice };
  }

  const storedPath = storedPathFor(id);
  await writeStoredUpload(storedPath, read.stored);
  const expiresAt = new Date(now.getTime() + policy.packageIo.uploads.retentionDays * 86_400_000);

  let status: ImportStatus = "analyzed";
  let results: ImportResults;
  let summary: ImportSummary;
  let problems: ValidationResult[] = [];
  try {
    const live = await loadLiveIndex(space, policy);
    const analysis = analyzeImport({ contents: read.contents, layout, policy, live: live.entries, historyCommit: live.historyCommit, now });
    await withDiffStats(analysis, live, policy);
    results = { ...analysis.results, layouts: candidates, layoutChoice };
    summary = analysis.summary;
  } catch (err) {
    status = "failed";
    problems = [error("import.failed", `The package could not be mapped: ${errorText(err)}`)];
    results = { ...emptyResults(problems, now), layouts: candidates, layoutChoice };
    summary = failedSummary(results, read.contents.name);
  }

  try {
    await db()
      .insert(packageImports)
      .values({ ...base, packageName: read.contents.name, status, mappingSummary: summary, results, storedPath, analyzedAt: now, expiresAt });
  } catch (err) {
    await deleteStoredUpload(storedPath).catch(() => undefined);
    throw err;
  }
  await audit(status === "analyzed" ? "ok" : "error", { status, packageName: read.contents.name, ok: summary.ok, counts: summary.counts });
  return { importId: id, status, summary, problems, layout: layout.name, layoutChoice };
}

/** Every layout's fit for a package, best first (rankLayouts). */
export function layoutCandidates(contents: PackageContents, policy: Policy): LayoutCandidate[] {
  return rankLayouts(contents, policy).map((f) => ({ layout: f.layout, label: f.label, assets: f.assets, assetFiles: f.assetFiles, unmappedFiles: f.unmappedFiles }));
}

/**
 * Map a stored upload again with another layout (the person overrides the
 * detected one). Allowed while no plan exists from the import. Needs
 * `plans.create` on the space. Audit event `package.import.layout`.
 */
export async function remapImport(space: Space, importId: string, layoutName: string, actor: ServiceActor): Promise<{ importId: string; status: ImportStatus; summary: ImportSummary }> {
  const row = await getImportRow(space.id, importId);
  if (!row) throw new PackageIoError("not-found", "There is no such import in this space.");
  if (row.status === "planned" || row.status === "planning") throw new PackageIoError("already-planned", "A plan was already created from this import, so its layout can't change. Upload the package again.");
  if (row.status === "rejected") throw new PackageIoError("not-plannable", "The upload was rejected, so it can't be read again. Fix the package and upload it again.");
  if (!row.storedPath || row.fileDeletedAt) throw new PackageIoError("upload-expired", "The uploaded package was deleted after its retention period. Upload it again.");
  await refuseIfInRevision(space.id, row.id);
  const { policy } = await policyForSpace(space);
  const layout = resolveLayout(policy, layoutName);
  const bytes = await readStoredUploadFile(row.storedPath);
  if (!bytes) throw new PackageIoError("upload-expired", "The uploaded package is no longer stored. Upload it again.");
  if (sha256Hex(bytes) !== row.sha256) throw new PackageIoError("upload-changed", "The stored upload does not match its SHA-256. Upload the package again.");
  const previous = (row.results as ImportResults | null) ?? null;
  const now = new Date();
  let status: ImportStatus = "analyzed";
  let results: ImportResults;
  let summary: ImportSummary;
  let packageName = row.packageName;
  try {
    const contents = readStoredUpload(bytes, row.packageName, { policy, layout });
    packageName = contents.name;
    const live = await loadLiveIndex(space, policy);
    const analysis = analyzeImport({ contents, layout, policy, live: live.entries, historyCommit: live.historyCommit, now });
    await withDiffStats(analysis, live, policy);
    results = { ...analysis.results, layouts: previous?.layouts ?? layoutCandidates(contents, policy), layoutChoice: "chosen" };
    summary = analysis.summary;
  } catch (err) {
    status = "failed";
    const problems = err instanceof ValidationFailure ? err.results : [error("import.failed", `The package could not be mapped: ${errorText(err)}`)];
    results = { ...emptyResults(problems, now), layouts: previous?.layouts ?? [], layoutChoice: "chosen" };
    summary = failedSummary(results, row.packageName);
  }
  await db()
    .update(packageImports)
    .set({ layout: layout.name, packageName, status, mappingSummary: summary, results, analyzedAt: now })
    .where(and(eq(packageImports.id, row.id), inArray(packageImports.status, ["analyzed", "failed"])));
  await recordAuditEvent({
    actor,
    action: "package.import.layout",
    spaceId: space.id,
    targetType: "package_import",
    targetId: row.id,
    result: status === "analyzed" ? "ok" : "error",
    details: { fileName: row.fileName, sha256: row.sha256, from: row.layout, layout: layout.name, status, ok: summary.ok, counts: summary.counts },
  });
  return { importId: row.id, status, summary };
}

/**
 * Audit an upload refused before it was read (the body was over the upload
 * limit or arrived cut off), so rejected uploads are all in the audit log.
 * No import row is created: nothing of the package was read.
 */
export async function recordRefusedUpload(space: Space, actor: ServiceActor, details: { reason: "too-large" | "truncated"; sizeBytes: number; limitBytes: number }): Promise<void> {
  await recordAuditEvent({ actor, action: "package.import", spaceId: space.id, targetType: "package_import", result: "error", details: { status: "refused", ...details } });
}

// ---------- plan ----------

/** The plan title the policy gives an import (`import.planTitle`). */
export function defaultPlanTitle(policy: Pick<Policy, "packageIo">, row: Pick<PackageImportRow, "packageName" | "fileName">, space: Pick<Space, "alias">): string {
  return fill(policy.packageIo.import.planTitle, { packageName: row.packageName ?? row.fileName, fileName: row.fileName, spaceAlias: space.alias });
}

export interface CreateImportPlanOptions {
  /** Change reason prefilled on the plan */
  reason?: string | null;
  /** Plan title; default: the policy's `import.planTitle` */
  title?: string | null;
  /**
   * Asset types to plan; null or undefined: every type the package maps.
   * The plan notes what was left out.
   */
  includeTypes?: readonly string[] | null;
}

export interface CreateImportPlanResult {
  planId: string;
  checkRunId: string;
  /** Plan items: the create and update items */
  items: number;
  summary: ImportSummary;
  /** Plan notes: what the import left out */
  notes: string[];
}

/**
 * Create a plan from an import: the stored upload is read again (its
 * SHA-256 checked) and mapped against the index as it is now, then the
 * create and update items go to createPlan with origin { kind: "package" }.
 * Unchanged assets are left out, and nothing is deleted. Needs
 * `plans.create` on the space.
 */
export async function createPlanFromImport(space: Space, importId: string, actor: ServiceActor, opts: CreateImportPlanOptions = {}): Promise<CreateImportPlanResult> {
  const row = await getImportRow(space.id, importId);
  if (!row) throw new PackageIoError("not-found", "There is no such import in this space.");
  if (row.status === "planned") throw new PackageIoError("already-planned", `A plan was already created from this import (plan ${row.planId}).`);
  if (row.status === "rejected") throw new PackageIoError("not-plannable", "The upload was rejected, so it can't become a plan. Fix the package and upload it again.");
  if (!row.storedPath || row.fileDeletedAt) throw new PackageIoError("upload-expired", "The uploaded package was deleted after its retention period. Upload it again.");
  await refuseIfInRevision(space.id, row.id);

  const { policy } = await policyForSpace(space);
  const layout = resolveLayout(policy, row.layout);
  const bytes = await readStoredUploadFile(row.storedPath);
  if (!bytes) throw new PackageIoError("upload-expired", "The uploaded package is no longer stored. Upload it again.");
  if (sha256Hex(bytes) !== row.sha256) throw new PackageIoError("upload-changed", "The stored upload does not match its SHA-256. Upload the package again.");

  const includeTypes = selectedTypes(policy, opts.includeTypes);
  if (includeTypes && includeTypes.length === 0) throw new PackageIoError("bad-request", "Choose at least one asset type to import.");
  let analysis: Analysis;
  try {
    const contents = readStoredUpload(bytes, row.packageName, { policy, layout });
    const live = await loadLiveIndex(space, policy);
    analysis = analyzeImport({ contents, layout, policy, live: live.entries, historyCommit: live.historyCommit, includeTypes });
    await withDiffStats(analysis, live, policy);
  } catch (err) {
    if (err instanceof ValidationFailure) throw new PackageIoError("not-plannable", "The stored upload no longer passes the read checks.", err.results);
    throw err;
  }
  const previous = (row.results as ImportResults | null) ?? null;
  const refresh = {
    mappingSummary: analysis.summary,
    results: { ...analysis.results, ...(previous?.layouts ? { layouts: previous.layouts } : {}), ...(previous?.layoutChoice ? { layoutChoice: previous.layoutChoice } : {}) },
    analyzedAt: new Date(analysis.results.analyzedAt),
  };
  // A refused attempt with a type selection leaves the stored mapping (all types) as it is.
  const refreshOnRefusal = async () => {
    if (!includeTypes) await db().update(packageImports).set(refresh).where(eq(packageImports.id, row.id));
  };

  if (policy.packageIo.import.blockPlanOnErrors && !analysis.summary.ok) {
    await refreshOnRefusal();
    const errors = analysis.results.validation.filter((r) => r.level === "error");
    throw new PackageIoError(
      "not-plannable",
      includeTypes
        ? `The selected asset types have ${errors.length} validation error(s). Fix them and upload the package again, or leave those types out.`
        : `The package has ${analysis.summary.counts.errors} validation error(s). Fix them and upload the package again.`,
      errors,
    );
  }
  const items = planItemsFromAnalysis(analysis);
  if (items.length === 0) {
    await refreshOnRefusal();
    throw new PackageIoError(
      "nothing-to-plan",
      includeTypes ? "Every selected asset already matches the space, so there is nothing to plan." : "Every asset in the package already matches the space, so there is nothing to plan.",
    );
  }
  const notes = importPlanNotes(policy, analysis.results, previous);

  // Claim the import (status "planning") so a double submit creates one plan.
  const claimedAt = new Date();
  const claimed = await db()
    .update(packageImports)
    .set({ status: "planning", plannedAt: claimedAt, plannedBy: actor.email })
    .where(
      and(
        eq(packageImports.id, row.id),
        or(
          inArray(packageImports.status, ["analyzed", "failed"]),
          and(eq(packageImports.status, "planning"), lt(packageImports.plannedAt, new Date(claimedAt.getTime() - PLAN_CLAIM_STALE_MS))),
        ),
      ),
    )
    .returning({ id: packageImports.id });
  if (claimed.length === 0) throw new PackageIoError("already-planned", "A plan is already being created from this import.");
  const previousStatus: ImportStatus = row.status === "failed" ? "failed" : "analyzed";

  const title = opts.title?.trim() || defaultPlanTitle(policy, row, space);
  let plan: { planId: string; checkRunId: string };
  try {
    plan = await createPlan(
      { spaceId: space.id, title, origin: { kind: "package", importId: row.id, fileName: row.fileName }, items, reason: opts.reason ?? null, ...(notes.length ? { notes } : {}) },
      actor,
    );
  } catch (err) {
    await db()
      .update(packageImports)
      .set({ ...refresh, status: previousStatus, plannedAt: null, plannedBy: null })
      .where(eq(packageImports.id, row.id));
    await recordAuditEvent({
      actor,
      action: "package.plan",
      spaceId: space.id,
      targetType: "package_import",
      targetId: row.id,
      result: "error",
      details: { fileName: row.fileName, sha256: row.sha256, error: errorText(err) },
    });
    throw err;
  }

  await db()
    .update(packageImports)
    .set({ ...refresh, status: "planned", planId: plan.planId, plannedAt: claimedAt, plannedBy: actor.email })
    .where(eq(packageImports.id, row.id));
  await recordAuditEvent({
    actor,
    action: "package.plan",
    spaceId: space.id,
    targetType: "package_import",
    targetId: row.id,
    details: {
      planId: plan.planId,
      checkRunId: plan.checkRunId,
      fileName: row.fileName,
      sha256: row.sha256,
      items: items.length,
      counts: analysis.summary.counts,
      ...(includeTypes ? { includeTypes } : {}),
    },
  });
  return { planId: plan.planId, checkRunId: plan.checkRunId, items: items.length, summary: analysis.summary, notes };
}

/** The asset types a request selects, limited to types in asset-types.yaml; null: every type. */
function selectedTypes(policy: Pick<Policy, "assetTypes">, types: readonly string[] | null | undefined): string[] | null {
  if (!types) return null;
  return [...new Set(types)].filter((t) => policy.assetTypes.assetTypes[t]);
}

/**
 * Plan notes for what an import leaves out: the types not selected, as
 * counts, then each duplicate with its reason. Each note fits the plans
 * policy's note length, and the list its item cap.
 */
export function importPlanNotes(
  policy: Pick<Policy, "assetTypes" | "plans">,
  results: Pick<ImportResults, "leftOut">,
  /**
   * The import's stored mapping of every type (what the page showed). With
   * it, a type left out by choice is counted the way its checkbox counted it
   * ("skills (48 changes, 5 left out)"), so the page and the notes agree.
   */
  stored?: Pick<ImportResults, "items" | "leftOut"> | null,
): string[] {
  const leftOut = results.leftOut ?? [];
  const notes: string[] = [];
  const byType = new Map<string, number>();
  for (const l of leftOut) if (l.reason === "type-not-selected") byType.set(l.assetType, (byType.get(l.assetType) ?? 0) + 1);
  if (byType.size) {
    const order = Object.keys(policy.assetTypes.assetTypes);
    const counted = (t: string): TypePlanCounts | null => {
      const items = stored?.items.filter((i) => i.assetType === t) ?? [];
      if (!items.length) return null;
      return {
        changes: items.filter((i) => i.action === "create" || i.action === "update").length,
        unchanged: items.filter((i) => i.action === "unchanged").length,
        leftOut: (stored?.leftOut ?? []).filter((l) => l.assetType === t && l.reason !== "type-not-selected").length,
      };
    };
    const parts = [...byType.entries()]
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(([t, n]) => {
        const c = counted(t);
        return c ? `${assetTypeNoun(policy, t, 2)} (${typePlanCountsText(c)})` : `${n} ${assetTypeNoun(policy, t, n)}`;
      });
    notes.push(`Left out of this import by choice: ${joinAnd(parts)} from the package.`);
  }
  for (const l of leftOut) if (l.reason === "duplicate" || l.reason === "cannot-create") notes.push(l.message);
  const max = policy.plans.limits.noteMaxChars;
  return notes.slice(0, policy.plans.limits.maxItemsPerPlan).map((n) => (n.length > max ? `${n.slice(0, max - 1)}…` : n));
}

// ---------- export ----------

export interface ExportPackageRequest {
  /** "HEAD" (default), a commit hash, or one of the space's release tags */
  ref?: string | null;
  /** Layout name; default: the policy's defaultLayout */
  layout?: string | null;
  /** Package name (the zip's file name and top folder); default: the policy's `export.packageName` */
  name?: string | null;
}

export interface ExportPackageResult {
  zip: Buffer;
  fileName: string;
  /** Assets the layout has no place for (export.not-placed) */
  warnings: ValidationResult[];
  /** Every result: snapshot conversion, placement, build and package checks */
  results: ValidationResult[];
  /** True when every asset was placed and the package checks passed */
  ok: boolean;
  ref: ExportRef;
  layout: string;
  assets: number;
  sha256: string;
}

/** What an export would contain, for the export dialog. Nothing is downloaded or audited. */
export interface ExportPreview {
  /** The package checks passed */
  ok: boolean;
  /** Why the download is refused (policy `export.blockOnFailedChecks`), or null when it is allowed */
  blockedReason: string | null;
  ref: ExportRef;
  layout: string;
  layoutLabel: string;
  packageName: string;
  fileName: string;
  /** Assets placed in the package, per type in asset-types.yaml order */
  included: TypeCount[];
  /** Assets the layout has no place for, per type */
  leftOut: TypeCount[];
  /** Where metadata the files can't carry goes (the layout's manifest), or null */
  manifest: string | null;
  /** For Agent Space folder layouts: the descriptor in each asset folder and the folder index; null otherwise */
  assetFolders?: { descriptor: string; index: string | null } | null;
  errors: ValidationResult[];
  warnings: ValidationResult[];
}

interface BuiltExport {
  exported: ReturnType<typeof exportPackageZip>;
  desired: ReturnType<typeof snapshotsToDesiredAssets>;
  ref: ExportRef;
  layout: PackageLayout;
  packageName: string;
  policy: Policy;
}

/**
 * Resolve the ref and the layout, read the space at that commit and build
 * the package. Refusals are PackageIoError; `onRefused` sees them first.
 */
async function buildExport(space: Space, request: ExportPackageRequest, onRefused?: (err: PackageIoError, requestedRef: string) => Promise<void>): Promise<BuiltExport> {
  const { policy } = await policyForSpace(space);
  const requestedRef = request.ref?.trim() || "HEAD";
  let layout: PackageLayout;
  let ref: ExportRef | null;
  let repo: SpaceRepo;
  try {
    layout = resolveLayout(policy, request.layout);
    repo = await openSpaceHistoryRepo(space, policy.historyLayout);
    if (!repo.ok) throw new PackageIoError("no-history", repo.message);
    ref = await resolveExportRef(repo.repo, policy.historyLayout, space.alias, requestedRef);
    if (!ref) throw new PackageIoError("unknown-ref", `${JSON.stringify(requestedRef)} is not a commit or a release of this space.`);
  } catch (err) {
    if (err instanceof PackageIoError && onRefused) await onRefused(err, requestedRef);
    throw err;
  }

  const snapshots = await readSnapshotsAtCommit(repo.repo, policy.historyLayout, space.alias, ref.commit, policy.packageIo.export.gitReadConcurrency);
  const desired = snapshotsToDesiredAssets(snapshots, policy);
  const requestedName = request.name?.trim() ? safeSegment(request.name.trim().replace(/\.zip$/i, "")) : "";
  const packageName = requestedName || safeSegment(fill(policy.packageIo.export.packageName, { spaceAlias: space.alias, ref: ref.label, layout: layout.name }));
  const exported = exportPackageZip(desired.assets, layout, { policy, packageName });
  return { exported, desired, ref, layout, packageName, policy };
}

/**
 * The space's state at a git ref as a package zip in a layout, read from the
 * history repository. Needs `history.read` on the space.
 */
export async function exportPackage(space: Space, request: ExportPackageRequest, actor: ServiceActor): Promise<ExportPackageResult> {
  const { exported, desired, ref, layout, policy } = await buildExport(space, request, (err, requestedRef) =>
    recordAuditEvent({
      actor,
      action: "package.export",
      spaceId: space.id,
      targetType: "package_export",
      result: "error",
      details: { ref: requestedRef.slice(0, 200), layout: request.layout ?? null, code: err.code },
    }),
  );
  const warnings = exported.results.filter((r) => r.code === "export.not-placed");
  const sha256 = sha256Hex(exported.zip);
  const blocked = !exported.ok && policy.packageIo.export.blockOnFailedChecks;
  await recordAuditEvent({
    actor,
    action: "package.export",
    spaceId: space.id,
    targetType: "package_export",
    targetId: ref.commit,
    result: blocked ? "error" : "ok",
    details: {
      ref: ref.ref,
      refKind: ref.kind,
      commit: ref.commit,
      layout: layout.name,
      fileName: exported.fileName,
      sha256,
      sizeBytes: exported.zip.length,
      assets: desired.assets.length,
      notPlaced: warnings.length,
      ok: exported.ok,
      ...(blocked ? { code: "checks-failed" } : {}),
    },
  });
  if (blocked) {
    const errors = [...desired.results, ...exported.results].filter((r) => r.level === "error");
    throw new PackageIoError("checks-failed", checksFailedMessage(errors.length), errors);
  }
  return {
    zip: exported.zip,
    fileName: exported.fileName,
    warnings,
    results: [...desired.results, ...exported.results],
    ok: exported.ok,
    ref,
    layout: layout.name,
    assets: desired.assets.length,
    sha256,
  };
}

/** Why a download is refused: "The package doesn't pass its checks: 3 errors." */
export function checksFailedMessage(errors: number): string {
  return `The package doesn't pass its checks: ${errors} ${errors === 1 ? "error" : "errors"}.`;
}

const typeOfKey = (assetKey: string | undefined) => (assetKey ? assetKey.slice(0, assetKey.indexOf(":")) : "");

/** Count noun from asset-types.yaml ("1 instruction file", "4 skills"); the lowercase label without one. */
export function assetTypeNoun(policy: Pick<Policy, "assetTypes">, assetType: string, n: number): string {
  const t = policy.assetTypes.assetTypes[assetType];
  const one = t?.noun?.one ?? (t?.label ?? assetType).toLowerCase();
  return n === 1 ? one : (t?.noun?.other ?? `${one}s`);
}

export interface TypeCount {
  assetType: string;
  count: number;
  /** Count noun for the count ("skills", "memory store") */
  noun: string;
}

function countByType(policy: Pick<Policy, "assetTypes">, types: readonly string[]): TypeCount[] {
  const counts = new Map<string, number>();
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  const order = Object.keys(policy.assetTypes.assetTypes);
  const rank = (t: string) => (order.includes(t) ? order.indexOf(t) : order.length);
  return [...counts.entries()]
    .map(([assetType, count]) => ({ assetType, count, noun: assetTypeNoun(policy, assetType, count) }))
    .sort((a, b) => rank(a.assetType) - rank(b.assetType) || a.assetType.localeCompare(b.assetType));
}

/** The facts of an export for the dialog: what goes in, what is left out, and whether the checks pass. */
export async function previewExport(space: Space, request: ExportPackageRequest): Promise<ExportPreview> {
  const { exported, desired, ref, layout, packageName, policy } = await buildExport(space, request);
  const results = [...desired.results, ...exported.results];
  const notPlaced = new Set(exported.results.filter((r) => r.code === "export.not-placed").map((r) => r.assetKey));
  const placed = desired.assets.filter((d) => !notPlaced.has(assetKeyOf(d)));
  const errors = results.filter((r) => r.level === "error");
  return {
    ok: exported.ok,
    blockedReason: !exported.ok && policy.packageIo.export.blockOnFailedChecks ? checksFailedMessage(errors.length) : null,
    ref,
    layout: layout.name,
    layoutLabel: layout.label,
    packageName,
    fileName: exported.fileName,
    included: countByType(policy, placed.map((d) => d.assetType)),
    leftOut: countByType(policy, [...notPlaced].map(typeOfKey).filter(Boolean)),
    manifest: layout.manifest,
    assetFolders: layout.assetFolders ? { descriptor: layout.assetFolders.descriptor, index: layout.assetFolders.index } : null,
    errors,
    warnings: results.filter((r) => r.level === "warning"),
  };
}

/** Response headers for the download Route Handler. */
export function exportDownloadHeaders(result: Pick<ExportPackageResult, "fileName" | "zip" | "sha256">): Record<string, string> {
  const ascii = result.fileName.replace(/[^\w.@+-]/g, "_") || "package.zip";
  return {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${ascii}"`,
    "Content-Length": String(result.zip.length),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Package-Sha256": result.sha256,
  };
}
