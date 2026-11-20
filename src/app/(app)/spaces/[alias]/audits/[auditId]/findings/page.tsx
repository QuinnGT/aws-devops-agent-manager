import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AuditFilters } from "@/components/audits/audit-filters";
import { RecordSummary } from "@/components/audit-reports/record-summary";
import { auditDetail, fixContext, getAuditCached, revisionDialog } from "@/components/audits/detail-data";
import { FindingsWorkspace, type DetailData, type ListGroup, type ListRow } from "@/components/audits/findings-workspace";
import { AUDIT_PAGE, defaultFindingState, findingListQuery, parseFindingListParams } from "@/components/audits/list-params";
import { auditsBase, loadAuditsPage } from "@/components/audits/page-guard";
import { decideFindingsNote } from "@/components/audits/role-text";
import { kindPosition, plural } from "@/components/audits/words";
import { EmptyState } from "@/components/common/empty-state";
import { RoleNote } from "@/components/common/role-note";
import { formatTime } from "@/components/common/time-format";
import { getViewerZone } from "@/components/common/viewer-zone";
import { AutoRefresh } from "@/components/plans/auto-refresh";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { loadRecordInfo } from "@/server/audit-reports/record";
import { loadFindingDetail } from "@/server/audits/finding-detail";
import { loadFindingsQueue, type QueueRow } from "@/server/audits/loaders";
import { nextStepFor } from "@/server/audits/next-step";
import { loadedPolicyForSpace } from "@/server/audits/profiles";
import { profileOf } from "@/server/audits/store";
import { displayNames } from "@/server/drafts/loaders";
import { getAppPolicy } from "@/server/policy";

/**
 * Audit detail, Findings tab (pages/audit-detail.md, "Findings tab"): a list
 * grouped by incident and the selected finding side by side, each scrolling
 * on its own like the plan page. `?finding=<id>` selects a finding: the
 * revision page links here.
 */
