import Link from "next/link";
import type { ReactNode } from "react";
import { assetHref, assetTabHref, diffHref } from "@/components/assets/format";
import { buttonVariants } from "@/components/ui/button";
import { CHANGE_SOURCES, type FeedItem } from "@/lib/assets/types";
import { cn } from "@/lib/utils";
import { getAppPolicy } from "@/server/policy";
import { AssetTypeIcon } from "./asset-type-icon";
import { EmptyState } from "./empty-state";
import { FeedFilters } from "./feed-filters";
import { FeedGroupRow } from "./feed-group-row";
import { buildFeed, describeChange, type FeedTerms } from "./feed-groups";
import { FEED_ROW, FEED_SLOTS } from "./feed-layout";
import type { FeedFilterState } from "./feed-params";
import { SourceBadge } from "./source-badge";
import { displayPrincipal, longSourceLabel, shortSourceLabel } from "./source-labels";
import { Time } from "./time";
import { VersionBadge } from "./version-badge";
import { getViewerZone } from "./viewer-zone";

/** Type labels and count nouns from policy/asset-types.yaml. */
export function feedTerms(): FeedTerms {
  const types = getAppPolicy().policy.assetTypes.assetTypes;
  return {
    typeLabel: (t) => types[t]?.label ?? t,
    noun: (t, n) => {
      const noun = types[t]?.noun;
      const one = noun?.one ?? (types[t]?.label ?? t).toLowerCase();
      return n === 1 ? one : (noun?.other ?? `${one}s`);
    },
  };
}

const ghost = cn(buttonVariants({ variant: "ghost", size: "sm" }));

function RowActions({ alias, item, canWriteReasons }: { alias: string; item: FeedItem; canWriteReasons: boolean }) {
  const label = `${item.name} v${item.version}`;
  return (
    <>
      {(item.kind === "content" || item.kind === "metadata") && item.previousCommit ? (
        <Link className={ghost} href={diffHref(alias, item.assetId, item.previousCommit, item.commit)}>
          Diff<span className="sr-only"> {label}</span>
        </Link>
      ) : null}
      {item.kind === "created" || item.kind === "baseline" ? (
        <Link className={ghost} href={assetHref(alias, item.assetId)}>
          View<span className="sr-only"> {label}</span>
        </Link>
      ) : null}
      {item.planId && item.source === "app" ? (
        <Link className={ghost} href={`/spaces/${encodeURIComponent(alias)}/plans/${encodeURIComponent(item.planId)}`}>
          Plan<span className="sr-only"> that applied {label}</span>
        </Link>
      ) : null}
      {canWriteReasons && !item.hasReason ? (
        <Link className={ghost} href={assetTabHref(alias, item.assetId, "versions", { reason: String(item.version) })}>
          Add reason<span className="sr-only"> for {label}</span>
        </Link>
      ) : null}
    </>
  );
}

function versionOf(item: FeedItem): number | "new" | "deleted" {
  return item.kind === "created" ? "new" : item.kind === "deleted" ? "deleted" : item.version;
}

function Title({ icon, children, version }: { icon: string; children: ReactNode; version?: number | "new" | "deleted" | null }) {
  return (
    <span className="flex min-h-6 min-w-0 items-center gap-1.5 font-medium">
      <AssetTypeIcon assetType={icon} />
      {children}
      {version !== null && version !== undefined ? <VersionBadge version={version} /> : null}
    </span>
  );
}

