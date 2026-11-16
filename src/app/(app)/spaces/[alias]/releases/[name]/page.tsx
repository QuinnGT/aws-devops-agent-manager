import Link from "next/link";
import { notFound } from "next/navigation";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { Callout } from "@/components/common/callout";
import { EmptyState } from "@/components/common/empty-state";
import { StatTile } from "@/components/common/stat-tile";
import { LastChangeCell, metadataChangeText, ReleaseChangeChip, ShortHash, VersionStatus } from "@/components/releases/release-cells";
import { ShowToggle } from "@/components/releases/show-toggle";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, requireUserOrRedirect } from "@/server/auth/dal";
import { decodeParam, firstParam } from "@/server/assets/guard";
import { loadExportOptions } from "@/server/package-io/loaders";
import { loadReleasePage, RELEASE_PERMISSIONS, type ReleaseChangeCounts, type ReleaseTableRow } from "@/server/releases";
import { getAppPolicy } from "@/server/policy";
import { getSpaceByAlias } from "@/server/spaces/queries";
import { ReleaseHeader, ReleaseTabs } from "./_components/release-header";

function changedDetail(c: ReleaseChangeCounts): string {
  const parts = [c.content ? `${c.content} content` : null, c.status ? `${c.status} status` : null, c.metadata ? `${c.metadata} metadata` : null].filter(Boolean);
  return parts.length ? parts.join(", ") : "No content, status or metadata changes";
}

/**
 * What restoring the release does with the assets added since, per policy
 * releases.rollback.addedAfterTarget: types with supportsStatus that
 * deactivate are set Inactive, the rest are kept (or deleted when policy says so).
 */
function addedSinceDetail(rows: readonly ReleaseTableRow[]): string {
  const policy = getAppPolicy().policy;
  const r = policy.releases.rollback;
  const added = rows.filter((x) => x.change === "added");
  const actionOf = (t: string) => {
    const a = r.addedAfterTarget[t] ?? r.addedAfterTarget.default ?? "keep";
    return a === "deactivate" && !policy.assetTypes.assetTypes[t]?.supportsStatus ? "keep" : a;
  };
  const n = { deactivate: 0, keep: 0, delete: 0 };
  for (const x of added) n[actionOf(x.assetType)]++;
  if (!added.length || n.deactivate === added.length) return "Restore sets it Inactive";
  if (n.delete === added.length) return "Restore deletes it";
  if (n.keep === added.length) return "Restore leaves it as it is";
  return [n.deactivate ? `Restore sets ${n.deactivate} Inactive` : null, n.delete ? `deletes ${n.delete}` : null, n.keep ? `leaves ${n.keep} as ${n.keep === 1 ? "it is" : "they are"}` : null]
    .filter(Boolean)
    .join(", ")
    .replace(/^deletes/, "Restore deletes")
    .replace(/^leaves/, "Restore leaves");
}

function AssetCell({ row, href }: { row: ReleaseTableRow; href: string | null }) {
  return (
    <div className="min-w-0">
      {href ? (
        <Link href={href} className="inline-flex min-h-6 items-center font-semibold break-words underline-offset-4 hover:underline">
          {row.name}
        </Link>
      ) : (
        <span className="font-semibold break-words">{row.name}</span>
      )}
      <div className="text-xs text-muted-foreground">{row.parentName ? `${row.typeLabel} in ${row.parentName}` : row.typeLabel}</div>
    </div>
  );
}

