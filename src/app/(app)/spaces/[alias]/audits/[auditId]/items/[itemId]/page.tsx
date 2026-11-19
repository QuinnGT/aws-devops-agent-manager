import { ChevronLeft, ChevronRight, Info } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { RerunItemButton } from "@/components/audits/audit-buttons";
import { byIncident } from "@/components/audits/audit-header";
import { auditDetail, getAuditCached } from "@/components/audits/detail-data";
import { firstCitation } from "@/components/audits/finding-view";
import { FailureDetails } from "@/components/audits/failure-details";
import { failureGroups } from "@/components/audits/failure-view";
import { nextIncidentToReview } from "@/components/audits/next-incident";
import { auditsBase, loadAuditsPage } from "@/components/audits/page-guard";
import { ReviewFilesCard } from "@/components/audits/review-files-card";
import { ReviewWorkspace, type CardFinding, type EvidenceDoc } from "@/components/audits/review-workspace";
import { decideFindingsNote } from "@/components/audits/role-text";
import { citationProblemSentence, kindPosition, plural, reviewedBy, uniqueProblems } from "@/components/audits/words";
import { Callout } from "@/components/common/callout";
import { RoleNote } from "@/components/common/role-note";
import { EmptyState } from "@/components/common/empty-state";
import { LiveJobProgress } from "@/components/common/live-job-progress";
import { PageHeader } from "@/components/common/page-header";
import { StatusBadge } from "@/components/common/status-badge";
import { Time } from "@/components/common/time";
import { formatTime } from "@/components/common/time-format";
import { getViewerZone } from "@/components/common/viewer-zone";
import { AutoRefresh } from "@/components/plans/auto-refresh";
import { SafeMarkdown } from "@/components/safe-markdown";
import { buttonVariants } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { checkBedrock } from "@/server/audits/bedrock-check";
import { reviewFailureKind } from "@/server/audits/failure";
import { loadAuditItem } from "@/server/audits/loaders";
import { loadedPolicyForSpace } from "@/server/audits/profiles";
import { profileOf } from "@/server/audits/store";
import { getRecordText, journalRecordCount, reviewHighlights } from "@/server/audits/ui";
import { displayNames } from "@/server/drafts/loaders";
import { getAppPolicy } from "@/server/policy";

const PREVIEW_LINES = 12;
const MD = "prose prose-sm max-w-[72ch] dark:prose-invert text-[13px] [&_h3]:text-sm [&_h4]:text-sm [&_h5]:text-sm";

