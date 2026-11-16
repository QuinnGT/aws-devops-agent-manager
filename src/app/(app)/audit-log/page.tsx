import { Download } from "lucide-react";
import Link from "next/link";
import { TopBar } from "@/components/app-shell/top-bar";
import { Callout } from "@/components/common/callout";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { SectionCard } from "@/components/common/section-card";
import { StatusBadge } from "@/components/common/status-badge";
import { Time } from "@/components/common/time";
import { getViewerZone } from "@/components/common/viewer-zone";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, requireUserOrRedirect } from "@/server/auth/dal";
import {
  AUDIT_MAX_ROWS,
  AUDIT_PAGE_SIZE,
  AUDIT_RESULTS,
  type AuditFilter,
  auditFilterQuery,
  auditFilterSchema,
  auditShowCount,
  hasAuditFilters,
} from "@/server/spaces/audit-filter";
import { listAuditActions, queryAuditEvents, resolveAuditScope } from "@/server/spaces/audit-log";
import { listSpaces } from "@/server/spaces/queries";
import { AuditFilters } from "./_components/audit-filters";
import { actionLabel, auditTarget, detailsText, RESULT_WORDS, resultWord } from "./_components/audit-labels";

const topBar = <TopBar crumbs={[{ label: "Audit log" }]} />;

export default async function AuditLogPage({ searchParams }: PageProps<"/audit-log">) {
  const user = await requireUserOrRedirect();
  const spaces = await listSpaces();
  const scope = await resolveAuditScope(
    spaces.map((s) => s.id),
    (spaceId) => can(user, "auditlog.read", spaceId),
  );
  if (!scope) {
    return (
      <div className="mx-auto max-w-7xl space-y-4">
        {topBar}
        <PageHeader title="Audit log" />
        <SectionCard id="no-access" title="You can't read the audit log">
          <EmptyState title="The audit log is for Admins">
            Reading it needs the auditlog.read permission, which the Admin role has. Ask an Admin for an export if you need one.
          </EmptyState>
        </SectionCard>
      </div>
    );
  }

  const sp = await searchParams;
  const parsed = auditFilterSchema.safeParse(sp);
  const filter: AuditFilter = parsed.success ? parsed.data : {};
  const show = auditShowCount(sp.show);
  const zone = await getViewerZone();
  const [rows, actions] = await Promise.all([queryAuditEvents(filter, scope, show + 1, { timeZone: zone.timeZone }), listAuditActions(scope)]);
  const events = rows.slice(0, show);
  const hasMore = rows.length > show;
  const visibleSpaces = scope.all ? spaces : spaces.filter((s) => scope.spaceIds.includes(s.id));
  const filtered = hasAuditFilters(filter);
  const exportHref = (format: "csv" | "json") => `/api/audit-log/export${auditFilterQuery(filter, { format })}`;
  // cn() merges away the base border-transparent, which buttonVariants alone leaves in.
  const outline = cn(buttonVariants({ variant: "outline", size: "sm" }));

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      {topBar}
      <PageHeader
        title="Audit log"
        description={`An append-only record of sign-ins, registrations, settings changes, plans, jobs, imports and exports.${scope.all ? "" : " You see events for the spaces where you can read the audit log."}`}
        meta={[`Times and dates in ${zone.fallback ? "UTC" : zone.timeZone}`, "point at a time for UTC"]}
        actions={
          <>
            <a className={outline} href={exportHref("csv")} download>
              <Download aria-hidden />
              Export CSV
            </a>
            <a className={outline} href={exportHref("json")} download>
              <Download aria-hidden />
              Export JSON
            </a>
          </>
        }
      />

      {!parsed.success ? (
        <Callout tone="warning" title="Some filters in the link aren't valid">
          The page shows every event instead. Choose the filters again below.
        </Callout>
      ) : null}

      <SectionCard
        id="events"
        title="Events"
        aside={
          <span className="text-xs text-muted-foreground tabular-nums">
            {events.length === 0 ? null : `${events.length} ${events.length === 1 ? "event" : "events"}${hasMore ? ", older ones hidden" : ""}`}
          </span>
        }
      >
        <AuditFilters
          value={{
            space: filter.space ?? [],
            action: filter.action ?? [],
            result: filter.result ?? [],
            actor: filter.actor ?? "",
            target: filter.target ?? "",
            from: filter.from ?? "",
            to: filter.to ?? "",
          }}
          spaces={visibleSpaces.map((s) => ({ value: s.id, label: s.displayName ?? s.alias }))}
          actions={[...new Set([...actions, ...(filter.action ?? [])])].map((a) => ({ value: a, label: actionLabel(a) }))}
          results={AUDIT_RESULTS.map((r) => ({ value: r, label: RESULT_WORDS[r].label }))}
        />
        {events.length === 0 ? (
          <EmptyState title={filtered ? "No events match these filters" : "No events yet"}>
            {filtered ? "Change or clear the filters to see more." : "Events appear here when someone signs in, changes a setting or starts a job."}
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Time</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="pr-4">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((e) => {
                const target = auditTarget(e);
                const details = detailsText(e.details);
                return (
                  <TableRow key={e.id} className="align-top">
                    <TableCell className="pl-4 text-xs whitespace-nowrap">
                      <Time value={e.at} format="datetime" />
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className="block">{e.actorEmail}</span>
                      {e.actorName && e.actorName !== e.actorEmail ? <span className="block text-muted-foreground">{e.actorName}</span> : null}
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className="block">{actionLabel(e.action)}</span>
                      <span className="block font-mono text-muted-foreground">{e.action}</span>
                    </TableCell>
                    <TableCell className="text-xs whitespace-normal">
                      {target ? (
                        <>
                          <span className="block text-muted-foreground">{target.kind}</span>
                          {target.href ? (
                            <Link href={target.href} className="font-mono break-all underline-offset-4 hover:underline">
                              {target.name ?? target.shortId}
                            </Link>
                          ) : (
                            <span className="font-mono break-all">{target.name ?? target.shortId}</span>
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                      {e.spaceAlias && !(e.targetType === "agent_space" || e.targetType === "space") ? (
                        <span className="block text-muted-foreground">in {e.spaceAlias}</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <StatusBadge {...resultWord(e.action, e.result)} />
                    </TableCell>
                    <TableCell className="pr-4 text-xs whitespace-normal">
                      {details ? (
                        <details className="group max-w-md">
                          <summary className="inline-flex min-h-6 cursor-pointer items-center rounded-md px-1 text-muted-foreground hover:text-foreground">
                            <span className="group-open:hidden">Show details</span>
                            <span className="hidden group-open:inline">Hide details</span>
                          </summary>
                          <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap break-all">{details}</pre>
                        </details>
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {hasMore ? (
          <div className="flex flex-wrap items-center gap-3 border-t px-4 py-3">
            {show < AUDIT_MAX_ROWS ? (
              <Link href={`/audit-log${auditFilterQuery(filter, { show: String(show + AUDIT_PAGE_SIZE) })}`} scroll={false} className={outline}>
                Show {AUDIT_PAGE_SIZE} more
              </Link>
            ) : null}
            <span className="text-xs text-muted-foreground">
              {show < AUDIT_MAX_ROWS
                ? "Older events are hidden."
                : `The page shows at most ${AUDIT_MAX_ROWS} events. Narrow the filters, or export to get every event.`}
            </span>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}
