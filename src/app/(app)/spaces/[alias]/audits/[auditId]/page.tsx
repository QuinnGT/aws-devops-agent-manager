import { Search, TriangleAlert, Check } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { AuditForm } from "@/components/audits/audit-form";
import { byIncident } from "@/components/audits/audit-header";
import { auditDetail, getAuditCached } from "@/components/audits/detail-data";
import { auditFormProps } from "@/components/audits/form-data";
import { AUDIT_PAGE, itemListQuery, parseItemListParams, type ItemShow } from "@/components/audits/list-params";
import { auditsBase, loadAuditsPage } from "@/components/audits/page-guard";
import { citationCell, failedShortReason, findingCountsText, itemReviewBadge } from "@/components/audits/words";
import { AutoRefresh } from "@/components/plans/auto-refresh";
import { ConnectionNextStep } from "@/components/common/connection-next-step";
import { EmptyState } from "@/components/common/empty-state";
import { StatusBadge } from "@/components/common/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { AuditItemSummary } from "@/server/audits/loaders";
import { actorOf } from "@/server/spaces/actor";

const SHOW_LABELS: Record<ItemShow, string> = { all: "All", proposed: "With proposed findings", citations: "Citation problems", failed: "Failed" };

function matchesShow(i: AuditItemSummary, show: ItemShow): boolean {
  if (show === "proposed") return i.findings.proposed > 0;
  if (show === "citations") return (i.review?.citationCheck?.failed ?? 0) > 0;
  if (show === "failed") return i.state === "failed";
  return true;
}

