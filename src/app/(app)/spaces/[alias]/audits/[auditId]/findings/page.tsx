import { Check, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Fragment } from "react";
import { AuditFilters } from "@/components/audits/audit-filters";
import { auditDetail, getAuditCached } from "@/components/audits/detail-data";
import { AcceptIncidentButton, FindingRowActions } from "@/components/audits/finding-buttons";
import { AUDIT_PAGE, defaultFindingState, findingListQuery, parseFindingListParams } from "@/components/audits/list-params";
import { auditsBase, loadAuditsPage } from "@/components/audits/page-guard";
import { decideFindingsNote } from "@/components/audits/role-text";
import { EDITED_BADGE, FINDING_STATE_BADGE, findingCitationText, plural } from "@/components/audits/words";
import { EmptyState } from "@/components/common/empty-state";
import { RoleNote } from "@/components/common/role-note";
import { StatusBadge } from "@/components/common/status-badge";
import { AutoRefresh } from "@/components/plans/auto-refresh";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { loadFindingsQueue, type QueueRow } from "@/server/audits/loaders";
import { profileOf } from "@/server/audits/store";
import { getAppPolicy } from "@/server/policy";

/** Audit detail, Findings tab (pages/audit-detail.md, "Findings tab"). */
export default async function FindingsPage({ params, searchParams }: PageProps<"/spaces/[alias]/audits/[auditId]/findings">) {
  const { alias, auditId } = await params;
  const { space, viewer, role } = await loadAuditsPage(alias);
  const audit = await getAuditCached(space.id, auditId);
  if (!audit) notFound();
  const base = `${auditsBase(space.alias)}/${audit.id}`;
  if (audit.state === "draft") redirect(base);
  const profile = profileOf(audit);
  const p = parseFindingListParams(await searchParams);
  const state = p.state || defaultFindingState(audit.state);
  const [queue, detail] = await Promise.all([
    loadFindingsQueue(space, audit.id, { kind: p.kind || null, state: state === "all" ? null : state, limit: 500 }, viewer),
    auditDetail(space.id, audit.id, viewer),
  ]);
  if (!queue || !detail) notFound();

  const primary = detail.profile.primaryField?.field ?? null;
  const modeField = primary;
  const q = p.q.toLowerCase();
  const tagOf = (r: QueueRow, field: string) => r.tags.find((t) => t.field === field);
  const rows = queue.rows.filter(
    (r) =>
      (!p.mode || (modeField ? tagOf(r, modeField)?.value === p.mode : r.tags.some((t) => t.value === p.mode))) &&
      (!p.owner || tagOf(r, "owner")?.value === p.owner) &&
      (!q || r.title.toLowerCase().includes(q) || r.tags.some((t) => t.label.toLowerCase().includes(q)) || (r.incidentId ?? "").toLowerCase().includes(q)),
  );
  const groups = new Map<string, QueueRow[]>();
  for (const r of rows) groups.set(r.itemId, [...(groups.get(r.itemId) ?? []), r]);
  const ordered = [...groups.entries()].sort(([, a], [, b]) => (a[0]!.incidentId ?? a[0]!.taskId).localeCompare(b[0]!.incidentId ?? b[0]!.taskId, undefined, { numeric: true }));
  let budget = p.rows;
  const shownGroups: [string, QueueRow[]][] = [];
  for (const [k, rs] of ordered) {
    if (budget <= 0) break;
    shownGroups.push([k, rs.slice(0, budget)]);
    budget -= rs.length;
  }
  const shownRows = shownGroups.reduce((n, [, rs]) => n + rs.length, 0);

  const canAct = queue.actions.review;
  const allCounts = detail.findingCounts.reduce((c, k) => ({ accepted: c.accepted + k.counts.accepted, proposed: c.proposed + k.counts.proposed, rejected: c.rejected + k.counts.rejected, total: c.total + k.counts.total }), { accepted: 0, proposed: 0, rejected: 0, total: 0 });
  // The proposed findings of every incident, for the bulk buttons (the whole group, not only the filtered rows).
  const proposedQueue = canAct ? await loadFindingsQueue(space, audit.id, { state: "proposed", limit: 500 }, viewer) : null;
  const proposedBy = new Map<string, QueueRow[]>();
  for (const r of proposedQueue?.rows ?? []) proposedBy.set(r.itemId, [...(proposedBy.get(r.itemId) ?? []), r]);
  const proposedTotal = proposedQueue?.rows.length ?? allCounts.proposed;
  const filtered = !!(p.kind || p.state || p.mode || p.owner || p.q);

  const kindOptions = [{ value: "", label: "All" }, ...queue.kinds.map((k) => ({ value: k.kind, label: k.label }))];
  const stateOptions = [
    ...queue.states.map((s) => ({ value: s.state, label: s.label })),
    { value: "all", label: "All" },
  ];
  const modeOptions = [{ value: "", label: "All" }, ...profile.failureModes.map((m) => ({ value: m.id, label: m.label }))];
  const ownerOptions = [{ value: "", label: "All" }, ...profile.fixOwners.map((o) => ({ value: o.id, label: o.label }))];

  return (
    <>
      <AutoRefresh active={audit.state === "running"} seconds={10} />
      <RoleNote text={decideFindingsNote(getAppPolicy().policy, role)} alias={space.alias} />
      <Card className="gap-0 py-0" role="region" aria-label="Findings">
        <AuditFilters
          label="Filter findings"
          qLabel="Filter by text"
          values={{ kind: p.kind, state, mode: p.mode, owner: p.owner, q: p.q }}
          defaults={{ kind: "", state: defaultFindingState(audit.state), mode: "", owner: "" }}
          menus={[
            { key: "kind", name: "Kind", value: p.kind, icon: true, options: kindOptions },
            { key: "state", name: "State", value: state, options: stateOptions },
            ...(profile.failureModes.length ? [{ key: "mode", name: "Failure mode", value: p.mode, options: modeOptions }] : []),
            ...(profile.fixOwners.length ? [{ key: "owner", name: "Fix owner", value: p.owner, options: ownerOptions }] : []),
          ]}
        />
        {rows.length === 0 ? (
          allCounts.total === 0 ? (
            <EmptyState title="No findings yet">Findings appear as each review finishes.</EmptyState>
          ) : state === "proposed" && !p.kind && !p.mode && !p.owner && !p.q && allCounts.proposed === 0 ? (
            <EmptyState
              title="Every finding has a decision"
              action={
                <Link href={`${base}/report`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Open the report
                </Link>
              }
            >
              {allCounts.accepted} accepted and {allCounts.rejected} rejected. Build the report next.
            </EmptyState>
          ) : (
            <EmptyState
              title="No findings match these filters"
              action={
                <Link href={`${base}/findings${findingListQuery({ state: "all" })}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Clear filters
                </Link>
              }
            >
              {filtered ? "Clear the filters to see every finding." : "Show every state to see the decided findings."}
            </EmptyState>
          )
        ) : (
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4 text-[13px] text-muted-foreground">Finding</TableHead>
                <TableHead className="text-[13px] text-muted-foreground">Failure mode or owner</TableHead>
                <TableHead className="text-[13px] text-muted-foreground">Citations</TableHead>
                <TableHead className={cn("text-[13px] text-muted-foreground", !canAct && "pr-4")}>State</TableHead>
                {canAct ? (
                  <TableHead className="pr-4 text-right text-[13px] text-muted-foreground">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shownGroups.map(([itemId, rs]) => {
                const first = rs[0]!;
                const incident = first.incidentId ?? first.taskId;
                const proposed = proposedBy.get(itemId) ?? rs.filter((r) => r.state === "proposed");
                const flagged = proposed.filter((r) => r.citations.open > 0).length;
                return (
                  <Fragment key={itemId}>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableCell colSpan={canAct ? 4 : 4} className="py-2 pl-4 whitespace-normal">
                        <Link href={`${base}/items/${itemId}`} className="inline-flex min-h-6 items-center rounded-sm font-mono text-xs font-semibold underline-offset-4 hover:underline">
                          {incident}
                        </Link>
                        <span className="ml-3 text-xs text-muted-foreground">
                          {plural(proposed.length, "proposed", "proposed")}
                          {flagged ? ` · ${flagged} with a failed citation` : ""}
                        </span>
                      </TableCell>
                      {canAct ? (
                        <TableCell className="py-1.5 pr-4 text-right">
                          <AcceptIncidentButton alias={space.alias} auditId={audit.id} itemId={itemId} incident={incident} eligible={proposed.length - flagged} flagged={flagged} />
                        </TableCell>
                      ) : null}
                    </TableRow>
                    {rs.map((r) => {
                      const ct = findingCitationText(r.citations);
                      const tag = (primary && tagOf(r, primary)) || tagOf(r, "owner") || r.tags[0];
                      return (
                        <TableRow key={r.id} className="align-top">
                          <TableCell className="py-2.5 pl-4 whitespace-normal">
                            <p className="max-w-[72ch] font-semibold">{r.title}</p>
                            <p className="text-xs text-muted-foreground">{r.kindLabel}</p>
                          </TableCell>
                          <TableCell className="whitespace-normal">{tag?.label ?? ""}</TableCell>
                          <TableCell>
                            <span className={cn("flex items-center gap-1", ct.tone === "success" ? "text-success-fg" : ct.tone === "warning" ? "text-warning-fg" : "text-muted-foreground")}>
                              {ct.tone === "success" ? <Check className="size-3.5" aria-hidden /> : ct.tone === "warning" ? <TriangleAlert className="size-3.5" aria-hidden /> : null}
                              {ct.label}
                            </span>
                          </TableCell>
                          <TableCell className={cn(!canAct && "pr-4")}>
                            <span className="flex flex-wrap gap-1">
                              <StatusBadge {...FINDING_STATE_BADGE[r.state]} />
                              {r.edited ? <StatusBadge {...EDITED_BADGE} /> : null}
                            </span>
                          </TableCell>
                          {canAct ? (
                            <TableCell className="py-1.5 pr-4 text-right">
                              {r.state !== "proposed" ? null : r.citations.open > 0 ? (
                                <Link href={`${base}/items/${r.itemId}#finding-${r.id}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                                  Review
                                </Link>
                              ) : (
                                <FindingRowActions alias={space.alias} findingId={r.id} title={r.title} />
                              )}
                            </TableCell>
                          ) : null}
                        </TableRow>
                      );
                    })}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
        {rows.length ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
            <span>
              {plural(proposedTotal, "proposed finding")} in {plural(proposedBy.size || new Set(queue.rows.filter((r) => r.state === "proposed").map((r) => r.itemId)).size, "incident")}. Bulk accept leaves out findings with a failed citation nobody has checked.
            </span>
            {rows.length > shownRows ? (
              <Link href={`${base}/findings${findingListQuery({ ...p, rows: p.rows + AUDIT_PAGE })}`} scroll={false} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Show {rows.length - shownRows} more
              </Link>
            ) : null}
          </div>
        ) : null}
      </Card>
    </>
  );
}