export default async function FindingsPage({ params, searchParams }: PageProps<"/spaces/[alias]/audits/[auditId]/findings">) {
  const { alias, auditId } = await params;
  const { space, perms, viewer, role } = await loadAuditsPage(alias);
  const audit = await getAuditCached(space.id, auditId);
  if (!audit) notFound();
  const base = `${auditsBase(space.alias)}/${audit.id}`;
  if (audit.state === "draft") redirect(base);
  const profile = profileOf(audit);
  const p = parseFindingListParams(await searchParams);
  // A link to one finding shows every state, so the finding is in the list whatever its state.
  const state = p.state || (p.finding ? "all" : defaultFindingState(audit.state));
  const canBuild = perms.has("revisions.build");
  const [queue, detail, fix, loaded, dialog] = await Promise.all([
    loadFindingsQueue(space, audit.id, { limit: 500 }, viewer),
    auditDetail(space.id, audit.id, viewer),
    fixContext(space.id, audit.id, canBuild),
    loadedPolicyForSpace(space.id),
    revisionDialog(space.id, audit.id, canBuild),
  ]);
  if (!queue || !detail || !fix) notFound();

  const primary = detail.profile.primaryField?.field ?? null;
  const q = p.q.toLowerCase();
  const tagOf = (r: QueueRow, field: string) => r.tags.find((t) => t.field === field);
  const matches = (r: QueueRow) =>
    (!p.kind || r.kind === p.kind) &&
    (state === "all" || r.state === state) &&
    (!p.mode || (primary ? tagOf(r, primary)?.value === p.mode : r.tags.some((t) => t.value === p.mode))) &&
    (!p.owner || tagOf(r, "owner")?.value === p.owner) &&
    (!p.fix || (p.fix === "package" ? fix.natures.get(r.id)?.kind === "package" : fix.progress.open.includes(r.id))) &&
    (!q || r.title.toLowerCase().includes(q) || r.tags.some((t) => t.label.toLowerCase().includes(q)) || (r.incidentId ?? "").toLowerCase().includes(q));
  const all = queue.rows;
  const rows = all.filter(matches);

  // Findings grouped by incident, in the order the list shows them.
  const groupByIncident = (rs: QueueRow[]) => {
    const byItem = new Map<string, QueueRow[]>();
    for (const r of rs) byItem.set(r.itemId, [...(byItem.get(r.itemId) ?? []), r]);
    return [...byItem.entries()].sort(([, a], [, b]) => (a[0]!.incidentId ?? a[0]!.taskId).localeCompare(b[0]!.incidentId ?? b[0]!.taskId, undefined, { numeric: true }));
  };

  // The selection: the finding in the address, else the first one the list shows. A selected finding the filters leave out stays in the list.
  const selectedRow = (p.finding ? all.find((r) => r.id === p.finding) : undefined) ?? groupByIncident(rows)[0]?.[1][0];
  const selectedId = selectedRow?.id ?? null;
  const hiddenByFilters = !!selectedRow && !rows.some((r) => r.id === selectedRow.id);
  const listed = hiddenByFilters ? all.filter((r) => matches(r) || r.id === selectedRow.id) : rows;

  const hrefFor = (id: string) => `${base}/findings${findingListQuery({ ...p, state, finding: id })}`;
  const pinHref = selectedId && !p.finding ? hrefFor(selectedId) : null;

  // A page of the groups.
  const ordered = groupByIncident(listed);
  let budget = p.rows;
  const shownGroups: [string, QueueRow[]][] = [];
  for (const [k, rs] of ordered) {
    if (budget <= 0 && !rs.some((r) => r.id === selectedId)) continue;
    shownGroups.push([k, budget >= rs.length ? rs : rs.filter((r, i) => i < Math.max(budget, 0) || r.id === selectedId)]);
    budget -= rs.length;
  }
  const shownCount = shownGroups.reduce((n, [, rs]) => n + rs.length, 0);
  const proposedOf = (itemId: string) => all.filter((r) => r.itemId === itemId && r.state === "proposed");
  const groups: ListGroup[] = shownGroups.map(([itemId, rs]) => {
    const first = rs[0]!;
    const proposed = proposedOf(itemId);
    return {
      itemId,
      incident: first.incidentId ?? first.taskId,
      itemHref: `${base}/items/${itemId}`,
      proposed: proposed.length,
      flagged: proposed.filter((r) => r.citations.open > 0).length,
      rows: rs.map(
        (r): ListRow => ({
          id: r.id,
          href: hrefFor(r.id),
          kindLabel: r.kindLabel,
          tag: ((primary && tagOf(r, primary)) || tagOf(r, "owner") || r.tags[0])?.label ?? null,
          state: r.state,
          edited: r.edited,
          title: r.title,
          flagged: r.citations.open > 0,
        }),
      ),
    };
  });
  const order = shownGroups.flatMap(([, rs]) => rs.map((r) => ({ id: r.id, href: hrefFor(r.id), proposed: r.state === "proposed" })));

  // The selected finding, whole.
  const found = selectedId ? await loadFindingDetail(space, audit.id, selectedId, viewer) : null;
  const zone = await getViewerZone();
  let detailData: DetailData | null = null;
  if (found) {
    const f = found.finding;
    const ex = profile.findings.find((x) => x.kind === f.kind);
    const name = await displayNames([...(f.reviewedBy ? [f.reviewedBy] : []), ...f.citations.flatMap((c) => (c.checked ? [c.checked.by] : []))]);
    const nature = fix.natures.get(f.id) ?? null;
    const links = fix.links ? (fix.links.get(f.id) ?? []) : null;
    detailData = {
      id: f.id,
      itemId: f.itemId,
      incident: f.incidentId ?? found.taskId,
      itemHref: `${base}/items/${f.itemId}#finding-${f.id}`,
      position: kindPosition(f.kindLabel, found.sibling.index, found.sibling.count),
      ownerLine: nature && nature.kind !== "recorded" ? `Owner: ${nature.ownerLabel}` : null,
      title: f.fullTitle,
      state: f.state,
      edited: f.edited,
      hidden: [...(ex?.cardHidden ?? []), ...f.fields.filter((x) => typeof x.value === "string" && x.value.trim() === f.fullTitle.trim()).map((x) => x.key)],
      fields: f.fields.map((x) => ({ key: x.key, label: x.label, value: x.value, valueLabel: x.valueLabel, editable: x.editable, choices: x.choices, multiple: x.multiple, changed: x.changed })),
      citations: f.citations.map((c) => ({
        record: c.record,
        quote: c.quote,
        field: c.field,
        supports: c.supports,
        ok: c.ok,
        problem: c.problem,
        checked: c.checked ? { by: name(c.checked.by), at: formatTime(new Date(c.checked.at), "datetime", zone), note: c.checked.note } : null,
      })),
      totalRecords: found.totalRecords,
      reviewNote: f.reviewNote,
      decidedBy: f.reviewedBy ? `${name(f.reviewedBy)}${f.reviewedAt ? `, ${formatTime(f.reviewedAt, "datetime", zone)}` : ""}` : null,
      canAct: f.actions.accept.enabled || f.actions.reject.enabled || f.actions.reopen.enabled,
      canEdit: f.actions.edit.enabled,
      canCheck: f.actions.accept.enabled || f.actions.reject.enabled || f.actions.reopen.enabled,
      next: nextStepFor({
        state: f.state,
        nature: nature ?? { kind: "recorded" },
        canDecide: f.actions.accept.enabled,
        canBuild,
        links,
        reviewNote: f.reviewNote,
      }),
    };
  }

  const counts = detail.findingCounts.reduce((c, k) => ({ accepted: c.accepted + k.counts.accepted, proposed: c.proposed + k.counts.proposed, rejected: c.rejected + k.counts.rejected, total: c.total + k.counts.total }), { accepted: 0, proposed: 0, rejected: 0, total: 0 });
  const proposedTotal = all.filter((r) => r.state === "proposed").length;
  const proposedIncidents = new Set(all.filter((r) => r.state === "proposed").map((r) => r.itemId)).size;
  const filtered = !!(p.kind || p.state || p.mode || p.owner || p.fix || p.q);
  const hasPackageOwners = profile.fixOwners.some((o) => o.changesPackage);

  const kindOptions = [{ value: "", label: "All" }, ...queue.kinds.map((k) => ({ value: k.kind, label: k.label }))];
  const stateOptions = [...queue.states.map((s) => ({ value: s.state, label: s.label })), { value: "all", label: "All" }];
  const modeOptions = [{ value: "", label: "All" }, ...profile.failureModes.map((m) => ({ value: m.id, label: m.label }))];
  const ownerOptions = [{ value: "", label: "All" }, ...profile.fixOwners.map((o) => ({ value: o.id, label: o.label }))];
  const fixOptions = [
    { value: "", label: "All" },
    { value: "package", label: "Package fixes" },
    { value: "open", label: "Accepted, not in a revision" },
  ];

  const clearHref = `${base}/findings${findingListQuery({ state: "all" })}`;
  const empty =
    counts.total === 0 ? (
      <EmptyState title="No findings yet">Findings appear as each review finishes.</EmptyState>
    ) : state === "proposed" && !p.kind && !p.mode && !p.owner && !p.fix && !p.q && counts.proposed === 0 ? (
      <EmptyState
        title="Every finding has a decision"
        action={
          <Link href={`${base}/report`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Open the report
          </Link>
        }
      >
        {counts.accepted} accepted and {counts.rejected} rejected.
        {fix.progress.open.length ? ` ${plural(fix.progress.open.length, "accepted package fix", "accepted package fixes")} ${fix.progress.open.length === 1 ? "isn't" : "aren't"} in a revision yet.` : ""} Build the report next.
      </EmptyState>
    ) : (
      <EmptyState
        title="No findings match these filters"
        action={
          <Link href={clearHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Clear filters
          </Link>
        }
      >
        {filtered ? "Clear the filters to see every finding." : "Show every state to see the decided findings."}
      </EmptyState>
    );

  const record = await loadRecordInfo(space, audit, loaded.policy.historyLayout);
  const bulkRevision = canBuild && fix.progress.open.length ? fix.progress.open.map((id) => ({ id, title: fix.fixes.find((f) => f.id === id)?.title ?? "" })) : null;

  return (
    <>
      <AutoRefresh active={audit.state === "running"} seconds={10} />
      <RoleNote text={decideFindingsNote(getAppPolicy().policy, role)} alias={space.alias} />
      <Card className="gap-0 py-0" role="region" aria-label="Filter findings">
        <AuditFilters
          label="Filter findings"
          qLabel="Filter by text"
          values={{ kind: p.kind, state, mode: p.mode, owner: p.owner, fix: p.fix, q: p.q }}
          defaults={{ kind: "", state: defaultFindingState(audit.state), mode: "", owner: "", fix: "" }}
          menus={[
            { key: "kind", name: "Kind", value: p.kind, icon: true, options: kindOptions },
            { key: "state", name: "State", value: state, options: stateOptions },
            ...(profile.failureModes.length ? [{ key: "mode", name: "Failure mode", value: p.mode, options: modeOptions }] : []),
            ...(profile.fixOwners.length ? [{ key: "owner", name: "Fix owner", value: p.owner, options: ownerOptions }] : []),
            ...(hasPackageOwners ? [{ key: "fix", name: "Next step", value: p.fix, options: fixOptions }] : []),
          ]}
        />
      </Card>
      {groups.length === 0 && !detailData ? (
        <Card className="py-0">{empty}</Card>
      ) : (
        <FindingsWorkspace
          zone={zone}
          alias={space.alias}
          auditId={audit.id}
          groups={groups}
          order={order}
          selectedId={selectedId}
          pinHref={pinHref}
          detail={detailData}
          hiddenByFilters={hiddenByFilters}
          bulkRevision={bulkRevision}
          revisions={{ options: dialog.choices, nameRule: dialog.nameRule }}
          canDecide={queue.actions.review}
          empty={empty}
          footer={
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {plural(proposedTotal, "proposed finding")} in {plural(proposedIncidents, "incident")}. Bulk accept leaves out findings with a failed citation nobody has checked.
              </span>
              {listed.length > shownCount ? (
                <Link href={`${base}/findings${findingListQuery({ ...p, state, rows: p.rows + AUDIT_PAGE })}`} scroll={false} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                  Show {listed.length - shownCount} more
                </Link>
              ) : null}
            </span>
          }
        />
      )}
      <RecordSummary alias={space.alias} auditId={audit.id} info={record} />
    </>
  );
}
