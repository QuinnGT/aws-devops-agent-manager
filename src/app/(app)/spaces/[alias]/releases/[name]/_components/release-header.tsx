import { Tag, Undo2 } from "lucide-react";
import Link from "next/link";
import { DisabledReason } from "@/components/common/disabled-reason";
import { LinkTabs } from "@/components/common/link-tabs";
import { PageHeader } from "@/components/common/page-header";
import { Time } from "@/components/common/time";
import { ExportPackageButton } from "@/components/package-io/export-dialog";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import type { loadExportOptions } from "@/server/package-io/loaders";
import { RELEASE_SENTENCE, type ReleasePageView } from "@/server/releases";

/**
 * The release page header, shared by its two tabs (releases.md "Release
 * detail", release-verification.md "Changes to the release page"), and the
 * tabs under it.
 */

export function releaseDifferences(view: Pick<ReleasePageView, "counts">): number {
  return view.counts.changed + view.counts.removed + view.counts.added;
}

export function ReleaseHeader({
  alias,
  view,
  canRollback,
  canManage,
  exportOptions,
}: {
  alias: string;
  view: ReleasePageView;
  canRollback: boolean;
  canManage: boolean;
  exportOptions: Awaited<ReturnType<typeof loadExportOptions>>;
}) {
  const { release } = view;
  const base = `/spaces/${encodeURIComponent(alias)}/releases`;
  const rollback = canRollback ? (
    releaseDifferences(view) === 0 && view.manifestOk ? (
      <DisabledReason reason={`Nothing to restore: the live space matches ${release.name}.`}>
        <Button>
          <Undo2 aria-hidden />
          Restore this release
        </Button>
      </DisabledReason>
    ) : (
      <Link href={`${base}/${encodeURIComponent(release.name)}/rollback`} className={buttonVariants()}>
        <Undo2 aria-hidden />
        Restore this release
      </Link>
    )
  ) : null;

  return (
    <PageHeader
      icon={<Tag />}
      title={release.name}
      badges={view.latest ? <Badge variant="outline">Latest</Badge> : undefined}
      description={release.note ?? RELEASE_SENTENCE}
      meta={[
        <>
          Created <Time value={release.createdAt} format="datetime" /> by {release.createdBy}
        </>,
        `${release.assetCount} ${release.assetCount === 1 ? "asset" : "assets"}`,
        <>
          Tag <span className="font-mono text-xs">{release.tag}</span>
        </>,
        <>
          Commit <span className="font-mono text-xs">{release.commit.slice(0, 7)}</span>
        </>,
      ]}
      actions={
        <>
          <ExportPackageButton alias={alias} options={exportOptions} initialRef={release.tag} label="Export as package" showCodes={canManage} />
          {rollback}
        </>
      }
    />
  );
}

export function ReleaseTabs({ alias, view, current }: { alias: string; view: ReleasePageView; current: "assets" | "verification" }) {
  const href = `/spaces/${encodeURIComponent(alias)}/releases/${encodeURIComponent(view.release.name)}`;
  return (
    <LinkTabs
      label="Release sections"
      current={current}
      items={[
        { key: "assets", href, label: "Assets and changes since", count: releaseDifferences(view) },
        { key: "verification", href: `${href}/verification`, label: "Verification" },
      ]}
    />
  );
}
