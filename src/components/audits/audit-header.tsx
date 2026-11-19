import { CheckCheck, ListChecks, Microscope } from "lucide-react";
import Link from "next/link";
import { Callout } from "@/components/common/callout";
import { LinkTabs } from "@/components/common/link-tabs";
import { LiveJobProgress } from "@/components/common/live-job-progress";
import { PageHeader } from "@/components/common/page-header";
import { StatusBadge } from "@/components/common/status-badge";
import { Time } from "@/components/common/time";
import { buttonVariants } from "@/components/ui/button";
import { CopyCommit } from "@/components/audit-reports/copy-commit";
import { savedPushText } from "@/components/audit-reports/words";
import type { RecordInfo } from "@/server/audit-reports/record";
import type { FixProgress } from "@/server/audits/next-step";
import type { AuditDetailView } from "@/server/audits/loaders";
import type { ReviewerView } from "@/server/audits/reviewers";
import type { ActorAt, AuditModelView } from "@/server/audits/ui";
import { CancelAuditButton, RerunFailedButton, RerunItemButton } from "./audit-buttons";
import { FailureDetails } from "./failure-details";
import { failureGroups, failureNextStep, incidentList } from "./failure-view";
import { nextIncidentToReview } from "./next-incident";
import { flowStrip } from "./flow";
import { FlowStrip } from "./flow-strip";
import { findingListQuery } from "./list-params";
import { allReviewsFailed, auditStateBadge, compactNumber, plural, readyToSave, reviewProgressText, type AuditStateFacts } from "./words";

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
  /** Where the saved record went; null until the record is saved */
  record: RecordInfo | null;
  /** The accepted package fixes and how many are in a revision */
  fix: FixProgress;
  /** Whether the report is built, and how many sections it shows */
  report: { built: boolean; sections: number };
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
  const citations = withReview.reduce((c, i) => ({ checked: c.checked + i.review!.citationCheck!.checked, failed: c.failed + i.review!.citationCheck!.failed }), { checked: 0, failed: 0 });
  const flow = flowStrip({ state: a.state, items: detail.progress.byState, citations, findings: counts, fix: data.fix, report: data.report, commit: a.finalizedCommit });
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
  if (tab !== "report" && readyToSave(a.state, facts)) {
    callouts.push(
      <Callout
        key="ready"
        tone="success"
        title="Ready to save the record"
        action={
          <Link href={`${base}/report`} className={buttonVariants({ size: "sm" })}>
            <CheckCheck aria-hidden />
            Open the Report tab
          </Link>
        }
      >
        Every investigation is reviewed and every finding has a decision: {counts.accepted} accepted, {counts.rejected} rejected. Build the report, then save the audit record on the Report tab. Saving it changes nothing in the Agent Space.
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
    const saved = data.record?.saved ?? null;
    const plan = data.record?.plan ?? null;
    const push = saved ? savedPushText(saved.push, plan?.push ?? null) : null;
    callouts.push(
      <Callout
        key="final"
        tone="success"
        title={
          <>
            Record saved {a.finalizedAt ? <Time value={a.finalizedAt} format="datetime" /> : null}
            {a.finalizedBy ? ` by ${nameOf(a.finalizedBy)}` : ""}
          </>
        }
      >
        {a.finalizedCommit ? (
          <>
            Commit <CopyCommit commit={a.finalizedCommit} />
          </>
        ) : (
          "The commit is not recorded"
        )}
        {saved ? (
          <>
            {" "}
            in <span className="font-mono text-xs">{saved.folder}</span> on <span className="font-mono text-xs">{saved.branch}</span>
            {plan ? (
              <>
                {" "}
                of <span className="font-mono text-xs">{plan.repository}</span>
              </>
            ) : null}
            : <span className="font-mono text-xs">audit.json</span>, <span className="font-mono text-xs">findings.json</span> and <span className="font-mono text-xs">report.md</span>.
          </>
        ) : (
          "."
        )}
        {push ? <span className={push.tone === "destructive" ? "block text-destructive-fg" : "block"}>{push.text}.</span> : null}
        <span className="block">Findings and the report can&apos;t change. Nothing in the Agent Space changed.</span>
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
      Reviewer: {r.label}
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
      <FlowStrip
        strip={flow}
        hrefs={{ reviews: base, decide: `${base}/findings`, fix: `${base}/findings${findingListQuery({ state: "accepted", fix: "package" })}`, report: `${base}/report`, record: `${base}/report#report-record` }}
        extra={analyzersRunning && a.runId ? { reviews: <LiveJobProgress runId={a.runId} /> } : undefined}
      />
      <details className="group -mt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer rounded-sm py-0.5">Details</summary>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <dt>Analyzers</dt>
          <dd>
            {analyzerDone} of {analyzerTotal} done on {plural(reviewable.length, "investigation")}
            {analyzerErrors ? `, ${analyzerErrors} failed` : ""}: {data.analyzers.words}
          </dd>
          <dt>Reviews</dt>
          <dd>
            {progress.value}
            {progress.failed ? <span className="text-destructive-fg">, {progress.failed}</span> : null}
            {data.reviewer.runner === "handoff" ? `, ${detail.progress.waitingForReview} waiting for a review file` : `, ${detail.profile.reviewConcurrency} at a time`}
          </dd>
          <dt>Findings</dt>
          <dd>
            {counts.accepted} accepted, {counts.proposed} proposed, {counts.rejected} rejected, {counts.total} in all
          </dd>
          <dt>Citation check</dt>
          <dd>
            {citationsFailed ? (
              <>
                <span className="text-warning-fg">{plural(citationsFailed, "review")}</span> {citationsFailed === 1 ? "cites" : "cite"} records that failed the check; {citationsPassed} passed
              </>
            ) : withReview.length ? (
              "Every review's citations passed"
            ) : (
              "No review has finished yet"
            )}
          </dd>
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