export default async function ReleaseDetailPage({ params, searchParams }: PageProps<"/spaces/[alias]/releases/[name]">) {
  const user = await requireUserOrRedirect();
  const { alias, name: rawName } = await params;
  const space = await getSpaceByAlias(decodeParam(alias));
  if (!space || !(await can(user, RELEASE_PERMISSIONS.read, space.id))) notFound();
  const name = decodeParam(rawName);
  if (name.length > 200) notFound();

  const [view, canRollback, canManage, exportOptions] = await Promise.all([
    loadReleasePage(space, name),
    can(user, RELEASE_PERMISSIONS.planRollback, space.id),
    can(user, "spaces.manage", space.id),
    loadExportOptions(space),
  ]);
  if (!view) notFound();

  const sp = await searchParams;
  const show = firstParam(sp.show) === "all" ? "all" : "changed";
  const { release, counts, table } = view;
  const spaceBase = `/spaces/${encodeURIComponent(space.alias)}`;
  const base = `${spaceBase}/releases`;
  const shown = show === "all" ? table : table.filter((r) => r.change !== "unchanged");

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={[{ label: "Releases", href: base }, { label: release.name }]} />
      <ReleaseHeader alias={space.alias} view={view} canRollback={canRollback} canManage={canManage} exportOptions={exportOptions} />
      <ReleaseTabs alias={space.alias} view={view} current="assets" />

      {!view.manifestOk ? (
        <Callout tone="destructive" title={`The manifest of ${release.name} can't be read`}>
          The release row in the database holds a manifest this version of the app doesn&apos;t understand. The tag and the manifest file in the history repository are unchanged.
        </Callout>
      ) : null}
      {view.tagPresent === false ? (
        <Callout tone="warning" title={`The tag ${release.tag} is missing`}>
          The history repository on this machine has no tag {release.tag}. Restore reads the assets from commit {release.sourceCommit.slice(0, 7)}, which still works while that commit exists.
        </Callout>
      ) : null}
      {!view.repo.ok ? (
        <Callout tone="info" title="The history repository isn't available">
          {view.repo.message} Content changes are compared by version only.
        </Callout>
      ) : null}

      <section aria-label="Changes since this release" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile icon={null} label="Unchanged" value={counts.unchanged} detail="Same version, content and metadata" />
        <StatTile icon={null} label="Changed" value={counts.changed} detail={changedDetail(counts)} />
        <StatTile icon={null} label="Deleted since" value={<span className={counts.removed > 0 ? "text-destructive-fg" : undefined}>{counts.removed}</span>} detail="Restore creates it again with a new ID" />
        <StatTile icon={null} label="Added since" value={counts.added} detail={addedSinceDetail(table)} />
      </section>

      <Card className="gap-0 py-0" role="region" aria-labelledby="manifest-title">
        <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-4 py-2">
          <h2 id="manifest-title" className="text-sm font-semibold">
            Assets in this release and changes since
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-xs text-muted-foreground break-all">{release.manifestPath}</span>
            <ShowToggle value={show} changed={counts.changed + counts.removed + counts.added} all={table.length} />
          </div>
        </div>
        {shown.length === 0 ? (
          <EmptyState title="The live space matches this release">Every asset has the version, content and metadata pinned in {release.name}.</EmptyState>
        ) : (
          <Table>
            <TableHeader className="sticky top-0 bg-muted/50">
              <TableRow>
                <TableHead className="pl-4">Asset</TableHead>
                <TableHead>In release</TableHead>
                <TableHead>Live now</TableHead>
                <TableHead>Change</TableHead>
                <TableHead className="pr-4">Last change</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r) => {
                const meta = metadataChangeText(r.metadataChanges);
                return (
                  <TableRow key={r.rowKey} className="align-top">
                    <TableCell className="max-w-[320px] min-w-[200px] py-2 pl-4 whitespace-normal">
                      <AssetCell row={r} href={r.liveAssetId ? `${spaceBase}/assets/${encodeURIComponent(r.liveAssetId)}` : null} />
                    </TableCell>
                    <TableCell className="py-2">
                      {r.inRelease ? (
                        <div className="flex flex-col items-start">
                          <VersionStatus version={r.inRelease.version} status={r.inRelease.status} />
                          <ShortHash hash={r.inRelease.contentHash} />
                        </div>
                      ) : (
                        <span className="text-muted-foreground">Not in this release</span>
                      )}
                    </TableCell>
                    <TableCell className="py-2 whitespace-normal">
                      {r.live ? <VersionStatus version={r.live.version} status={r.live.status} /> : <VersionStatus version="deleted" />}
                      {meta ? <div className="font-mono text-xs text-muted-foreground">{meta}</div> : null}
                      {r.pendingSync ? <div className="text-xs text-muted-foreground">Newer live changes wait for the next sync</div> : null}
                    </TableCell>
                    <TableCell className="py-2">
                      <ReleaseChangeChip change={r.change} />
                    </TableCell>
                    <TableCell className="py-2 pr-4">
                      <LastChangeCell change={r.lastChange} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {show === "changed" && counts.unchanged > 0 ? (
          <div className="border-t px-4 py-2 text-center">
            <Link href={`${base}/${encodeURIComponent(release.name)}?show=all`} scroll={false} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Show {counts.unchanged} unchanged {counts.unchanged === 1 ? "asset" : "assets"}
            </Link>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
