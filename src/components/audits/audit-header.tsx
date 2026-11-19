import { CheckCheck, CircleCheck, FileCheck2, ListChecks, Microscope, Sparkles, Workflow } from "lucide-react";
import Link from "next/link";
import { Callout } from "@/components/common/callout";
import { LinkTabs } from "@/components/common/link-tabs";
import { LiveJobProgress } from "@/components/common/live-job-progress";
import { PageHeader } from "@/components/common/page-header";
import { StatTile } from "@/components/common/stat-tile";
import { StatusBadge } from "@/components/common/status-badge";
import { Time } from "@/components/common/time";
import { buttonVariants } from "@/components/ui/button";
import type { AuditDetailView } from "@/server/audits/loaders";
import type { ReviewerView } from "@/server/audits/reviewers";
import type { ActorAt, AuditModelView } from "@/server/audits/ui";
import { CancelAuditButton, RerunFailedButton, RerunItemButton } from "./audit-buttons";
import { FailureDetails } from "./failure-details";
import { failureGroups, failureNextStep, incidentList } from "./failure-view";
import { nextIncidentToReview } from "./next-incident";
import { allReviewsFailed, auditStateBadge, compactNumber, plural, readyToFinalize, reviewProgressText, type AuditStateFacts } from "./words";

export type AuditTab = "investigations" | "findings" | "report";

export interface AuditHeaderData {
  alias: string;
  detail: AuditDetailView;
  models: { review: AuditModelView; report: AuditModelView };
  /** Who writes the reviews, with the policy's labels */
  reviewer: ReviewerView;
  events: { started: ActorAt | null; cancelled: ActorAt | null };
  usage: { inputTokens: number; calls?: number };
  analyzers: { count: number; words: string };
  stepLimit: number;
  repository: string | null;
  nameOf: (email: string) => string;
  can: { run: boolean; review: boolean; manage?: boolean };
  /** The space's Bedrock check passes now (checked only when a review failed for missing or expired credentials) */
  accessWorksNow?: boolean;
}

/** Items in the Investigations table order: incident ID, numbers compared as numbers. */
export function byIncident<T extends { incidentId: string | null; taskId: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.incidentId ?? a.taskId).localeCompare(b.incidentId ?? b.taskId, undefined, { numeric: true }));
}

/** The facts the state words read, from an audit's detail view. */
export function stateFacts(detail: Pick<AuditDetailView, "progress" | "findingCounts">): AuditStateFacts {
  const proposed = detail.findingCounts.reduce((n, k) => n + k.counts.proposed, 0);
  const total = detail.findingCounts.reduce((n, k) => n + k.counts.total, 0);
  return { items: detail.progress.byState, findings: { proposed, total } };
}

/**
 * The audit header shared by the Investigations, Findings and Report tabs
 * (pages/audit-detail.md, "Shared header"): title, state, meta with the
 * models, actions, four stat tiles, at most three callouts and the tabs.
 */
