import Link from "next/link";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { spaceBase } from "@/components/app-shell/nav";
import { EmptyState } from "@/components/common/empty-state";
import { RoleNote } from "@/components/common/role-note";
import { StatusBadge } from "@/components/common/status-badge";
import { Time } from "@/components/common/time";
import { AutoRefresh } from "@/components/plans/auto-refresh";
import { hasFilters, parsePlanListParams, PLAN_PAGE, planListQuery } from "@/components/plans/list-params";
import { loadPlansPage } from "@/components/plans/page-guard";
import { PlanFilters } from "@/components/plans/plan-filters";
import { PlansHeader } from "@/components/plans/plans-header";
import { planStateBadge, SYNCED_COUNT_NOTE } from "@/components/plans/words";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { roleNote } from "@/server/auth/role-words";
import { countOpenDrafts } from "@/server/drafts/loaders";
import { PACKAGE_IO_PERMISSIONS } from "@/server/package-io";
import { getAppPolicy } from "@/server/policy";
import { countPlans, loadPlanList } from "@/server/plans/loaders";
import { isBusyState, PLAN_STATUS_FILTERS } from "@/server/plans/view";

/** Plans list (design-system pages/plans.md). Reads only; plans start on the Drafts tab, a restore (rollback) or an import. */
export default async function PlansPage({ params, searchParams }: PageProps<"/spaces/[alias]/plans">) {
  const { alias } = await params;
  const { user, space, perms, role } = await loadPlansPage(alias);
  const p = parsePlanListParams(await searchParams);
  const base = spaceBase(space.alias);
  const filter = { states: PLAN_STATUS_FILTERS[p.status], originKinds: p.origin === "all" ? undefined : [p.origin], q: p.q };

  const [rows, openPlans, openDrafts, closedMatching, anyPlans] = await Promise.all([
    loadPlanList(space.id, { ...filter, limit: p.show + 1, orderBy: "updated" }),
    countPlans(space.id, { states: PLAN_STATUS_FILTERS.open }),
    countOpenDrafts(space.id),
    p.status === "open" ? countPlans(space.id, { ...filter, states: PLAN_STATUS_FILTERS.closed }) : Promise.resolve(0),
    countPlans(space.id),
  ]);
  const shown = rows.slice(0, p.show);
  const more = rows.length > p.show;
  const filtered = hasFilters(p) || p.status !== "open";

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={[{ label: "Plans" }]} />
      <PlansHeader alias={space.alias} current="plans" openPlans={openPlans} openDrafts={openDrafts} canImport={perms.has(PACKAGE_IO_PERMISSIONS.import)} />
      {/* "Import package" is missing for this role: say why. */}
      <RoleNote text={roleNote(getAppPolicy().policy, role, PACKAGE_IO_PERMISSIONS.import, "import packages or create plans")} alias={space.alias} />
      <AutoRefresh active={shown.some((r) => isBusyState(r.state))} seconds={10} />

      <Card className="gap-0 py-0" role="region" aria-label="Plans">
        <PlanFilters value={p} />
        {shown.length === 0 ? (
          filtered && (hasFilters(p) || anyPlans > 0) ? (
            <EmptyState
              title="No plans match these filters"
              action={
                <Link href={`${base}/plans`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Clear filters
                </Link>
              }
            >
              Clear the filters to see every plan.
            </EmptyState>
          ) : (
            <EmptyState
              title={anyPlans === 0 && openDrafts === 0 ? "No plans yet" : "No open plans"}
              action={
                <Link href={`${base}/drafts`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Open drafts
                </Link>
              }
            >
              {openDrafts > 0
                ? `${openDrafts} ${openDrafts === 1 ? "draft is" : "drafts are"} waiting. Select them on the Drafts tab to create a plan.`
                : "Plans are created from drafts, by restoring a release or a version, or from a package import. Nothing is written to the space without one."}
            </EmptyState>
          )
        ) : (
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4 text-[13px] text-muted-foreground">Plan</TableHead>
                <TableHead className="text-[13px] text-muted-foreground">Status</TableHead>
                <TableHead className="text-right text-[13px] text-muted-foreground">Changes</TableHead>
                <TableHead className="text-[13px] text-muted-foreground">Author</TableHead>
                <TableHead className="pr-4 text-right text-[13px] text-muted-foreground">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="py-2.5 pl-4 whitespace-normal">
                    <Link href={`${base}/plans/${r.id}`} className="inline-flex min-h-6 items-center rounded-sm font-semibold underline-offset-4 hover:underline">
                      {r.title}
                    </Link>
                    {r.originLine !== r.title ? <p className="text-xs text-muted-foreground">{r.originLine}</p> : null}
                  </TableCell>
                  <TableCell>
                    <StatusBadge {...planStateBadge(r.state, r.checkFailed, r.validationFailed)} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.writes ?? <span className="text-muted-foreground">Not checked</span>}
                    {r.writesSynced ? <span className="block text-xs text-muted-foreground">{SYNCED_COUNT_NOTE}</span> : null}
                  </TableCell>
                  <TableCell>{r.authorName ?? r.author}</TableCell>
                  <TableCell className="pr-4 text-right">
                    <Time value={r.updatedAt} format="datetime" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {more || (p.status === "open" && closedMatching > 0) ? (
          <div className="flex flex-wrap items-center justify-center gap-2 border-t px-4 py-2">
            {more ? (
              <Link href={`${base}/plans${planListQuery({ ...p, show: p.show + PLAN_PAGE })}`} scroll={false} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Show more
              </Link>
            ) : null}
            {p.status === "open" && closedMatching > 0 ? (
              <Link href={`${base}/plans${planListQuery({ ...p, status: "all", show: 0 })}`} scroll={false} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Show {closedMatching} closed {closedMatching === 1 ? "plan" : "plans"}
              </Link>
            ) : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
