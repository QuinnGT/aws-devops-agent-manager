import { CircleCheck, CircleX, Package, TriangleAlert, Upload } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment, type ReactNode } from "react";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { Callout } from "@/components/common/callout";
import { ChangeChip } from "@/components/common/change-chip";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { RoleNote } from "@/components/common/role-note";
import { SectionCard } from "@/components/common/section-card";
import { StatTile } from "@/components/common/stat-tile";
import { StatusBadge } from "@/components/common/status-badge";
import { validationStatus } from "@/components/common/status-words";
import { Time } from "@/components/common/time";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { can, requireUserOrRedirect, roleFor } from "@/server/auth/dal";
import { roleNote } from "@/server/auth/role-words";
import { decodeParam } from "@/server/assets/guard";
import { policyForSpace } from "@/server/journals/policy";
import { assetTypeNoun, loadImportDetail, PACKAGE_IO_PERMISSIONS, validationFailedText, type ImportDetail, type ImportItemGroup } from "@/server/package-io";
import type { PlanTypeOption } from "@/server/package-io/loaders";
import { formatBytes, joinAnd } from "@/server/package-io/format";
import { assetLabel } from "@/server/history/display-name";
import type { Policy } from "@/server/policy";
import { getSpaceByAlias } from "@/server/spaces/queries";
import { CreatePlanForm } from "../_components/create-plan-form";
import { ImportResults } from "../_components/import-results";
import { LayoutChoice } from "../_components/layout-choice";
import { breakdown, nonAssetSummary, plainResult, typeFileCount, typeResults, typeRows, type TypeRow } from "../_components/mapping";

const PAGE_ROWS = 50;
const UNTOUCHED_NAMES = 6;
const RESULT_ROWS = 50;

function terms(policy: Pick<Policy, "assetTypes">) {
  const noun = (t: string, n: number) => assetTypeNoun(policy, t, n);
  return {
    noun,
    /** "Skills", "Memory stores": the plural count noun, capitalized, as the console names the lists */
    plural: (t: string) => capitalize(noun(t, 2)),
    /** "Instruction file", "Skill" */
    one: (t: string) => capitalize(noun(t, 1)),
  };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A path that wraps after each slash rather than inside a name. */
function PathText({ value }: { value: string }) {
  const parts = value.split("/");
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {p}
          {i < parts.length - 1 ? (
            <>
              /<wbr />
            </>
          ) : null}
        </Fragment>
      ))}
    </>
  );
}

/** Breakdown of one action across types: "5 instruction files, 16 skills". */
function actionBreakdown(d: ImportDetail, action: "create" | "update" | "unchanged", noun: (t: string, n: number) => string): string {
  return breakdown(
    d.groups.map((g) => ({ assetType: g.assetType, count: g.counts[action] })),
    noun,
  );
}

function ChangeCell({ row, plain }: { row: TypeRow; plain: (message: string) => string }) {
  const c = row.change;
  if (c.word === "create") return <ChangeChip word="create" />;
  if (c.word === "unchanged") return <ChangeChip word="unchanged" />;
  if (c.word === "not-imported") return <ChangeChip word="skip-live-changed" label="Not imported" />;
  if (c.word === "left-out") {
    return (
      <div className="max-w-[320px]">
        <ChangeChip word="skip-live-changed" label="Left out" />
        <p className="text-xs break-words whitespace-normal text-muted-foreground">{plain(c.reason)}</p>
      </div>
    );
  }
  const label = c.from !== null ? `Update v${c.from} → v${c.from + 1}` : "Update";
  return (
    <div>
      <ChangeChip word="update-content" label={label} />
      {c.added !== null && c.removed !== null ? (
        <p className="font-mono text-xs font-semibold tabular-nums">
          <span className="text-success-fg">+{c.added}</span> <span className="text-destructive-fg">−{c.removed}</span>
          <span className="sr-only"> lines</span>
        </p>
      ) : null}
      {!c.contentChanged && c.metadataKeys.length ? <p className="text-xs text-muted-foreground">Metadata: {c.metadataKeys.join(", ")}</p> : null}
      {!c.committed ? <p className="text-xs text-muted-foreground">No committed version to compare</p> : null}
    </div>
  );
}