function ChangeRow({ alias, item, canWriteReasons }: { alias: string; item: FeedItem; canWriteReasons: boolean }) {
  const policy = getAppPolicy().policy.attribution;
  const terms = feedTerms();
  return (
    <div className={FEED_ROW}>
      <div className={FEED_SLOTS.source}>
        <SourceBadge source={item.source} principal={item.principal} provisional={item.provisional} recordedLabel={item.sourceLabel} />
      </div>
      <div className={FEED_SLOTS.main}>
        <Title icon={item.assetType} version={versionOf(item)}>
          <Link className="block truncate rounded-sm leading-6 underline-offset-4 hover:underline" href={assetHref(alias, item.assetId)}>
            {item.name}
          </Link>
        </Title>
        <p className="line-clamp-2 text-[13px] break-words text-muted-foreground" title={item.principal && displayPrincipal(item.principal) !== item.principal ? item.principal : undefined}>
          {describeChange(item, terms, longSourceLabel(item.source, policy, item.sourceLabel))}
        </p>
      </div>
      <div className={FEED_SLOTS.time}>
        <Time value={item.at} format="time" />
      </div>
      <div className={FEED_SLOTS.actions}>
        <RowActions alias={alias} item={item} canWriteReasons={canWriteReasons} />
      </div>
    </div>
  );
}

/**
 * Recent changes with day headers and groups (pages/space-home.md). Server
 * component; the filter toolbar and group expanders are client components.
 * Pass `olderHref` to end the list with "Show older changes".
 */
export async function ChangeFeed({
  alias,
  items,
  limit,
  showFilters = false,
  canWriteReasons,
  filters,
  typeOptions = [],
  olderHref,
  hasMore = false,
  filterResetParams,
}: {
  alias: string;
  items: FeedItem[];
  /** Rows or groups to show (Home: 20) */
  limit?: number;
  showFilters?: boolean;
  canWriteReasons: boolean;
  /** Current filter state, for the toolbar */
  filters?: FeedFilterState;
  /** Asset types offered in the Type filter */
  typeOptions?: { value: string; label: string }[];
  /** Where "Show older changes" goes; omitted means no button */
  olderHref?: string;
  /** The query returned more rows than `items` */
  hasMore?: boolean;
  /** Params the filter toolbar removes when a filter changes (History's `page`) */
  filterResetParams?: readonly string[];
}) {
  const zone = await getViewerZone();
  const terms = feedTerms();
  const policy = getAppPolicy().policy.attribution;
  const { days, truncated } = buildFeed(items, { timeZone: zone.timeZone, terms, limit });
  const sourceOptions = CHANGE_SOURCES.map((s) => ({ value: s, label: shortSourceLabel(s, policy) }));

  return (
    <div className="@container/feed">
      {showFilters && filters ? <FeedFilters value={filters} sources={sourceOptions} types={typeOptions} resetParams={filterResetParams} /> : null}
      {days.length === 0 ? (
        <EmptyState title="No changes match these filters">Changes appear here after a sync records them. Try a longer date range or clear a filter.</EmptyState>
      ) : (
        days.map((d) => (
          <div key={d.day}>
            <h3 className="border-b bg-muted px-4 py-1.5 text-xs font-semibold text-muted-foreground">
              <Time value={d.at} format="day" />
            </h3>
            {d.entries.map((e) =>
              e.kind === "single" ? (
                <ChangeRow key={e.key} alias={alias} item={e.item} canWriteReasons={canWriteReasons} />
              ) : (
                <FeedGroupRow
                  key={e.key}
                  count={e.items.length}
                  source={<SourceBadge source={e.items[0]!.source} provisional={e.items.some((i) => i.provisional)} recordedLabel={e.items[0]!.sourceLabel} />}
                  main={
                    <>
                      <Title icon={e.items[0]!.assetType}>
                        <span className="truncate">{e.title}</span>
                      </Title>
                      <p className="truncate text-[13px] text-muted-foreground">{e.detail}</p>
                    </>
                  }
                  time={<Time value={e.items[0]!.at} format="time" />}
                >
                  {e.items.map((i) => (
                    <ChangeRow key={`${i.commit}:${i.assetId}`} alias={alias} item={i} canWriteReasons={canWriteReasons} />
                  ))}
                </FeedGroupRow>
              ),
            )}
          </div>
        ))
      )}
      {olderHref && (truncated || hasMore) ? (
        <div className="flex justify-center px-3 py-2">
          <Link className={ghost} href={olderHref}>
            Show older changes
          </Link>
        </div>
      ) : null}
    </div>
  );
}