/** Audit detail, Investigations tab (pages/audit-detail.md); a draft renders the New audit form (pages/audit-new.md). */
export default async function AuditPage({ params, searchParams }: PageProps<"/spaces/[alias]/audits/[auditId]">) {
  const { alias, auditId } = await params;
  const { user, space, perms, viewer } = await loadAuditsPage(alias);
  const audit = await getAuditCached(space.id, auditId);
  if (!audit) notFound();
  const base = `${auditsBase(space.alias)}/${audit.id}`;

  if (audit.state === "draft") {
    const crumbs = [{ label: "Audits", href: auditsBase(space.alias) }, { label: audit.name }];
    if (!perms.has("audits.run")) {
      return (
        <>
          <SpaceTopBar space={space} user={user} crumbs={crumbs} />
          <EmptyState title="This audit is a draft">It hasn&apos;t started yet. Its investigations and ground truth are being chosen by an Editor.</EmptyState>
        </>
      );
    }
    const props = await auditFormProps(space, perms, audit, actorOf(user));
    return (
      <>
        <SpaceTopBar space={space} user={user} crumbs={crumbs} />
        <AuditForm {...props} connectionNextStep={<ConnectionNextStep alias={space.alias} canManage={perms.has("spaces.manage")} />} />
      </>
    );
  }

  const detail = await auditDetail(space.id, audit.id, viewer);
  if (!detail) notFound();
  const p = parseItemListParams(await searchParams);
  const all = byIncident(detail.items);
  const q = p.q.toLowerCase();
  const matching = all.filter((i) => matchesShow(i, p.show) && (!q || (i.incidentId ?? i.taskId).toLowerCase().includes(q) || (i.title ?? "").toLowerCase().includes(q)));
  const shown = matching.slice(0, p.rows);
  const count = (s: ItemShow) => all.filter((i) => matchesShow(i, s)).length;
  const primaryLabel = detail.profile.primaryField?.label ?? "Diagnosis";
  const hasScore = detail.profile.columns.length > 0;

  return (
    <>
      <AutoRefresh active={detail.audit.state === "running"} seconds={10} />
      <Card className="gap-0 py-0" role="region" aria-label="Investigations">
        <div role="toolbar" aria-label="Filter investigations" className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
          <nav aria-label="Show" className="inline-flex flex-wrap overflow-hidden rounded-lg border">
            {(Object.keys(SHOW_LABELS) as ItemShow[]).map((s) => (
              <Link
                key={s}
                href={`${base}${itemListQuery({ show: s, q: p.q })}`}
                scroll={false}
                aria-current={p.show === s ? "true" : undefined}
                className={cn("inline-flex h-7 items-center gap-1.5 border-r px-2.5 text-[13px] last:border-r-0", p.show === s ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
              >
                {SHOW_LABELS[s]} <span className="tabular-nums">{count(s)}</span>
              </Link>
            ))}
          </nav>
          <form action={base} className="flex min-w-44 max-w-64 flex-1 items-center gap-1.5 rounded-lg border px-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring">
            <Search className="size-4 text-muted-foreground" aria-hidden />
            {p.show !== "all" ? <input type="hidden" name="show" value={p.show} /> : null}
            <input type="search" name="q" defaultValue={p.q} aria-label="Filter by incident or title" placeholder="Filter by incident or title" className="h-7 min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
          </form>
        </div>
        {shown.length === 0 ? (
          <EmptyState
            title={all.length ? "No investigations match these filters" : "No investigations"}
            action={
              all.length ? (
                <Link href={base} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Clear filters
                </Link>
              ) : null
            }
          >
            {all.length ? "Clear the filters to see every investigation." : "This audit has no investigations."}
          </EmptyState>
        ) : (
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4 text-[13px] text-muted-foreground">Incident</TableHead>
                {hasScore ? <TableHead className="text-right text-[13px] text-muted-foreground">{detail.profile.columns[0]!.label}</TableHead> : null}
                <TableHead className="text-[13px] text-muted-foreground">Review</TableHead>
                <TableHead className="text-[13px] text-muted-foreground">Citation check</TableHead>
                <TableHead className="text-[13px] text-muted-foreground">{primaryLabel}</TableHead>
                <TableHead className="pr-4 text-[13px] text-muted-foreground">Findings</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((i) => {
                const cc = citationCell(i.review?.citationCheck ?? null);
                const fc = findingCountsText(i.findings);
                const failed = i.state === "failed";
                return (
                  <TableRow key={i.id} className="align-top">
                    <TableCell className="py-2.5 pl-4 whitespace-normal">
                      <Link href={`${base}/items/${i.id}`} className="inline-flex min-h-6 items-center rounded-sm font-mono text-xs font-semibold underline-offset-4 hover:underline">
                        {i.incidentId ?? i.taskId}
                      </Link>
                      {i.title ? <p className="max-w-[60ch] text-xs text-muted-foreground">{i.title}</p> : null}
                    </TableCell>
                    {hasScore ? <TableCell className="text-right tabular-nums">{i.score ?? ""}</TableCell> : null}
                    <TableCell className="whitespace-normal">
                      <StatusBadge {...itemReviewBadge(i.state)} />
                      {failed ? <p className="mt-0.5 text-xs text-muted-foreground">{failedShortReason(i.stateReason)}</p> : null}
                      {i.state === "skipped" && i.stateReason ? <p className="mt-0.5 max-w-[32ch] text-xs text-muted-foreground">{i.stateReason}</p> : null}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {cc.tone === "muted" ? (
                        <span className="text-muted-foreground">{cc.label}</span>
                      ) : (
                        <span className={cn("flex items-center gap-1", cc.tone === "success" ? "text-success-fg" : "text-warning-fg")}>
                          {cc.tone === "success" ? <Check className="size-3.5" aria-hidden /> : <TriangleAlert className="size-3.5" aria-hidden />}
                          {cc.label}
                        </span>
                      )}
                      {cc.detail ? <p className="text-xs text-muted-foreground">{cc.detail}</p> : null}
                    </TableCell>
                    <TableCell className="whitespace-normal">{i.primary ? i.primary.label : <span className="text-muted-foreground">{failed ? "No result" : ""}</span>}</TableCell>
                    <TableCell className="pr-4 whitespace-normal">
                      {fc.none ? (
                        <span className="text-muted-foreground">None</span>
                      ) : (
                        fc.parts.map((x, k) => (
                          <span key={x.word}>
                            {k > 0 ? ", " : null}
                            <span className={x.strong ? "font-semibold" : undefined}>
                              {x.n} {x.word}
                            </span>
                          </span>
                        ))
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {matching.length > shown.length ? (
          <div className="flex justify-center border-t px-4 py-2">
            <Link href={`${base}${itemListQuery({ ...p, rows: p.rows + AUDIT_PAGE })}`} scroll={false} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Show {matching.length - shown.length} more investigations
            </Link>
          </div>
        ) : null}
      </Card>
    </>
  );
}