/** The type table's Validation cell, counted like the type's checkbox: assets with errors, then errors; else warnings or Passed. */
function TypeValidation({ option, results }: { option: PlanTypeOption | undefined; results: ImportDetail["validation"]["errors"] }) {
  if (!option) return <StatusBadge {...validationStatus(results)} />;
  const n = (k: number, one: string, other: string) => `${k} ${k === 1 ? one : other}`;
  if (option.errors > 0) {
    return (
      <div className="space-y-0.5">
        <StatusBadge tone="destructive" icon={CircleX} label={option.failedAssets > 0 ? `${option.failedAssets} with errors` : n(option.errors, "error", "errors")} />
        {option.failedAssets > 0 ? <p className="text-xs text-muted-foreground tabular-nums">{n(option.errors, "error", "errors")}</p> : null}
      </div>
    );
  }
  const warnings = option.warnings ?? 0;
  return warnings ? <StatusBadge tone="warning" icon={TriangleAlert} label={n(warnings, "warning", "warnings")} /> : <StatusBadge {...validationStatus([])} />;
}

function TypeTable({
  alias,
  detail,
  group,
  title,
  dir,
  rowsShown,
  typeHref,
  policy,
}: {
  alias: string;
  detail: ImportDetail;
  group: ImportItemGroup;
  title: string;
  dir: string | null;
  rowsShown: number;
  typeHref: (t: string, rows?: number) => string;
  policy: Pick<Policy, "agentTypes" | "historyLayout" | "assetTypes">;
}) {
  const rows = typeRows(detail, group);
  const shown = rows.slice(0, rowsShown);
  const files = typeFileCount(detail, group);
  const plain = (message: string) => plainResult(policy, { level: "warning", code: "", message, assetKey: `${group.assetType}:` }).text.replace(/^: /, "");
  return (
    <SectionCard
      id="import-type-h"
      title={`${title} · ${files} ${files === 1 ? "file" : "files"}`}
      aside={
        dir ? (
          <span className="text-xs text-muted-foreground">
            From <span className="font-mono">{dir}/</span>
          </span>
        ) : null
      }
    >
      <Table className="min-w-[640px]">
        <TableHeader className="sticky top-0 bg-muted/60">
          <TableRow>
            <TableHead className="px-4">File</TableHead>
            <TableHead>Asset</TableHead>
            <TableHead>Change</TableHead>
            <TableHead className="text-right">Size</TableHead>
            <TableHead className="pr-4">Validation</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((r) => (
            <TableRow key={r.key} className="align-top">
              <TableCell className="max-w-[280px] px-4 py-2 font-mono text-xs break-words whitespace-normal">
                <PathText value={r.file} />
              </TableCell>
              <TableCell className="max-w-[320px] py-2 break-words whitespace-normal">
                {r.asset === null ? (
                  <span className="text-muted-foreground">None</span>
                ) : r.assetId ? (
                  <Link href={`/spaces/${encodeURIComponent(alias)}/assets/${encodeURIComponent(r.assetId)}`} className="inline-block min-h-6 py-0.5 font-semibold underline-offset-4 hover:underline">
                    <PathText value={assetLabel(policy, { assetType: group.assetType, name: r.asset })} />
                  </Link>
                ) : (
                  <span className="font-semibold">
                    <PathText value={assetLabel(policy, { assetType: group.assetType, name: r.asset })} />
                  </span>
                )}
              </TableCell>
              <TableCell className="py-2">
                <ChangeCell row={r} plain={plain} />
              </TableCell>
              <TableCell className="py-2 text-right tabular-nums">
                {r.size !== null ? formatBytes(r.size) : null}
                {r.lines !== null ? <p className="text-xs text-muted-foreground">{r.lines} lines</p> : null}
              </TableCell>
              <TableCell className="py-2 pr-4">
                <StatusBadge {...validationStatus(r.results)} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rows.length > shown.length ? (
        <div className="border-t px-4 py-2 text-center">
          <Link href={typeHref(group.assetType, rowsShown + PAGE_ROWS)} scroll={false} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Show more ({rows.length - shown.length} left)
          </Link>
        </div>
      ) : null}
    </SectionCard>
  );
}

/**
 * The mapping result of one import (pages/package-import.md, "Mapping
 * result"). Reading needs PACKAGE_IO_PERMISSIONS.read; a role that can't
 * create the plan reads why where the form would be. 404 when the import
 * isn't in this space.
 */
export default async function ImportResultPage({ params, searchParams }: PageProps<"/spaces/[alias]/plans/import/[importId]">) {
  const user = await requireUserOrRedirect();
  const { alias, importId } = await params;
  const space = await getSpaceByAlias(decodeParam(alias));
  if (!space || !(await can(user, PACKAGE_IO_PERMISSIONS.read, space.id))) notFound();
  const detail = await loadImportDetail(space, decodeParam(importId));
  if (!detail) notFound();
  const { policy } = await policyForSpace(space);
  const t = terms(policy);
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  const base = `/spaces/${encodeURIComponent(space.alias)}`;
  const self = `${base}/plans/import/${detail.import.id}`;
  const typeHref = (type: string, rows?: number) => `${self}?type=${encodeURIComponent(type)}${rows ? `&rows=${rows}` : ""}`;
  const selected = detail.groups.find((g) => g.assetType === one(sp.type)) ?? detail.groups[0] ?? null;
  const rowsParam = Number(one(sp.rows));
  const rowsShown = Number.isInteger(rowsParam) && rowsParam > PAGE_ROWS ? Math.min(rowsParam, 5000) : PAGE_ROWS;

  const im = detail.import;
  const counts = detail.summary?.counts ?? { create: 0, update: 0, unchanged: 0, untouched: 0, errors: 0, warnings: 0 };
  const results = [...detail.validation.errors, ...detail.validation.warnings].map((r) => plainResult(policy, r));
  const totalFiles = detail.files.reduce((n, g) => n + g.files.length, 0);
  const updates = detail.groups.flatMap((g) => g.items.filter((i) => i.action === "update").map((i) => `${t.one(g.assetType)} ${i.key}`));
  const dirs = detail.layout?.typeDirs ?? {};
  const roleFiles = (role: string) => detail.files.find((g) => g.role === role)?.files ?? [];
  const [canPlan, role] = await Promise.all([can(user, PACKAGE_IO_PERMISSIONS.plan, space.id), roleFor(user, space.id)]);
  const planType = new Map(detail.planTypes.types.map((o) => [o.assetType, o]));
  const leftOutByType = new Map<string, number>();
  for (const l of detail.leftOut) leftOutByType.set(l.assetType, (leftOutByType.get(l.assetType) ?? 0) + 1);
  const layoutReason = !detail.layouts.canChange
    ? detail.plan.planId || im.status === "planning"
      ? "A plan exists from this import. Upload the package again to read it another way."
      : "The upload is no longer stored. Upload the package again."
    : null;

  const callouts: ReactNode[] = [];
  if (im.status === "rejected") {
    callouts.push(
      <Callout key="rejected" tone="destructive" title="The package was rejected">
        Fix the package and upload it again.
      </Callout>,
    );
  } else if (im.status === "failed") {
    callouts.push(
      <Callout key="failed" tone="destructive" title="The package could not be mapped">
        {detail.validation.errors[0]?.message ?? "Upload it again."}
      </Callout>,
    );
  } else if (counts.errors > 0) {
    const selectable = detail.planTypes.unattributedErrors === 0 && detail.planTypes.types.some((ty) => ty.errors === 0 && ty.changes > 0);
    const failingTypes = detail.planTypes.types.filter((ty) => ty.errors > 0).map((ty) => ty.nounOther);
    callouts.push(
      <Callout key="errors" tone="destructive" title={`${validationFailedText(detail.failedAssets, counts.errors)}.`}>
        {failingTypes.length ? `The errors are in ${joinAnd(failingTypes)}. ` : null}
        {selectable ? "Fix the package and upload it again, or leave the asset types with errors out of the plan." : "Fix the package and upload it again."}
      </Callout>,
    );
  }
  if (detail.plan.planId) {
    callouts.push(
      <Callout
        key="planned"
        tone="info"
        title="A plan was created from this import"
        action={
          <Link href={`${base}/plans/${detail.plan.planId}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Open the plan
          </Link>
        }
      >
        {im.plannedAt ? (
          <>
            Created <Time value={im.plannedAt} format="datetime" />
            {im.plannedBy ? ` by ${im.plannedBy}` : null}.
          </>
        ) : null}
      </Callout>,
    );
  } else if (!im.uploadAvailable && im.status !== "rejected") {
    callouts.push(
      <Callout key="expired" tone="warning" title="The uploaded file was deleted after its retention period">
        Upload the package again to create a plan.
      </Callout>,
    );
  }

  // One definition per number: assets with errors, then errors and warnings.
  const validationTile =
    counts.errors > 0 ? (
      <span className="flex items-center gap-2 text-destructive-fg">
        <CircleX aria-hidden />
        {detail.failedAssets > 0 ? `${detail.failedAssets} with errors` : `${counts.errors} ${counts.errors === 1 ? "error" : "errors"}`}
      </span>
    ) : (
      <span className="flex items-center gap-2">
        <CircleCheck className="text-success-fg" aria-hidden />
        Passed
      </span>
    );

  const roleRows: { role: string; count: number; label: string; text: string }[] = [];
  const assetFiles = roleFiles("asset").length;
  if (assetFiles) roleRows.push({ role: "asset", count: assetFiles, label: `${assetFiles} asset ${assetFiles === 1 ? "file" : "files"}`, text: "Uploaded as instructions, skills, stores and memories" });
  const build = roleFiles("build-artifact").length;
  if (build) roleRows.push({ role: "build-artifact", count: build, label: `${build} build ${build === 1 ? "file" : "files"}`, text: "Packed skills and lists of memories, built again from the source files" });
  const nonAssets = roleFiles("non-asset");
  if (nonAssets.length)
    roleRows.push({ role: "non-asset", count: nonAssets.length, label: `${nonAssets.length} not assets`, text: joinAnd(nonAssetSummary(nonAssets.map((f) => f.path), detail.layout?.nonAssets ?? [])) });
  const manifest = roleFiles("manifest");
  if (manifest.length) roleRows.push({ role: "manifest", count: manifest.length, label: `${manifest.length} manifest`, text: joinAnd(manifest.map((f) => f.path)) });
  const skipped = roleFiles("skipped");
  if (skipped.length) roleRows.push({ role: "skipped", count: skipped.length, label: `${skipped.length} skipped`, text: joinAnd(skipped.map((f) => f.path.split("/").pop() ?? f.path)) });
  const unmapped = roleFiles("unmapped");
  if (unmapped.length) roleRows.push({ role: "unmapped", count: unmapped.length, label: `${unmapped.length} not mapped`, text: `Not in the layout, so not uploaded: ${joinAnd(unmapped.slice(0, 5).map((f) => f.path))}${unmapped.length > 5 ? ` and ${unmapped.length - 5} more` : ""}` });

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar
        space={space}
        user={user}
        crumbs={[{ label: "Plans", href: `${base}/plans` }, { label: "Import package", href: `${base}/plans/import` }, { label: im.fileName }]}
      />
      <PageHeader
        icon={<Package />}
        title={<span className="break-all">{im.fileName}</span>}
        meta={[
          <span key="files" className="tabular-nums">
            {totalFiles} {totalFiles === 1 ? "file" : "files"} · {formatBytes(im.sizeBytes)}
          </span>,
          `Layout ${im.layoutLabel}${detail.layouts.choice === "detected" ? " (detected)" : ""}`,
          <span key="read">
            Read <Time value={im.analyzedAt ?? im.createdAt} format="datetime" /> by {im.importedBy}
          </span>,
          <span key="sha">
            SHA-256{" "}
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="inline-flex min-h-6 items-center font-mono text-xs underline decoration-dotted underline-offset-4" aria-label={`SHA-256 ${im.sha256}`}>
                  {im.sha256.slice(0, 12)}
                </button>
              </TooltipTrigger>
              <TooltipContent className="font-mono">{im.sha256}</TooltipContent>
            </Tooltip>
          </span>,
        ]}
        actions={
          canPlan ? (
            <Link href={`${base}/plans/import`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              <Upload aria-hidden />
              Upload a different file
            </Link>
          ) : undefined
        }
      />

      {callouts.length ? (
        <section aria-label="Needs attention" className="space-y-2">
          {callouts.slice(0, 3)}
        </section>
      ) : null}

      {im.status === "rejected" ? (
        <SectionCard id="import-results-h" title="Why the upload was rejected" aside={<span className="text-xs text-muted-foreground tabular-nums">{results.length}</span>}>
          <ImportResults results={results.slice(0, RESULT_ROWS)} />
        </SectionCard>
      ) : (
        <>
          <section aria-label="Import summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile icon={null} label="Creates" value={counts.create} detail={counts.create ? actionBreakdown(detail, "create", t.noun) : "Nothing new"} />
            <StatTile
              icon={null}
              label="Updates"
              value={counts.update}
              detail={counts.update === 0 ? "Nothing changes" : updates.length <= 3 ? updates.join(", ") : actionBreakdown(detail, "update", t.noun)}
            />
            <StatTile
              icon={null}
              label="Unchanged"
              value={counts.unchanged}
              detail={`${counts.untouched} live ${counts.untouched === 1 ? "asset isn't" : "assets aren't"} in the package and stay as they are`}
            />
            <StatTile
              icon={null}
              label="Validation"
              value={validationTile}
              detail={`${detail.failedAssets > 0 ? `${detail.failedAssets} ${detail.failedAssets === 1 ? "asset" : "assets"} with errors · ` : ""}${counts.errors} ${counts.errors === 1 ? "error" : "errors"} · ${counts.warnings} ${counts.warnings === 1 ? "warning" : "warnings"}`}
            />
          </section>

          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-4">
              <SectionCard id="import-types-h" title="Assets by type" aside={<span className="text-xs text-muted-foreground tabular-nums">{detail.summary?.assets ?? 0} assets</span>}>
                {detail.groups.length ? (
                  <Table>
                    <TableHeader className="bg-muted/60">
                      <TableRow>
                        <TableHead className="px-4">Type</TableHead>
                        <TableHead className="text-right">Create</TableHead>
                        <TableHead className="text-right">Update</TableHead>
                        <TableHead className="text-right">Unchanged</TableHead>
                        {leftOutByType.size ? <TableHead className="text-right">Left out</TableHead> : null}
                        <TableHead className="pr-4">Validation</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.groups.map((g) => {
                        const isSel = g.assetType === selected?.assetType;
                        return (
                          <TableRow key={g.assetType} className={cn(isSel && "bg-muted/60 shadow-[inset_3px_0_0_var(--color-foreground)]")}>
                            <TableCell className="px-4">
                              <Link href={typeHref(g.assetType)} scroll={false} aria-current={isSel ? "true" : undefined} className="inline-flex min-h-6 items-center font-semibold underline-offset-4 hover:underline">
                                {t.plural(g.assetType)}
                              </Link>
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{g.counts.create}</TableCell>
                            <TableCell className="text-right tabular-nums">{g.counts.update}</TableCell>
                            <TableCell className="text-right tabular-nums">{g.counts.unchanged}</TableCell>
                            {leftOutByType.size ? <TableCell className="text-right tabular-nums">{leftOutByType.get(g.assetType) ?? 0}</TableCell> : null}
                            <TableCell className="pr-4">
                              <TypeValidation option={planType.get(g.assetType)} results={typeResults(detail, g.assetType)} />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                ) : (
                  <EmptyState title="No assets in this package">Check the layout choice, or the package&apos;s folder names, and upload it again.</EmptyState>
                )}
              </SectionCard>
              {selected ? <TypeTable alias={space.alias} detail={detail} group={selected} title={t.plural(selected.assetType)} dir={dirs[selected.assetType] ?? null} rowsShown={rowsShown} typeHref={typeHref} policy={policy} /> : null}
            </div>

            <aside className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1" aria-label="Plan and checks">
              {!canPlan && !detail.plan.planId ? (
                <SectionCard id="import-plan-h" title="Create the import plan">
                  <RoleNote
                    className="grid grid-cols-[auto_minmax(0,1fr)] items-start px-4 py-3 [&>a]:col-start-2 [&>svg]:mt-0.5"
                    text={roleNote(policy, role, PACKAGE_IO_PERMISSIONS.plan, "create the import plan")}
                    alias={space.alias}
                  />
                </SectionCard>
              ) : null}
              {canPlan && !detail.plan.planId ? (
                <SectionCard id="import-plan-h" title="Create the import plan">
                  <CreatePlanForm
                    alias={space.alias}
                    importId={im.id}
                    defaultTitle={detail.plan.defaultTitle}
                    types={detail.planTypes.types}
                    unattributedErrors={detail.planTypes.unattributedErrors}
                    blockOnErrors={detail.planTypes.blockOnErrors}
                    reasonRequired={space.parsedSettings.changeReasonRequired}
                    stateReason={detail.planTypes.stateReason ?? (detail.groups.length === 0 ? (detail.plan.reason ?? "Nothing in this package maps to an asset.") : null)}
                  />
                </SectionCard>
              ) : null}
              {detail.layouts.candidates.length > 1 || detail.layouts.choice ? (
                <SectionCard id="import-layout-h" title="Layout">
                  <LayoutChoice
                    alias={space.alias}
                    importId={im.id}
                    current={im.layout}
                    choice={detail.layouts.choice}
                    candidates={detail.layouts.candidates}
                    disabledReason={canPlan ? layoutReason : "Reading a package again needs a role that can create plans."}
                  />
                </SectionCard>
              ) : null}
              <SectionCard
                id="import-warnings-h"
                title={counts.errors > 0 ? "Errors and warnings" : "Warnings"}
                aside={
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {counts.errors > 0 ? `${counts.errors} ${counts.errors === 1 ? "error" : "errors"}, ` : ""}
                    {counts.warnings} {counts.warnings === 1 ? "warning" : "warnings"}
                  </span>
                }
              >
                <ImportResults results={results.slice(0, RESULT_ROWS)} />
                {results.length > RESULT_ROWS ? <p className="border-t px-4 py-2 text-xs text-muted-foreground">and {results.length - RESULT_ROWS} more</p> : null}
              </SectionCard>
              <SectionCard id="import-roles-h" title="File roles" aside={<span className="text-xs text-muted-foreground tabular-nums">{totalFiles} files</span>}>
                <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 px-4 py-3 text-[13px]">
                  {roleRows.map((r) => (
                    <div key={r.role} className="contents">
                      <dt className="font-semibold tabular-nums">{r.label}</dt>
                      <dd className="break-words text-muted-foreground">{r.text}</dd>
                    </div>
                  ))}
                </dl>
              </SectionCard>
              {detail.untouched.length ? (
                <SectionCard id="import-untouched-h" title="Live assets not in the package" aside={<span className="text-xs text-muted-foreground tabular-nums">{counts.untouched}</span>}>
                  <div className="space-y-2 px-4 py-3 text-[13px]">
                    <p className="text-muted-foreground">They stay as they are. An import never deletes or deactivates assets.</p>
                    {detail.untouched.map((g) => (
                      <p key={g.assetType} className="break-words">
                        <span className="font-semibold">
                          {g.assets.length} {t.noun(g.assetType, g.assets.length)}:
                        </span>{" "}
                        {g.assets.slice(0, UNTOUCHED_NAMES).map((a, i) => (
                          <Fragment key={a.assetId}>
                            {i > 0 ? ", " : null}
                            <Link href={`${base}/assets/${encodeURIComponent(a.assetId)}`} className="inline-block min-h-6 underline-offset-4 hover:underline">
                              <PathText value={assetLabel(policy, { assetType: g.assetType, name: a.name, assetId: a.assetId })} />
                            </Link>
                          </Fragment>
                        ))}
                        {g.assets.length > UNTOUCHED_NAMES ? <span className="text-muted-foreground"> and {g.assets.length - UNTOUCHED_NAMES} more</span> : null}
                      </p>
                    ))}
                  </div>
                </SectionCard>
              ) : null}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
