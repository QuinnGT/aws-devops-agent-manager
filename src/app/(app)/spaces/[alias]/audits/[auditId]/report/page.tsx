import { TriangleAlert } from "lucide-react";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { BuildReportButton } from "@/components/audit-reports/build-button";
import { CountTableBody, FindingsTableBody, IncidentListBody, MetricsTableBody } from "@/components/audit-reports/computed-sections";
import { ExportCard, type LastExport } from "@/components/audit-reports/export-card";
import { SaveRecordCard, type RecordCardRecord, type RecordIssueLink } from "@/components/audit-reports/save-record-card";
import { ReportProvider } from "@/components/audit-reports/report-context";
import { HideToggle, NarrativeSection } from "@/components/audit-reports/section-actions";
import { ReportSectionCard } from "@/components/audit-reports/section-card";
import { acceptedCount, audienceHelp, builtFromText, finalizeBlock, findingsHref, investigationsHref, staleLead, type KindLabel } from "@/components/audit-reports/words";
import { Callout } from "@/components/common/callout";
import { Time } from "@/components/common/time";
import { SafeMarkdown } from "@/components/safe-markdown";
import { getAnalyzer } from "@/server/analyzers/registry";
import { displayNames } from "@/server/drafts/loaders";
import type { RecordInfo } from "@/server/audit-reports/record";
import { decodeParam } from "@/server/assets/guard";
import { loadReportPage, noReportModelReason, REPORT_PERMISSIONS, unapprovedNarratives, type Audience, type ExportRecord, type ReportPage, type ReportSectionView } from "@/server/audit-reports";
import { can, requireUserOrRedirect } from "@/server/auth/dal";
import { getSpaceByAlias } from "@/server/spaces/queries";
import { approveNarrativeAction, buildReportAction, draftNarrativeAction, finalizeAuditAction, saveNarrativeAction, setSectionHiddenAction } from "./actions";

/**
 * The Report tab of an audit (pages/audit-report.md: the report, the HTML export
 * and the "Save the audit record" card). It renders inside the audit layout, which owns the
 * top bar, the audit header and the tabs; this page adds the report's
 * callouts, the section cards and the Export and Finalize cards.
 */

const ACTIONS = {
  build: buildReportAction,
  saveNarrative: saveNarrativeAction,
  approveNarrative: approveNarrativeAction,
  setHidden: setSectionHiddenAction,
  draftNarrative: draftNarrativeAction,
  finalize: finalizeAuditAction,
};

function analyzerLabel(id: string): string {
  try {
    return getAnalyzer(id).label;
  } catch {
    return id;
  }
}

function sectionMeta(s: ReportSectionView, page: ReportPage, kind: KindLabel | undefined): ReactNode {
  const c = s.content;
  const kindLabel = kind?.label.toLowerCase() ?? "finding";
  switch (c.type) {
    case "narrative": {
      const drafted = page.drafts[s.id]?.drafted ?? null;
      let source: ReactNode = null;
      if (c.text && c.source === "model") {
        source = (
          <span>
            Drafted by the model <Time value={drafted?.at ?? c.draftedAt ?? s.updatedAt ?? page.view.builtAt ?? page.view.audit.createdAt} format="datetime" />
            {c.approved ? (
              <>
                , approved by {c.approved.by} <Time value={c.approved.at} format="datetime" />
              </>
            ) : null}
          </span>
        );
      } else if (c.text && c.source === "person") {
        source = drafted ? (
          <span>
            Drafted by the model <Time value={drafted.at} format="datetime" />, edited by {s.updatedBy} <Time value={s.updatedAt ?? drafted.at} format="datetime" />
          </span>
        ) : (
          <span>
            Written by {s.updatedBy ?? "a person"} {s.updatedAt ? <Time value={s.updatedAt} format="datetime" /> : null}
          </span>
        );
      }
      return (
        <>
          <span>Narrative</span>
          {source}
          {c.canDraft ? (
            <span>
              {page.model.id ? (
                <>
                  Model <span className="font-mono">{page.model.id}</span> ({page.model.sourceLabel})
                </>
              ) : (
                "No report model is set"
              )}
            </span>
          ) : null}
          {s.stale && c.source !== "model" ? (
            <span className="inline-flex items-center gap-1 text-warning-fg">
              <TriangleAlert className="size-3.5" aria-hidden />
              Written before the latest finding changes
            </span>
          ) : null}
        </>
      );
    }
    case "count-table":
      return <span>Counted from {acceptedCount(c.total, kind?.label ?? "finding")}</span>;
    case "findings-table":
      return <span>One row per accepted {kindLabel}</span>;
    case "incident-list":
      return <span>One block per incident with its {kindLabel}, from accepted findings</span>;
    case "metrics-table":
      return (
        <span>
          From the {analyzerLabel(c.analyzer).toLowerCase()} analyzer, {c.rows.length} {c.rows.length === 1 ? "investigation" : "investigations"}
        </span>
      );
  }
}

