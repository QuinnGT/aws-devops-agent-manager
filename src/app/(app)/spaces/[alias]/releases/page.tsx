import { Upload } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { Callout } from "@/components/common/callout";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { RoleNote } from "@/components/common/role-note";
import { Time } from "@/components/common/time";
import { ExportPackageButton } from "@/components/package-io/export-dialog";
import { CreateReleaseButton } from "@/components/releases/create-release-button";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, requireUserOrRedirect, roleFor } from "@/server/auth/dal";
import { roleNote } from "@/server/auth/role-words";
import { countAssetsByType } from "@/server/assets/queries";
import { decodeParam, firstParam } from "@/server/assets/guard";
import { PACKAGE_IO_PERMISSIONS } from "@/server/package-io";
import { loadExportOptions } from "@/server/package-io/loaders";
import { getAppPolicy } from "@/server/policy";
import { loadReleaseList, RELEASE_PERMISSIONS, RELEASE_SENTENCE } from "@/server/releases";
import { getHistoryRepoForSpace, getSpaceByAlias } from "@/server/spaces/queries";

/** Rows before "Show more" (MASTER "Tables"). */
const PAGE_ROWS = 50;
const COMMIT_PARAM = /^[0-9a-f]{7,64}$/i;
const PLAN_PARAM = /^[A-Za-z0-9-]{1,200}$/;

export default async function ReleasesPage({ params, searchParams }: PageProps<"/spaces/[alias]/releases">) {
  const user = await requireUserOrRedirect();
  const { alias } = await params;
  const space = await getSpaceByAlias(decodeParam(alias));
  if (!space || !(await can(user, RELEASE_PERMISSIONS.read, space.id))) notFound();

  const sp = await searchParams;
  const [view, canCreate, canManage, role, exportOptions, repoRow, byType, canImport] = await Promise.all([
    loadReleaseList(space),
    can(user, RELEASE_PERMISSIONS.create, space.id),
    can(user, "spaces.manage", space.id),
    roleFor(user, space.id),
    loadExportOptions(space),
    getHistoryRepoForSpace(space),
    countAssetsByType(space.id),
    can(user, PACKAGE_IO_PERMISSIONS.import, space.id),
  ]);
  const liveAssets = Object.values(byType).reduce((n, c) => n + c, 0);
  const base = `/spaces/${encodeURIComponent(space.alias)}/releases`;
  const showAll = firstParam(sp.show) === "all";
  const rows = showAll ? view.releases : view.releases.slice(0, PAGE_ROWS);

  // Tag after apply: /releases?create=1&commit=<hash>&planId=<id> opens the dialog prefilled.
  const commitParam = firstParam(sp.commit);
  const planParam = firstParam(sp.planId);
  const commit = commitParam && COMMIT_PARAM.test(commitParam) ? commitParam.toLowerCase() : null;
  const planId = commit && planParam && PLAN_PARAM.test(planParam) ? planParam : null;
  const openCreate = firstParam(sp.create) === "1";

  const create = canCreate ? (
    <CreateReleaseButton space={space} view={view} repoName={repoRow?.name ?? null} liveAssets={liveAssets} canManage={canManage} initialOpen={openCreate} commit={commit} planId={planId} />
  ) : null;
  const count = view.releases.length;
  // MASTER hides an action the role can never perform; the note says why it's missing.
  const roleText = roleNote(getAppPolicy().policy, role, RELEASE_PERMISSIONS.create, "create releases");

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={[{ label: "Releases" }]} />
      <PageHeader
        title="Releases"
        description={RELEASE_SENTENCE}
        actions={
          <>
            {/* Package import sits next to export, with the same permission as on Plans. */}
            {canImport ? (
              <Link href={`/spaces/${encodeURIComponent(space.alias)}/plans/import`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                <Upload aria-hidden />
                Import package
              </Link>
            ) : null}
            <ExportPackageButton alias={space.alias} options={exportOptions} initialRef="HEAD" label="Export package" showCodes={canManage} />
            {create}
          </>
        }
      />
      <RoleNote text={roleText} alias={space.alias} />

      {!view.repo.ok ? (
        <Callout tone="info" title="Releases need a history repository">
          {view.repo.message}
        </Callout>
      ) : null}

      {count === 0 ? (
        <Card className="gap-0 py-0">
          <EmptyState
            title="No releases yet"
            action={canCreate ? <CreateReleaseButton space={space} view={view} repoName={repoRow?.name ?? null} liveAssets={liveAssets} canManage={canManage} /> : undefined}
          >
            Create one before a risky change, and you can go back to it in one plan.
          </EmptyState>
        </Card>
      ) : (
        <Card className="gap-0 py-0" role="region" aria-labelledby="releases-title">
          <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-2">
            <h2 id="releases-title" className="text-sm font-semibold tabular-nums">
              {count} {count === 1 ? "release" : "releases"}
            </h2>
            {repoRow ? (
              <span className="text-xs text-muted-foreground">
                Saved in the history repository <span className="font-mono">{repoRow.name}</span>
              </span>
            ) : null}
          </div>
          <Table>
            <TableHeader className="sticky top-0 bg-muted/50">
              <TableRow>
                <TableHead className="pl-4">Release</TableHead>
                <TableHead className="text-right">Assets</TableHead>
                <TableHead className="text-right">Changes since</TableHead>
                <TableHead>Created by</TableHead>
                <TableHead className="pr-4 text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={r.id}>
                  <TableCell className="py-2 pl-4">
                    <div className="flex items-center gap-2">
                      <Link href={`${base}/${encodeURIComponent(r.name)}`} className="inline-flex min-h-6 items-center font-semibold underline-offset-4 hover:underline">
                        {r.name}
                      </Link>
                      {i === 0 ? <Badge variant="outline">Latest</Badge> : null}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">{r.tag}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.assetCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.changesSince ?? 0}</TableCell>
                  <TableCell>{r.createdBy}</TableCell>
                  <TableCell className="pr-4 text-right">
                    <Time value={r.createdAt} format="datetime" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!showAll && count > PAGE_ROWS ? (
            <div className="border-t px-4 py-2 text-center">
              <Link href={`${base}?show=all`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Show {count - PAGE_ROWS} more
              </Link>
            </div>
          ) : null}
        </Card>
      )}
    </div>
  );
}
