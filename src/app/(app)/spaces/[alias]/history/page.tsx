import Link from "next/link";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { spaceHref } from "@/components/assets/format";
import { ChangeFeed, feedTerms } from "@/components/common/change-feed";
import { feedFilterQuery, feedSince, parseFeedFilters } from "@/components/common/feed-params";
import { PageHeader } from "@/components/common/page-header";
import { RoleNote } from "@/components/common/role-note";
import { SectionCard } from "@/components/common/section-card";
import { buttonVariants } from "@/components/ui/button";
import { CHANGE_SOURCES } from "@/lib/assets/types";
import { can, roleFor } from "@/server/auth/dal";
import { roleNote } from "@/server/auth/role-words";
import { countChangesBySource, listFeedItems } from "@/server/assets/feed";
import { firstParam, loadSpaceForPage } from "@/server/assets/guard";
import { countAssetsByType } from "@/server/assets/queries";
import { getAppPolicy } from "@/server/policy";

/** Changes read per page; grouping happens within a page. */
const PAGE_SIZE = 200;
/** Pages reachable through "Show older changes" (offset at most 100 000 rows) */
const MAX_PAGE = 500;

/** A filter change starts again at the newest page. */
const RESET = ["page"] as const;

const ghostSm = buttonVariants({ variant: "ghost", size: "sm" });

/**
 * The space's full change feed (design-system MASTER "Page index"):
 * the Home feed's filters and URL params with "All time" as the default
 * range, and "Show older changes" paging back 200 changes at a time.
 */
export default async function HistoryPage(props: PageProps<"/spaces/[alias]/history">) {
  const { alias } = await props.params;
  const sp = await props.searchParams;
  const { user, space } = await loadSpaceForPage(alias, "history.read");
  const filters = parseFeedFilters(sp, { range: "all" });
  const page = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(firstParam(sp.page) ?? "1", 10) || 1));

  const [feed, counts, bySource, canReasons, role] = await Promise.all([
    listFeedItems(space.id, { sources: filters.sources, types: filters.types, since: feedSince(filters.range), name: filters.q, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countAssetsByType(space.id),
    countChangesBySource(space.id),
    can(user, "reasons.write", space.id),
    roleFor(user, space.id),
  ]);

  const terms = feedTerms();
  const typeOptions = [...new Set([...Object.keys(counts), ...filters.types])].map((t) => ({ value: t, label: terms.typeLabel(t) }));
  const total = CHANGE_SOURCES.reduce((n, s) => n + bySource[s], 0);
  const base = spaceHref(space.alias, "/history");
  const pageHref = (p: number) => `${base}?${feedFilterQuery(filters)}${p > 1 ? `&page=${p}` : ""}`;

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={[{ label: "History" }]} />
      <PageHeader
        title="History"
        description="Every recorded change to this space's assets, newest first, with who made it."
        meta={[`${total} ${total === 1 ? "change" : "changes"} recorded`, page > 1 ? `Page ${page}` : null]}
      />
      <RoleNote text={roleNote(getAppPolicy().policy, role, "reasons.write", "add change reasons")} alias={space.alias} />
      <SectionCard
        id="changes"
        title="Changes"
        aside={
          page > 1 ? (
            <Link className={ghostSm} href={pageHref(page - 1)}>
              Show newer changes
            </Link>
          ) : undefined
        }
      >
        <ChangeFeed
          alias={space.alias}
          items={feed.items}
          hasMore={feed.hasMore && page < MAX_PAGE}
          showFilters
          filters={filters}
          typeOptions={typeOptions}
          canWriteReasons={canReasons}
          olderHref={pageHref(page + 1)}
          filterResetParams={RESET}
        />
      </SectionCard>
    </div>
  );
}
