import Link from "next/link";
import { EmptyState } from "@/components/common/empty-state";
import { StatusBadge } from "@/components/common/status-badge";
import { Time } from "@/components/common/time";
import { getViewerZone } from "@/components/common/viewer-zone";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { policyForSpace } from "@/server/journals/policy";
import { investigationFacets, listInvestigations } from "@/server/journals/queries";
import { FilterToolbar } from "./_components/filter-toolbar";
import { createdRange, filterHref, isFiltered, parseInvestigationFilters } from "./_components/filters";
import { JournalsHeader, loadSpaceForPage, NoAccess, outlineSm, Pager, primarySm, ROW_LINK, TD, TD_NUM, TH, TH_NUM } from "./_components/shared";
import { enumLabel, SOURCE_LABELS, taskStatus } from "./_components/words";

/** Cached investigations for one space, with filters in the URL. */
export default async function JournalsPage(props: PageProps<"/spaces/[alias]/journals">) {
  const { alias } = await props.params;
  const { user, space, perms, base } = await loadSpaceForPage(alias);
  const header = <JournalsHeader space={space} user={user} base={base} active="investigations" perms={perms} />;
  if (!perms.read)
    return (
      <div className="mx-auto max-w-7xl space-y-4">
        {header}
        <NoAccess />
      </div>
    );

  const filters = parseInvestigationFilters(await props.searchParams);
  const zone = await getViewerZone();
  const pageSize = (await policyForSpace(space)).policy.journals.ui.investigationsPageSize;
  const [{ rows, total }, facets] = await Promise.all([
    listInvestigations(
      space.id,
      { q: filters.q || undefined, statuses: filters.statuses, taskTypes: filters.taskTypes, sources: filters.sources, page: filters.page, ...createdRange(filters, zone.timeZone) },
      pageSize,
    ),
    investigationFacets(space.id),
  ]);
  const filtered = isFiltered(filters);
  const invHref = (taskId: string) => `${base}/investigations/${encodeURIComponent(taskId)}`;

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      {header}
      <Card className="gap-0 py-0" role="region" aria-labelledby="inv-h">
        <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2">
          <h2 id="inv-h" className="text-sm font-semibold tabular-nums">
            {total === 0 && !filtered ? "Investigations" : `${total} ${total === 1 ? "investigation" : "investigations"}${filtered ? " match" : " cached"}`}
          </h2>
          <span className="text-xs text-muted-foreground">Newest first</span>
        </div>
        {total > 0 || filtered ? (
          <FilterToolbar
            label="Filter investigations"
            menus={[
              { param: "status", name: "Status", selected: filters.statuses, options: [...new Set([...facets.statuses, ...filters.statuses])].map((s) => ({ value: s, label: enumLabel(s) })) },
              { param: "taskType", name: "Type", selected: filters.taskTypes, options: [...new Set([...facets.taskTypes, ...filters.taskTypes])].map((s) => ({ value: s, label: enumLabel(s) })) },
              { param: "source", name: "Source", selected: filters.sources, options: [{ value: "api", label: SOURCE_LABELS.api }, { value: "import", label: SOURCE_LABELS.import }] },
            ]}
            dates={{ from: filters.from, to: filters.to }}
            search={{ value: filters.q, label: "Filter by task ID, incident ID or title" }}
          />
        ) : null}
        {rows.length === 0 ? (
          filtered ? (
            <EmptyState
              title="No investigations match these filters"
              action={
                <Link className={outlineSm} href={base}>
                  Clear filters
                </Link>
              }
            >
              Change or clear the filters to see other investigations.
            </EmptyState>
          ) : (
            <EmptyState
              title="No investigations cached yet"
              action={
                perms.export ? (
                  <Link className={primarySm} href={`${base}/exports`}>
                    Export journals
                  </Link>
                ) : perms.import ? (
                  <Link className={outlineSm} href={`${base}/imports`}>
                    Import journals
                  </Link>
                ) : undefined
              }
            >
              Investigations appear here after an export reads them from the space, or after you import journal files.
            </EmptyState>
          )
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className={TH}>Investigation</TableHead>
                <TableHead className={`${TH} hidden lg:table-cell`}>Type</TableHead>
                <TableHead className={TH}>Status</TableHead>
                <TableHead className={`${TH} hidden lg:table-cell`}>Source</TableHead>
                <TableHead className={`${TH_NUM} hidden xl:table-cell`}>Executions</TableHead>
                <TableHead className={`${TH_NUM} hidden xl:table-cell`}>Records</TableHead>
                <TableHead className={TH_NUM}>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const named = r.incidentId ?? null;
                return (
                  <TableRow key={r.taskId}>
                    <TableCell className={`${TD} max-w-56 lg:max-w-[28rem]`}>
                      <Link className={ROW_LINK} href={invHref(r.taskId)}>
                        {named ?? r.title ?? r.taskId}
                      </Link>
                      {named && r.title ? <div className="truncate text-xs text-muted-foreground">{r.title}</div> : null}
                      <div className="truncate font-mono text-xs text-muted-foreground">{r.taskId}</div>
                      {/* Columns hidden on narrow screens, repeated under the name */}
                      <div className="text-xs text-muted-foreground tabular-nums xl:hidden">
                        <span className="lg:hidden">
                          {r.taskType ? enumLabel(r.taskType) : "Type not set"} · {SOURCE_LABELS[r.source]} ·{" "}
                        </span>
                        {r.executionCount} {r.executionCount === 1 ? "execution" : "executions"}, {r.recordCount} {r.recordCount === 1 ? "record" : "records"}
                      </div>
                    </TableCell>
                    <TableCell className={`${TD} hidden align-middle lg:table-cell`}>{r.taskType ? enumLabel(r.taskType) : <span className="text-muted-foreground">Not set</span>}</TableCell>
                    <TableCell className={`${TD} align-middle`}>
                      <StatusBadge {...taskStatus(r.status)} />
                    </TableCell>
                    <TableCell className={`${TD} hidden align-middle lg:table-cell`}>
                      <Badge variant="outline" className="h-[22px] font-medium text-muted-foreground">
                        {SOURCE_LABELS[r.source]}
                      </Badge>
                    </TableCell>
                    <TableCell className={`${TD_NUM} hidden align-middle xl:table-cell`}>{r.executionCount}</TableCell>
                    <TableCell className={`${TD_NUM} hidden align-middle xl:table-cell`}>{r.recordCount}</TableCell>
                    <TableCell className={`${TD_NUM} align-middle lg:whitespace-nowrap`}>{r.createdAt ? <Time value={r.createdAt} format="datetime" /> : "Not set"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        <Pager page={filters.page} pageSize={pageSize} total={total} noun="investigations" hrefFor={(page) => filterHref(base, filters, { page })} />
      </Card>
    </div>
  );
}