export function AuditHeader({ data, tab }: { data: AuditHeaderData; tab: AuditTab }) {
  const { detail, alias, models, events, can, nameOf } = data;
  const a = detail.audit;
  const base = `/spaces/${encodeURIComponent(alias)}/audits/${a.id}`;
  const items = byIncident(detail.items);
  const reviewable = items.filter((i) => i.state !== "skipped");
  const failed = items.filter((i) => i.state === "failed");
  const analyzed = items.filter((i) => i.state === "reviewing" || i.state === "reviewed" || i.state === "failed").length + detail.progress.waitingForReview;
  const analyzerErrors = items.reduce((n, i) => n + i.analyzerErrors, 0);
  const analyzerTotal = reviewable.length * data.analyzers.count;
  const analyzerDone = Math.max(0, analyzed * data.analyzers.count - analyzerErrors);
  const counts = detail.findingCounts.reduce((c, k) => ({ accepted: c.accepted + k.counts.accepted, proposed: c.proposed + k.counts.proposed, rejected: c.rejected + k.counts.rejected, total: c.total + k.counts.total }), { accepted: 0, proposed: 0, rejected: 0, total: 0 });
  const withReview = items.filter((i) => i.review?.citationCheck);
  const citationsPassed = withReview.filter((i) => i.review!.citationCheck!.ok).length;
  const citationsFailed = withReview.length - citationsPassed;
  const nextIncident = nextIncidentToReview(items);
  const reviewing = a.state === "running" || a.state === "reviewing";
  const facts = stateFacts(detail);
  const progress = reviewProgressText(detail.progress.byState);
  const groups = failureGroups(failed, { canManage: !!can.manage, stepLimit: data.stepLimit, accessWorksNow: !!data.accessWorksNow });
  const rerunnable = groups.filter((g) => g.rerun).flatMap((g) => g.itemIds);
  const analyzersRunning = a.state === "running" && !!detail.job && (detail.job.status === "queued" || detail.job.status === "running");

  const actions = (
    <>
      {can.run && reviewing && rerunnable.length ? <RerunFailedButton alias={alias} auditId={a.id} count={rerunnable.length} /> : null}
      {can.run && a.state === "running" ? <CancelAuditButton alias={alias} auditId={a.id} name={a.name} /> : null}
      {can.review && reviewing && nextIncident ? (
        <Link href={`${base}/items/${nextIncident.id}`} className={buttonVariants({ size: "sm" })}>
          <ListChecks aria-hidden />
          Review next incident
        </Link>
      ) : null}
    </>
  );

  const callouts: React.ReactNode[] = [];
  if (failed.length && a.state !== "finalized") {
    const all = allReviewsFailed(facts);
    const next = failureNextStep(groups, can.run);
    const needsConnection = !data.accessWorksNow && groups.some((g) => g.kind === "no-credentials" || g.kind === "expired");
    const settingsLink = needsConnection && can.manage ? (
      <Link href={`/spaces/${encodeURIComponent(alias)}/settings#connection`} className={buttonVariants({ variant: "outline", size: "sm" })}>
        Open Space settings
      </Link>
    ) : undefined;
    callouts.push(
      <Callout
        key="failed"
        tone="destructive"
        title={all ? (failed.length === 1 ? "The review failed" : `All ${failed.length} reviews failed`) : `${plural(failed.length, "review")} failed`}
        action={can.run && reviewing && failed.length === 1 && rerunnable.length === 1 ? <RerunItemButton alias={alias} auditId={a.id} itemId={failed[0]!.id} /> : settingsLink}
      >
        {groups.slice(0, 3).map((g) => (
          <span key={g.kind} className="block">
            {g.incidents.length === failed.length && failed.length > 1 ? "" : `${incidentList(g.incidents)}: `}
            {g.text}
          </span>
        ))}
        {data.accessWorksNow && groups.some((g) => g.kind === "no-credentials" || g.kind === "expired") ? <span className="block">The space can reach Amazon Bedrock again.</span> : null}
        {next ? <span className="block">{next}</span> : null}
        <FailureDetails groups={groups} />
      </Callout>,
    );
  }
  if (tab !== "report" && readyToFinalize(a.state, facts)) {
    callouts.push(
      <Callout
        key="ready"
        tone="success"
        title="Ready to finalize"
        action={
          <Link href={`${base}/report`} className={buttonVariants({ size: "sm" })}>
            <CheckCheck aria-hidden />
            Open the Report tab
          </Link>
        }
      >
        Every investigation is reviewed and every finding has a decision: {counts.accepted} accepted, {counts.rejected} rejected. Build the report and finalize the audit on the Report tab.
      </Callout>,
    );
  }
  if (a.state === "cancelled") {
    callouts.push(
      <Callout key="cancelled" tone="info" title="This audit was cancelled">
        {events.cancelled ? (
          <>
            Cancelled <Time value={events.cancelled.at} format="datetime" /> by {nameOf(events.cancelled.by)}.{" "}
          </>
        ) : null}
        {plural(items.filter((i) => i.state === "reviewed").length, "review")} had finished; their findings are kept.
      </Callout>,
    );
  }
  if (a.state === "finalized") {
    callouts.push(
      <Callout
        key="final"
        tone="success"
        title={
          <>
            Finalized {a.finalizedAt ? <Time value={a.finalizedAt} format="datetime" /> : null}
            {a.finalizedBy ? ` by ${nameOf(a.finalizedBy)}` : ""}
          </>
        }
      >
        The record is in {data.repository ? <span className="font-mono text-xs">{data.repository}</span> : "the history repository"}
        {a.finalizedCommit ? (
          <>
            , commit <span className="font-mono text-xs">{a.finalizedCommit.slice(0, 7)}</span>
          </>
        ) : null}
        . Findings and the report can&apos;t change.
      </Callout>,
    );
  }

  const modelMeta = (label: string, m: AuditModelView) =>
    m.id ? (
      <span>
        {label} <span className="font-mono text-xs">{m.id}</span>
        {m.sourceLabel ? <span> ({m.sourceLabel.toLowerCase()})</span> : null}
      </span>
    ) : (
      <span>{label}: none chosen</span>
    );

  const reviewerMeta = (r: ReviewerView) => (
    <span>
      Reviewer {r.label}
      {r.options.length ? <span> ({r.options.map((o) => `${o.label.toLowerCase()} ${o.valueLabel.toLowerCase()}`).join(", ")})</span> : null}
    </span>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        icon={<Microscope />}
        title={a.name}
        badges={<StatusBadge {...auditStateBadge(a.state, facts)} />}
        description={a.note ?? undefined}
        meta={[
          a.profileLabel,
          events.started ? (
            <span key="s">
              Started <Time value={events.started.at} format="datetime" /> by {nameOf(events.started.by)}
            </span>
          ) : (
            <span key="c">
              Created <Time value={a.createdAt} format="datetime" /> by {nameOf(a.createdBy)}
            </span>
          ),
          data.reviewer.runner === "ai-sdk" ? modelMeta("Model", models.review) : reviewerMeta(data.reviewer),
          models.report.id && models.report.id !== models.review.id ? modelMeta("Report model", models.report) : null,
        ]}
        actions={actions}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          icon={<Workflow />}
          label="Analyzers"
          value={
            <>
              {analyzerTotal > 0 && analyzerDone >= analyzerTotal ? <CircleCheck className="text-success-fg" aria-hidden /> : null}
              {analyzerDone} of {analyzerTotal}
            </>
          }
          detail={`${plural(data.analyzers.count, "analyzer")} on ${plural(reviewable.length, "investigation")}${analyzerErrors ? `, ${analyzerErrors} failed` : ""}`}
          action={analyzersRunning && a.runId ? <LiveJobProgress runId={a.runId} /> : undefined}
        />
        <StatTile
          icon={<Sparkles />}
          label="Reviews"
          value={progress.value}
          detail={
            <>
              {progress.failed ? <span className="text-destructive-fg">{progress.failed} · </span> : null}
              {data.reviewer.runner === "handoff" ? `${detail.progress.waitingForReview} waiting for a review file` : `${detail.profile.reviewConcurrency} at a time`}
            </>
          }
        />
        <StatTile icon={<ListChecks />} label="Findings" value={`${counts.accepted} accepted`} detail={`${counts.proposed} proposed · ${counts.rejected} rejected · ${counts.total} in all`} />
        <StatTile
          icon={<FileCheck2 />}
          label="Citation check"
          value={`${citationsPassed} passed`}
          detail={citationsFailed ? <span><span className="text-warning-fg">{plural(citationsFailed, "review")}</span> {citationsFailed === 1 ? "cites" : "cite"} records that failed the check</span> : withReview.length ? "Every review's citations passed" : "No review has finished yet"}
        />
      </div>
      <details className="group -mt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer rounded-sm py-0.5">Details</summary>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <dt>Analyzers</dt>
          <dd>{data.analyzers.words.charAt(0).toUpperCase() + data.analyzers.words.slice(1)}</dd>
          {data.reviewer.runner === "ai-sdk" || data.usage.calls ? (
            <>
              <dt>Model input</dt>
              <dd>
                {compactNumber(data.usage.inputTokens)} input tokens
                {data.usage.calls ? ` in ${plural(data.usage.calls, "review call")}` : ""}
              </dd>
            </>
          ) : null}
        </dl>
      </details>
      {callouts.slice(0, 3)}
      <LinkTabs
        label="Audit sections"
        current={tab}
        items={[
          { key: "investigations", href: base, label: "Investigations", count: items.length },
          { key: "findings", href: `${base}/findings`, label: "Findings", count: counts.total },
          { key: "report", href: `${base}/report`, label: "Report" },
        ]}
      />
    </div>
  );
}