/** Incident review, option 1 split view with option 2's shortcuts (pages/audit-item.md, MASTER "Page index"). */
export default async function AuditItemPage({ params, searchParams }: PageProps<"/spaces/[alias]/audits/[auditId]/items/[itemId]">) {
  const { alias, auditId, itemId } = await params;
  const { user, space, perms, role, viewer } = await loadAuditsPage(alias);
  const audit = await getAuditCached(space.id, auditId);
  if (!audit) notFound();
  const view = await loadAuditItem(space, audit.id, itemId, viewer);
  if (!view) notFound();
  const profile = profileOf(audit);
  const sp = await searchParams;
  const wanted = typeof sp.review === "string" ? sp.review : null;
  const review = view.reviews.find((r) => r.id === wanted) ?? view.reviews.find((r) => r.current) ?? null;
  const base = `${auditsBase(space.alias)}/${audit.id}`;
  const incident = view.item.incidentId ?? view.item.taskId;
  const zone = await getViewerZone();

  // Previous and next in the Investigations table order, skipping failed and skipped items.
  const detail = audit.state === "draft" ? null : await auditDetail(space.id, audit.id, viewer);
  const order = byIncident(detail?.items ?? []).filter((i) => (i.state !== "failed" && i.state !== "skipped") || i.id === view.item.id);
  const pos = order.findIndex((i) => i.id === view.item.id);
  const prev = pos > 0 ? order[pos - 1] : undefined;
  const next = pos >= 0 && pos < order.length - 1 ? order[pos + 1] : undefined;

  const [totalRecords, highlights] = await Promise.all([journalRecordCount(space.id, view.item.taskId), review ? reviewHighlights(view.item.id, review.id) : Promise.resolve(null)]);
  const names = await displayNames((review?.findings ?? []).flatMap((f) => [...(f.reviewedBy ? [f.reviewedBy] : []), ...f.citations.flatMap((c) => (c.checked ? [c.checked.by] : []))]));

  // Finding cards: diagnosis first, then by kind and position (the loader's order follows the profile's kinds).
  const kindOrder = profile.findings.map((x) => x.kind);
  const fs = [...(review?.findings ?? [])].sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || a.ordinal - b.ordinal);
  const perKind = new Map<string, number>();
  for (const f of fs) perKind.set(f.kind, (perKind.get(f.kind) ?? 0) + 1);
  const seen = new Map<string, number>();
  const cards: CardFinding[] = fs.map((f) => {
    const i = seen.get(f.kind) ?? 0;
    seen.set(f.kind, i + 1);
    const ex = profile.findings.find((x) => x.kind === f.kind);
    return {
      id: f.id,
      kind: f.kind,
      position: kindPosition(f.kindLabel, i, perKind.get(f.kind) ?? 1),
      title: f.title,
      state: f.state,
      edited: f.edited,
      from: ex?.from ?? "$",
      hidden: [...(ex?.cardHidden ?? []), ...f.fields.filter((x) => typeof x.value === "string" && x.value.trim() === f.title.trim()).map((x) => x.key)],
      fields: f.fields.map((x) => ({ key: x.key, label: x.label, value: x.value, valueLabel: x.valueLabel, editable: x.editable, choices: x.choices, multiple: x.multiple, changed: x.changed })),
      citations: f.citations.map((c) => ({
        record: c.record,
        quote: c.quote,
        field: c.field,
        supports: c.supports,
        ok: c.ok,
        problem: c.problem,
        checked: c.checked ? { by: names(c.checked.by), at: formatTime(new Date(c.checked.at), "datetime", zone), note: c.checked.note } : null,
      })),
      reviewNote: f.reviewNote,
      reviewedBy: f.reviewedBy ? names(f.reviewedBy) : null,
      reviewedAtText: f.reviewedAt ? formatTime(f.reviewedAt, "datetime", zone) : null,
      canAct: f.actions.accept.enabled || f.actions.reject.enabled || f.actions.reopen.enabled,
      canEdit: f.actions.edit.enabled,
      // Checking a record is a review action on the current review, in any decision state.
      canCheck: f.actions.accept.enabled || f.actions.reject.enabled || f.actions.reopen.enabled,
    };
  });
  const counts = review?.findingCounts ?? { accepted: 0, proposed: 0, rejected: 0, total: 0 };
  const reviewable = !!review?.current && perms.has("findings.review") && (audit.state === "running" || audit.state === "reviewing") && cards.length > 0;

  // The record opened by default.
  const first = firstCitation(cards);
  const firstLabel = first ? (cards.flatMap((c) => c.fields).find((x) => x.key === first.field.split(/[.[]/)[0])?.label ?? null) : null;
  const initialData = first ? await getRecordText(space, view.item.taskId, first.record) : null;

  // Evidence: ground-truth documents, required first.
  const docs = [...view.groundTruth].sort((a, b) => Number(b.required) - Number(a.required)).filter((g) => g.doc);
  const uploader = await displayNames(docs.map((g) => g.doc!.uploadedBy));
  const groundTruth: EvidenceDoc[] = docs.map((g, i) => {
    const lines = g.doc!.body.split("\n");
    const long = lines.length > PREVIEW_LINES;
    return {
      kind: g.kind,
      label: g.label,
      preview: <SafeMarkdown headingOffset={2} className={MD}>{long ? lines.slice(0, PREVIEW_LINES).join("\n") : g.doc!.body}</SafeMarkdown>,
      full: long ? <SafeMarkdown headingOffset={2} className={MD}>{g.doc!.body}</SafeMarkdown> : null,
      footer: (
        <>
          <span className="font-mono">{g.doc!.fileName}</span>, uploaded <Time value={g.doc!.uploadedAt} format="datetime" /> by {uploader(g.doc!.uploadedBy)}.
        </>
      ),
      uncertain: i === 0 && !!highlights?.groundTruthUncertain,
    };
  });

  // Header badges: score-like ground-truth fields ("Score 1/5", "Comparison agent score 4/5"), with the profile's help.
  const scoreBadges = view.groundTruth.flatMap((g) => g.doc?.fields.filter((f) => f.value && /^\d+(\.\d+)?\s*\/\s*\d+$/.test(f.value)) ?? []);
  const scoreHelp = scoreBadges.filter((f) => f.description);
  const failedProblems = review ? uniqueProblems(review.failedCitations.filter((c) => !cards.some((f) => f.citations.some((x) => x.record === c.record && x.checked)))) : [];
  const checkedRecords = review ? new Set(cards.flatMap((f) => f.citations.filter((c) => !c.ok && c.checked).map((c) => c.record))).size : 0;
  const allDecided = !!review?.current && counts.total > 0 && counts.proposed === 0;
  const nextToDecide = detail ? nextIncidentToReview(detail.items, view.item.id) : null;
  const handoff = view.runner === "handoff";
  const files = view.actions.reviewFiles;
  const maxUploadMb = files.visible ? Math.floor((await loadedPolicyForSpace(space.id)).policy.audits.handoff.import.maxUploadBytes / 1048576) : 0;
  const waitingForFile = handoff && view.item.state === "pending" && !review;
  const running = !handoff && (view.item.state === "pending" || view.item.state === "analyzing" || view.item.state === "reviewing");

  const callouts: React.ReactNode[] = [];
  if (review && review.citationCheck && review.citationCheck.failed > 0) {
    callouts.push(
      <Callout key="cc" tone="warning" title={`${review.citationCheck.failed} of ${plural(review.citationCheck.checked, "citation")} failed the check`}>
        {failedProblems.length ? `${failedProblems.slice(0, 6).map((c) => citationProblemSentence(c, totalRecords)).join(" ")} The findings that rely on them are flagged below.` : ""}
        {checkedRecords ? ` ${checkedRecords === 1 ? "One record was" : `${checkedRecords} records were`} checked by a reviewer; the note is shown with the citation.` : ""}
        {failedProblems.length && reviewable ? " Open a flagged citation to read its record, then use \"I checked the record\" if the finding holds." : ""}
      </Callout>,
    );
  }
  if (view.item.state === "failed") {
    const kind = reviewFailureKind(view.item.stateReason);
    const accessWorksNow = view.actions.rerun.enabled && (kind === "no-credentials" || kind === "expired") ? (await checkBedrock(space, { email: user.email })).kind === null : false;
    const [group] = failureGroups([{ id: view.item.id, incidentId: view.item.incidentId, taskId: view.item.taskId, stateReason: view.item.stateReason }], {
      canManage: perms.has("spaces.manage"),
      stepLimit: profile.review.stepLimit,
      accessWorksNow,
    });
    const canRerun = view.actions.rerun.enabled && !!group?.rerun;
    callouts.push(
      <Callout key="failed" tone="destructive" title="The review failed" action={canRerun ? <RerunItemButton alias={space.alias} auditId={audit.id} itemId={view.item.id} /> : undefined}>
        <span className="block">{group?.text}</span>
        {accessWorksNow ? <span className="block">The space can reach Amazon Bedrock again.</span> : null}
        <span className="block">{group?.rerun ? (view.actions.rerun.enabled ? "Rerun it, or leave it out: the report counts only accepted findings." : "Someone who can run audits can rerun it.") : "A rerun would fail the same way until that is fixed."}</span>
        {review && review.schemaErrors.length ? (
          <details className="mt-1 text-xs text-muted-foreground">
            <summary className="cursor-pointer rounded-sm py-0.5">Schema errors</summary>
            <ul className="mt-0.5 space-y-0.5 font-mono">
              {review.schemaErrors.slice(0, 5).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {group ? <FailureDetails groups={[group]} /> : null}
      </Callout>,
    );
  }
  if (view.item.state === "skipped") {
    callouts.push(
      <Callout key="skipped" tone="info" title="This investigation was skipped">
        {view.item.stateReason ?? "It was not ready when the audit started."}
      </Callout>,
    );
  }
  if (allDecided && review?.current) {
    callouts.push(
      <Callout
        key="done"
        tone="success"
        title={`Every finding in ${incident} has a decision`}
        action={
          nextToDecide ? (
            <Link href={`${base}/items/${nextToDecide.id}`} className={buttonVariants({ size: "sm" })}>
              Next: {nextToDecide.incidentId ?? nextToDecide.taskId}
              <ChevronRight aria-hidden />
            </Link>
          ) : (
            <Link href={`${base}/report`} className={buttonVariants({ size: "sm" })}>
              Open the Report tab
              <ChevronRight aria-hidden />
            </Link>
          )
        }
      >
        {counts.accepted} accepted and {counts.rejected} rejected.{" "}
        {nextToDecide
          ? `${nextToDecide.incidentId ?? nextToDecide.taskId} has ${plural(nextToDecide.findings.proposed, "finding")} waiting for a decision${nextToDecide.flaggedProposed ? `, ${nextToDecide.flaggedProposed} with a failed citation` : ""}.`
          : "No incident in this audit has a finding waiting for a decision."}
      </Callout>,
    );
  }

  return (
    <>
      <SpaceTopBar space={space} user={user} crumbs={[{ label: "Audits", href: auditsBase(space.alias) }, { label: audit.name, href: base }, { label: incident }]} />
      <AutoRefresh active={running && audit.state === "running"} seconds={10} />
      <PageHeader
        title={<span className="font-mono">{incident}</span>}
        badges={scoreBadges.map((f) =>
          f.description ? (
            <Tooltip key={f.key}>
              <TooltipTrigger asChild>
                <button type="button" className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" aria-describedby="score-help">
                  <StatusBadge tone="neutral" label={`${f.label} ${f.value}`} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-sm">
                {f.description}
              </TooltipContent>
            </Tooltip>
          ) : (
            <StatusBadge key={f.key} tone="neutral" label={`${f.label} ${f.value}`} />
          ),
        )}
        description={view.item.title ?? undefined}
        meta={[
          review?.finishedAt ? (
            <span key="r">
              Reviewed <Time value={review.finishedAt} format="datetime" />
              {review.steps ? ` in ${review.steps} steps` : ""}
              {handoff ? ` by ${reviewedBy(review.runner, review.modelId)}` : ""}
            </span>
          ) : null,
          view.journalPresent ? `${plural(totalRecords, "journal record")}` : "Journal not cached",
          view.item.primary && detail?.profile.primaryField ? `${detail.profile.primaryField.label} proposed: ${view.item.primary.label}` : null,
          view.item.cohortLabel,
        ]}
        actions={
          order.length > 1 && pos >= 0 ? (
            <div className="flex items-center gap-2">
              <span className="text-[13px] text-muted-foreground tabular-nums">
                {pos + 1} of {order.length}
              </span>
              {prev ? (
                <Link href={`${base}/items/${prev.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  <ChevronLeft aria-hidden />
                  Previous
                </Link>
              ) : null}
              {next ? (
                <Link href={`${base}/items/${next.id}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Next incident
                  <ChevronRight aria-hidden />
                </Link>
              ) : null}
            </div>
          ) : null
        }
      />
      {scoreHelp.length ? (
        <details id="score-help" className="-mt-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer rounded-sm py-0.5 [&>svg]:mr-1 [&>svg]:inline [&>svg]:align-[-2px]">
            <Info className="size-3.5" aria-hidden />
            What the scores mean
          </summary>
          <dl className="mt-1 grid max-w-[80ch] grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {scoreHelp.map((f) => (
              <div key={f.key} className="contents">
                <dt className="font-medium text-foreground">{f.label}</dt>
                <dd>{f.description}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      <RoleNote text={review?.findings.length ? decideFindingsNote(getAppPolicy().policy, role) : null} alias={space.alias} />
      {view.reviews.length > 1 ? (
        <nav aria-label="Reviews of this investigation" className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">Reviews:</span>
          {view.reviews.map((r) => (
            <Link
              key={r.id}
              href={r.current ? `${base}/items/${view.item.id}` : `${base}/items/${view.item.id}?review=${r.id}`}
              aria-current={r.id === review?.id ? "page" : undefined}
              className={cn(buttonVariants({ variant: r.id === review?.id ? "secondary" : "ghost", size: "sm" }))}
            >
              {r.current ? "Current: " : ""}
              {formatTime(r.startedAt, "datetime", zone)}
              {r.state === "failed" ? ", failed" : ""}
            </Link>
          ))}
          {review && !review.current ? <span className="text-xs text-muted-foreground">An earlier review is read only.</span> : null}
        </nav>
      ) : null}
      {files.visible ? (
        <ReviewFilesCard
          alias={space.alias}
          auditId={audit.id}
          itemId={view.item.id}
          incident={incident}
          download={{ enabled: files.download.enabled, reason: files.download.disabledReason }}
          import={{ enabled: files.import.enabled, reason: files.import.disabledReason }}
          maxUploadMb={maxUploadMb}
        />
      ) : null}
      {waitingForFile ? (
        <EmptyState title="Waiting for a review file">Its findings appear here when its review is imported.</EmptyState>
      ) : null}
      {running && !review ? (
        <EmptyState title="This investigation is being reviewed">
          Its findings appear here when the review finishes.
          {audit.runId ? (
            <div className="mt-2">
              <LiveJobProgress runId={audit.runId} />
            </div>
          ) : null}
        </EmptyState>
      ) : null}
      <ReviewWorkspace
        alias={space.alias}
        auditId={audit.id}
        itemId={view.item.id}
        incident={incident}
        totalRecords={view.journalPresent ? totalRecords : null}
        groundTruth={groundTruth}
        finalAnswer={highlights?.agentFinalAnswer ? { text: highlights.agentFinalAnswer, record: highlights.scoredSummaryRecord } : null}
        findings={cards}
        initial={{ citation: first, fieldLabel: firstLabel, data: initialData && "missing" in initialData ? initialData : initialData ? { ...initialData, createdAt: initialData.createdAt.toISOString() } : null }}
        reviewable={reviewable}
        counts={counts}
        callout={callouts.length ? <div className="space-y-3">{callouts.slice(0, 3)}</div> : null}
      />
    </>
  );
}
