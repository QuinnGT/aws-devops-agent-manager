import { CirclePlus, Download, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { AuditFilters } from "@/components/audits/audit-filters";
import { AUDIT_PAGE, AUDIT_STATE_OPTIONS, auditListQuery, parseAuditListParams } from "@/components/audits/list-params";
import { auditsBase, loadAuditsPage } from "@/components/audits/page-guard";
import { startAuditsNote } from "@/components/audits/role-text";
import { auditStateBadge, AUDITS_DESCRIPTION, plural, reviewProgressText } from "@/components/audits/words";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { RoleNote } from "@/components/common/role-note";
import { StatusBadge } from "@/components/common/status-badge";
import { Time } from "@/components/common/time";
import { AutoRefresh } from "@/components/plans/auto-refresh";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listProfiles, loadedPolicyForSpace } from "@/server/audits/profiles";
import { loadAuditListPage } from "@/server/audits/ui";
import { displayNames } from "@/server/drafts/loaders";
import { journalCounts } from "@/server/journals/queries";
import { getAppPolicy } from "@/server/policy";
import { cn } from "@/lib/utils";

const Zero = ({ n }: { n: number }) => <span className={cn("tabular-nums", n === 0 && "text-muted-foreground")}>{n}</span>;

/** Audits list (design-system pages/audits.md). Reads only. */
export default async function AuditsPage({ params, searchParams }: PageProps<"/spaces/[alias]/audits">) {
  const { alias } = await params;
  const { user, space, perms, role } = await loadAuditsPage(alias);
  const p = parseAuditListParams(await searchParams);
  const base = auditsBase(space.alias);
  const loaded = await loadedPolicyForSpace(space.id);
  const profiles = listProfiles(loaded.policy);
  const profile = profiles.some((x) => x.id === p.profile) ? p.profile : "";
  const [page, journals] = await Promise.all([loadAuditListPage(space, { state: p.state, profileId: profile || null, q: p.q, limit: p.show }), journalCounts(space.id)]);
  const nameOf = await displayNames(page.rows.map((r) => r.createdBy));
  const canRun = perms.has("audits.run");
  const filtered = p.state !== "open" || !!profile || !!p.q;
  const closed = p.state === "open" ? (["cancelled", "finalized"] as const).filter((s) => page.counts[s] > 0) : [];

  const newAudit = canRun ? (
    <Link href={`${base}/new`} className={buttonVariants({ size: "sm" })}>
      <CirclePlus aria-hidden />
      New audit
    </Link>
  ) : null;
  // Where "New audit" would be, a Viewer reads why it isn't there.
  const headerAction = newAudit ?? <RoleNote text={startAuditsNote(getAppPolicy().policy, role)} alias={space.alias} className="max-w-lg flex-nowrap items-start [&>a]:shrink-0 [&>svg]:mt-0.5" />;

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={[{ label: "Audits" }]} />
      <PageHeader title="Audits" description={AUDITS_DESCRIPTION} actions={headerAction} />
      <AutoRefresh active={page.rows.some((r) => r.state === "running")} seconds={10} />

      <Card className="gap-0 py-0" role="region" aria-label="Audits">
        {page.any ? (
          <AuditFilters
            label="Filter audits"
            qLabel="Filter by audit name"
            values={{ state: p.state, profile, q: p.q }}
            defaults={{ state: "open", profile: "" }}
            menus={[
              { key: "state", name: "State", value: p.state, icon: true, options: AUDIT_STATE_OPTIONS },
              { key: "profile", name: "Profile", value: profile, options: [{ value: "", label: "All" }, ...profiles.map((x) => ({ value: x.id, label: x.label }))] },
            ]}
          />
        ) : null}
        {page.rows.length === 0 ? (
          page.any && filtered ? (
            <EmptyState
              title="No audits match these filters"
              action={
                <Link href={base} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Clear filters
                </Link>
              }
            >
              Clear the filters to see every audit.
            </EmptyState>
          ) : journals.investigations === 0 ? (
            <EmptyState
              title="No audits yet"
              action={
                perms.has("journals.export") ? (
                  <Link href={`/spaces/${encodeURIComponent(space.alias)}/journals/exports`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                    <Download aria-hidden />
                    Export journals
                  </Link>
                ) : null
              }
            >
              Start one to review a set of investigations against their confirmed root cause. You need cached journals for them and, for the benchmark profile, a confirmed root cause and a scorecard per incident. No investigations are cached yet.
            </EmptyState>
          ) : (
            <EmptyState title={page.any ? "No open audits" : "No audits yet"} action={newAudit}>
              Start one to review a set of investigations against their confirmed root cause. You need cached journals for them and, for the benchmark profile, a confirmed root cause and a scorecard per incident.
            </EmptyState>
          )
        ) : (
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4 text-[13px] text-muted-foreground">Audit</TableHead>
                <TableHead className="text-[13px] text-muted-foreground">State</TableHead>
                <TableHead className="text-right text-[13px] text-muted-foreground">Investigations</TableHead>
                <TableHead className="text-right text-[13px] text-muted-foreground">Accepted</TableHead>
                <TableHead className="text-[13px] text-muted-foreground">Needs a decision</TableHead>
                <TableHead className="text-right text-[13px] text-muted-foreground">Rejected</TableHead>
                <TableHead className="text-[13px] text-muted-foreground">Created by</TableHead>
                <TableHead className="pr-4 text-right text-[13px] text-muted-foreground">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.rows.map((r) => {
                const facts = { items: r.itemStates, findings: { proposed: r.findings.proposed, total: r.findings.total } };
                const progress = reviewProgressText(r.itemStates);
                return (
                <TableRow key={r.id}>
                  <TableCell className="py-2.5 pl-4 whitespace-normal">
                    <Link href={`${base}/${r.id}`} className="inline-flex min-h-6 items-center rounded-sm font-semibold underline-offset-4 hover:underline">
                      {r.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">{r.profileLabel}</p>
                  </TableCell>
                  <TableCell>
                    <StatusBadge {...auditStateBadge(r.state, facts)} />
                    {r.state === "running" || (r.state === "reviewing" && r.itemStates.failed > 0) ? (
                      <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                        {progress.value}
                        {progress.failed ? `, ${progress.failed}` : ""}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.state === "draft" && r.items === 0 ? <span className="text-muted-foreground">Not chosen</span> : r.items}</TableCell>
                  <TableCell className="text-right">
                    <Zero n={r.findings.accepted} />
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {r.findings.proposed ? (
                      <>
                        <span className="font-semibold tabular-nums">{plural(r.findings.proposed, "proposed finding")}</span>
                        {r.flaggedProposed ? (
                          <span className="mt-0.5 flex items-center gap-1 text-xs text-warning-fg">
                            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                            {r.flaggedProposed} with a failed citation
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Zero n={r.findings.rejected} />
                  </TableCell>
                  <TableCell>{nameOf(r.createdBy)}</TableCell>
                  <TableCell className="pr-4 text-right">
                    <Time value={r.createdAt} format="datetime" />
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {page.more || closed.length ? (
          <div className="flex flex-wrap items-center justify-center gap-2 border-t px-4 py-2">
            {page.more ? (
              <Link href={`${base}${auditListQuery({ ...p, profile, show: p.show + AUDIT_PAGE })}`} scroll={false} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Show more
              </Link>
            ) : null}
            {closed.map((s) => (
              <Link key={s} href={`${base}${auditListQuery({ ...p, profile, state: s, show: 0 })}`} scroll={false} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Show {plural(page.counts[s], `${s} audit`)}
              </Link>
            ))}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