/** The record's facts for the card: the times as server-rendered elements, the names as text. */
function recordForCard(info: RecordInfo, nameOf: (email: string) => string): RecordCardRecord | null {
  const { plan, saved } = info;
  if (!plan) return null;
  return {
    repository: plan.repository,
    branch: plan.branch,
    folder: plan.folder,
    push: plan.push,
    files: plan.files,
    saved: saved
      ? {
          commit: saved.commit,
          branch: saved.branch,
          folder: saved.folder,
          files: saved.files,
          push: saved.push,
          when: saved.at ? <Time value={saved.at} format="datetime" /> : "earlier",
          by: saved.by ? nameOf(saved.by) : null,
        }
      : null,
  };
}

function lastExport(r: ExportRecord | null): LastExport | null {
  if (!r) return null;
  return { refused: r.result === "denied", errors: r.errorCount ?? r.ruleIds.length, when: <Time value={r.at} format="datetime" />, actor: r.actor, failed: r.result === "error", fileName: r.fileName };
}

export default async function AuditReportPage({ params }: PageProps<"/spaces/[alias]/audits/[auditId]/report">) {
  const user = await requireUserOrRedirect();
  const { alias, auditId: rawAuditId } = await params;
  const space = await getSpaceByAlias(decodeParam(alias));
  if (!space || !(await can(user, REPORT_PERMISSIONS.read, space.id))) notFound();
  const auditId = decodeParam(rawAuditId);
  const [page, canRun, canManage, canRepos] = await Promise.all([
    loadReportPage(space, auditId),
    can(user, REPORT_PERMISSIONS.edit, space.id),
    can(user, "spaces.manage", space.id),
    // History repositories are app settings (as on Home)
    can(user, "spaces.manage", null),
  ]);
  if (!page) notFound();

  const { view } = page;
  const canEdit = canRun && !view.readOnly;
  const kinds = new Map(page.kinds.map((k) => [k.kind, k]));
  const toFindings = findingsHref(space.alias, view.audit.id, "proposed");
  const accepted = view.counts.findings.accepted;
  const built = view.builtAt !== null;

  const callout = !built ? (
    <Callout tone="info" title="The report isn't built yet" action={canEdit ? <BuildReportButton rebuild={false} /> : undefined}>
      {canEdit
        ? "Build it to see the sections, draft the narrative, export it and save the audit record. The tables count accepted findings only."
        : "Someone who can run audits builds it once the findings are reviewed."}
    </Callout>
  ) : view.stale && !view.readOnly ? (
    <Callout tone="warning" title="The report is out of date" action={canEdit ? <BuildReportButton rebuild /> : undefined}>
      {staleLead(view.changedSinceBuilt)} <Time value={view.builtAt!} format="datetime" />.{" "}
      {canEdit
        ? "The tables already count the latest decisions; check the narrative against them, then rebuild. Your narrative edits are kept."
        : "The tables already count the latest decisions, but the narrative was written before them. Someone who can run audits checks it and rebuilds the report."}
    </Callout>
  ) : null;

  const sections = view.sections.map((s, i) => {
    const n = i + 1;
    const kind = "findingKind" in s.content ? kinds.get(s.content.findingKind) : undefined;
    if (s.hidden) {
      return (
        <ReportSectionCard
          key={s.id}
          sectionId={s.id}
          number={n}
          title={s.title}
          audience={s.audience}
          hidden
          meta={
            <span>
              Hidden by {s.updatedBy ?? "a person"} {s.updatedAt ? <Time value={s.updatedAt} format="datetime" /> : null}. Left out of every export.
            </span>
          }
          actions={canEdit ? <HideToggle sectionId={s.id} title={s.title} hidden /> : null}
        />
      );
    }
    const c = s.content;
    if (c.type === "narrative") {
      const d = page.drafts[s.id];
      const disabledReason = !page.model.id ? noReportModelReason(page.runner) : accepted === 0 ? "Accept some findings first." : null;
      return (
        <NarrativeSection
          key={s.id}
          sectionId={s.id}
          number={n}
          title={s.title}
          audience={s.audience}
          text={c.text}
          source={c.source}
          check={{ needsApproval: c.needsApproval, draftedBeforeDecisions: c.draftedBeforeDecisions }}
          meta={sectionMeta(s, page, kind)}
          rendered={c.text ? <SafeMarkdown className="prose prose-sm max-w-[72ch] dark:prose-invert" headingOffset={2}>{c.text}</SafeMarkdown> : null}
          canEdit={canEdit}
          draft={c.canDraft ? { disabledReason, runId: d?.runId ?? null, failed: d?.failed?.error ?? null } : null}
          maxChars={page.narrativeMaxChars}
        />
      );
    }
    const body =
      c.type === "count-table" ? (
        <CountTableBody c={c} kind={kind} findingsHref={toFindings} />
      ) : c.type === "findings-table" ? (
        <FindingsTableBody c={c} kind={kind} title={s.title} findingsHref={toFindings} />
      ) : c.type === "metrics-table" ? (
        <MetricsTableBody c={c} title={s.title} />
      ) : (
        <IncidentListBody c={c} findingsHref={toFindings} />
      );
    const collapsed = c.type === "incident-list" && c.incidents.length ? { show: `Show ${c.incidents.length} ${c.incidents.length === 1 ? "incident" : "incidents"}`, hide: "Hide incidents" } : undefined;
    return (
      <ReportSectionCard
        key={s.id}
        sectionId={s.id}
        number={n}
        title={s.title}
        audience={s.audience}
        hidden={false}
        meta={sectionMeta(s, page, kind)}
        actions={canEdit ? <HideToggle sectionId={s.id} title={s.title} hidden={false} /> : null}
        collapsed={collapsed}
      >
        {body}
      </ReportSectionCard>
    );
  });

  const audiences = Object.keys(page.audiences) as Audience[];
  const help = Object.fromEntries(audiences.map((a) => [a, audienceHelp(a, page.audiences[a])])) as Record<Audience, string>;
  const counts = Object.fromEntries(audiences.map((a) => [a, page.audiences[a].sections])) as Record<Audience, number>;
  const last = { shareable: lastExport(view.lastExports.shareable), internal: lastExport(view.lastExports.internal) };
  const lastOk = { shareable: lastExport(view.lastSuccessfulExports.shareable), internal: lastExport(view.lastSuccessfulExports.internal) };
  // Only the shareable export warns about model text nobody approved.
  const unapproved = { shareable: unapprovedNarratives(view, "shareable"), internal: [] };

  const otherIssues: RecordIssueLink[] = view.finalize.issues
    .filter((i) => i.code !== "proposed" && i.code !== "finalized" && i.code !== "cancelled")
    .map((i) =>
      i.code === "unapproved-narrative"
        ? { message: i.message, href: null, linkLabel: null, sections: i.sections ?? [] }
        : { message: i.message, href: investigationsHref(space.alias, view.audit.id), linkLabel: "Open the investigations" },
    );
  const names = await displayNames(page.record.saved?.by ? [page.record.saved.by] : []);
  const reportSections = view.sections.filter((s) => !s.hidden && !(s.content.type === "narrative" && !s.content.text)).length;

  return (
    <ReportProvider alias={space.alias} auditId={view.audit.id} actions={ACTIONS}>
      <div className="space-y-4">
        {callout}
        {built ? (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-4">
              <p className="max-w-[90ch] text-[13px] text-muted-foreground">{builtFromText(view.counts.acceptedByKind, page.kinds, view.counts.findings.proposed)}</p>
              {sections}
            </div>
            <aside aria-label="Export and save the audit record" className="grid content-start gap-4 lg:grid-cols-2 xl:grid-cols-1">
              <ExportCard help={help} sections={counts} last={last} lastOk={lastOk} unapproved={unapproved} excerptChars={page.excerptChars} />
              {canEdit || page.record.saved ? (
                <SaveRecordCard
                  auditName={view.audit.name}
                  record={recordForCard(page.record, names)}
                  repositorySettingsHref={canRepos ? "/settings" : null}
                  journalCount={page.journalCount}
                  acceptedCount={accepted}
                  reportSections={reportSections}
                  block={canEdit ? finalizeBlock({ state: view.audit.state, issues: view.finalize.issues, hasRepository: page.repository !== null }) : { reason: "The record is saved.", link: null }}
                  findingsHref={toFindings}
                  settingsHref={canManage ? `/spaces/${encodeURIComponent(space.alias)}/settings` : null}
                  issues={otherIssues}
                  stale={
                    view.stale ? (
                      <>
                        {staleLead(view.changedSinceBuilt)} <Time value={view.builtAt!} format="datetime" />. report.md counts the latest decisions, but check that the narrative still matches them.
                      </>
                    ) : null
                  }
                  actor={user.email}
                  runId={page.finalizeRunId}
                  lastFailed={page.finalizeFailed?.error ?? null}
                />
              ) : null}
            </aside>
          </div>
        ) : null}
      </div>
    </ReportProvider>
  );
}
