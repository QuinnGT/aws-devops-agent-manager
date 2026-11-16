import Link from "next/link";
import type { ReactNode } from "react";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { SyncNowButton } from "@/components/app-shell/sync-now-button";
import { AssetTable, flatItems, memoryItems } from "@/components/assets/asset-table";
import { spaceHref } from "@/components/assets/format";
import { Callout } from "@/components/common/callout";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { SectionCard } from "@/components/common/section-card";
import { buttonVariants } from "@/components/ui/button";
import { can } from "@/server/auth/dal";
import { firstParam, loadSpaceForPage } from "@/server/assets/guard";
import { assetDirectory } from "@/server/assets/queries";
import { loadAssetSections } from "@/server/assets/sections";
import { listDrafts, STATUS_KEY } from "@/server/drafts";
import { statusCellFor } from "./_components/status-cell";

const ghostSm = buttonVariants({ variant: "ghost", size: "sm" });
const outlineSm = buttonVariants({ variant: "outline", size: "sm" });

/** Assets by type in the console's order (design-system MASTER "Page index"). */
export default async function AssetsPage(props: PageProps<"/spaces/[alias]/assets">) {
  const { alias } = await props.params;
  const sp = await props.searchParams;
  const { user, space } = await loadSpaceForPage(alias, "assets.read");
  const includeDeleted = firstParam(sp.deleted) === "1";
  const [view, canDraft, canSync, directory] = await Promise.all([
    loadAssetSections(space, { assetType: firstParam(sp.type) ?? null, includeDeleted }),
    can(user, "drafts.write", space.id),
    can(user, "sync.run", space.id),
    assetDirectory(space.id),
  ]);
  const drafts = canDraft ? await listDrafts(space.id, { createdBy: user.email }) : [];
  const draftStatus = new Map(drafts.flatMap((d) => (d.assetId && typeof d.desired.metadata[STATUS_KEY] === "string" ? [[d.assetId, d.desired.metadata[STATUS_KEY] as string] as const] : [])));
  const status = statusCellFor({
    alias: space.alias,
    canDraft,
    policy: view.policy,
    draftStatus,
    nameOf: (type, id) => {
      const d = directory.get(id);
      return d && d.assetType === type ? d.name : undefined;
    },
  });

  const base = spaceHref(space.alias, "/assets");
  const href = (q: { type?: string | null; deleted?: boolean }) => {
    const p = new URLSearchParams();
    if (q.type) p.set("type", q.type);
    if (q.deleted) p.set("deleted", "1");
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };
  const selected = view.sections.find((s) => s.assetType === view.selectedType) ?? null;
  const total = view.sections.reduce((n, s) => n + s.total, 0);

  const callouts: ReactNode[] = [];
  if (!view.syncState?.lastSyncCompletedAt && view.syncState?.status !== "running") {
    callouts.push(
      <Callout key="never" tone="info" title="Not synced yet" action={canSync ? <SyncNowButton alias={space.alias} /> : undefined}>
        The asset list fills in after the first sync of this space.
      </Callout>,
    );
  }
  if (!view.repo.ok) {
    callouts.push(
      <Callout key="repo" tone="warning" title="The history repository can't be read">
        {view.repo.message} Asset names and versions still come from the last sync.
      </Callout>,
    );
  }

  const meta = [
    selected ? `${selected.total} ${selected.heading.toLowerCase()}` : `${total} ${total === 1 ? "asset" : "assets"} in ${view.sections.length} ${view.sections.length === 1 ? "type" : "types"}`,
    includeDeleted ? "deleted assets shown" : view.deletedCount ? `${view.deletedCount} deleted not shown` : null,
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={selected ? [{ label: "Assets", href: href({ deleted: includeDeleted }) }, { label: selected.heading }] : [{ label: "Assets" }]} />
      <PageHeader
        title={selected ? selected.heading : "Assets"}
        meta={meta}
        actions={
          <>
            {selected ? (
              <Link className={outlineSm} href={href({ deleted: includeDeleted })}>
                All asset types
              </Link>
            ) : null}
            {view.deletedCount || includeDeleted ? (
              <Link className={ghostSm} href={href({ type: view.selectedType, deleted: !includeDeleted })}>
                {includeDeleted ? "Hide deleted assets" : "Show deleted assets"}
              </Link>
            ) : null}
          </>
        }
      />
      {callouts.length ? (
        <section aria-label="Needs attention" className="space-y-2">
          {callouts}
        </section>
      ) : null}

      {!selected && view.sections.length > 1 ? (
        <nav aria-label="Asset types" className="flex flex-wrap gap-1">
          {view.sections.map((s) => (
            <a key={s.assetType} className={ghostSm} href={`#type-${s.assetType}`}>
              {s.heading}
              <span className="rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground tabular-nums">{s.total}</span>
            </a>
          ))}
        </nav>
      ) : null}

      {view.sections.length === 0 ? (
        <SectionCard id="no-assets" title="Assets">
          <EmptyState title="No assets indexed yet" action={canSync ? <SyncNowButton alias={space.alias} /> : undefined}>
            Instructions, skills, memories and the other assets of this space appear here after a sync.
          </EmptyState>
        </SectionCard>
      ) : (
        view.sections.map((s) => (
          <div key={s.assetType} id={`type-${s.assetType}`} className="scroll-mt-16">
            <SectionCard
              id={`h-${s.assetType}`}
              title={
                <span className="inline-flex items-center gap-2">
                  {s.heading}
                  <span className="rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground tabular-nums">{s.total}</span>
                </span>
              }
            >
              {s.rows.length === 0 ? (
                <EmptyState title={`No ${s.heading.toLowerCase()}`}>Nothing of this type is indexed for this space.</EmptyState>
              ) : (
                <AssetTable alias={space.alias} caption={s.heading} items={s.memoryGroups ? memoryItems(space.alias, s.memoryGroups) : flatItems(s.rows)} status={status} />
              )}
              {s.truncated ? (
                <div className="flex justify-center border-t px-4 py-2">
                  <Link className={ghostSm} href={href({ type: s.assetType, deleted: includeDeleted })}>
                    Show all {s.total} {s.heading.toLowerCase()}
                  </Link>
                </div>
              ) : null}
            </SectionCard>
          </div>
        ))
      )}
    </div>
  );
}
