import { CircleCheck, CircleX, Tag } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { spaceBase } from "@/components/app-shell/nav";
import { Callout, type CalloutTone } from "@/components/common/callout";
import { LiveJobProgress } from "@/components/common/live-job-progress";
import { PageHeader } from "@/components/common/page-header";
import { SectionCard } from "@/components/common/section-card";
import { StatusBadge } from "@/components/common/status-badge";
import { Time } from "@/components/common/time";
import { AutoRefresh } from "@/components/plans/auto-refresh";
import { loadPlansPage } from "@/components/plans/page-guard";
import { ChangeList, type ChangeGroup, type ChangeRow } from "@/components/plans/change-list";
import { ApprovalControls, PlanActionButton } from "@/components/plans/plan-controls";
import { SelectedItemCard } from "@/components/plans/selected-item-card";
import { ConnectionNextStep } from "@/components/common/connection-next-step";
import { CHANGE_WORDS } from "@/components/common/status-words";
import { DIFF_CHECK_FAILED, DIFF_NOT_READY, groupPlanItems, itemChangeWord, planStateBadge, reasonLockedText, SYNCED_COMPARISON_NOTE, SYNCED_VALIDATION_NOTE } from "@/components/plans/words";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { firstParam } from "@/server/assets/guard";
import { liveErrorNeedsSettings } from "@/server/assets/live";
import { loadPlanReview, type PlanCallout, type PlanItemView, type PlanReview } from "@/server/plans/loaders";
import { WORKER_WAIT_TEXT } from "@/server/jobs/words";
import { roleReasonsFor } from "@/server/plans/service";
import { isBusyState } from "@/server/plans/view";
import { applyPlanAction, approvePlanAction, discardPlanAction, recheckPlanAction, rejectPlanAction, requestApprovalAction, retryFailedAction } from "./actions";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEVERITY: Record<CalloutTone, number> = { destructive: 0, warning: 1, info: 2, success: 3 };
const outlineSm = buttonVariants({ variant: "outline", size: "sm" });
const ghostSm = buttonVariants({ variant: "ghost", size: "sm" });

/** Plan review (design-system pages/plan-review.md). */
export default async function PlanReviewPage({ params, searchParams }: PageProps<"/spaces/[alias]/plans/[planId]">) {
  const { alias, planId } = await params;
  const { user, space, perms, role, viewer } = await loadPlansPage(alias);
  if (!UUID_RE.test(planId)) notFound();
  const item = firstParam((await searchParams).item);
  const r = await loadPlanReview(space.id, planId, viewer, { selectedItemId: item && UUID_RE.test(item) ? item : null });
  if (!r) notFound();

  const base = spaceBase(space.alias);
  const planHref = `${base}/plans/${r.plan.id}`;
  // A check job that failed before it could record a result leaves the plan "checking": stop refreshing and say so.
  const checkFailed = r.jobs.check?.status === "failed";
  const checkWaiting = r.jobs.check?.waitingForWorker === true;
  const busy = isBusyState(r.plan.state) && !checkFailed;
  // A check that failed still records checkedAt; only a check that finished gives counts and a diff.
  const checked = r.plan.checkedAt !== null && !r.plan.checkError;
  const author = r.plan.authorName ?? r.plan.author;

  // Re-check and retry need plans.create; a role that never has it doesn't see them (MASTER "Disabled and hidden actions").
  // A failed check: the cause, then the next step for the caller's role (Space settings is a link for Admins).
  const canManage = perms.has("spaces.manage");
  const nextStep =
    r.plan.checkError && liveErrorNeedsSettings(r.plan.checkError) ? (
      <ConnectionNextStep alias={space.alias} canManage={canManage} />
    ) : perms.has("plans.create") ? (
      "Re-check the live space to try again."
    ) : null;
  const synced = r.plan.comparedWith === "synced";

  const callouts = buildCallouts(r, { base, planHref, canRelease: perms.has("releases.create"), canCreate: perms.has("plans.create"), alias: space.alias, nextStep });

  const showProgress = r.jobs.showProgress;
  const notes = r.plan.notes.filter(Boolean);
  const groups: ChangeGroup[] = groupPlanItems(r.items).map((g) => ({ key: g.key, label: g.label, rows: g.items.map((i) => changeRow(i, showProgress)) }));
  const order = groups.flatMap((g) => g.rows.map((row) => row.id));
  const at = r.selected ? order.indexOf(r.selected.id) : -1;
  const hrefOf = (id: string | undefined) => (id ? `${planHref}?item=${id}` : null);
  const nav = at >= 0 ? { position: at + 1, total: order.length, prevHref: hrefOf(order[at - 1]), nextHref: hrefOf(order[at + 1]) } : undefined;

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={[{ label: "Plans", href: `${base}/plans` }, { label: r.plan.title }]} />
      <AutoRefresh active={busy} seconds={checkWaiting ? 10 : 3} />
      <PageHeader
        title={r.plan.title}
        badges={<StatusBadge {...planStateBadge(r.plan.state, r.plan.checkFailed, r.plan.validationFailed)} />}
        meta={[
          r.plan.origin.kind === "drafts" ? `Plan by ${author} from ${r.plan.draftCount} ${r.plan.draftCount === 1 ? "draft" : "drafts"}` : `Plan by ${author}`,
          // A restore plan's title already is its origin line ("Restore overview to v3"): say it once.
          r.plan.origin.kind === "drafts" || r.plan.originLine === r.plan.title ? null : <OriginLink key="origin" r={r} base={base} />,
          r.plan.checkedAt && r.plan.checkError ? (
            <span key="checked">
              Live-space check failed at <Time value={r.plan.checkedAt} format="datetime" />
            </span>
          ) : r.plan.checkedAt ? (
            <span key="checked">
              checked against the live space <Time value={r.plan.checkedAt} format="datetime" />
            </span>
          ) : (
            "not checked yet"
          ),
        ]}
        actionsClassName="items-start"
        actions={
          <>
            {r.actions.discard?.enabled ? (
              <PlanActionButton
                button={r.actions.discard}
                variant="ghost"
                run={discardPlanAction.bind(null, space.alias, r.plan.id)}
                done="Plan discarded"
                navigateTo={`${base}/plans`}
                confirmTitle="Discard this plan?"
                confirmBody={r.items.some((i) => i.draftId) ? "The drafts stay saved." : "Nothing changes in the space."}
                confirmLabel="Discard plan"
              />
            ) : null}
            <ApprovalControls
              alias={space.alias}
              planId={r.plan.id}
              spaceName={r.space.name}
              actions={r.actions}
              reason={r.plan.reason}
              reasonRequired={r.approval.reasonRequired}
              reasonLocked={reasonLockedText(r.actions, r.plan.state, roleReasonsFor(r.plan.origin, role).apply)}
              confirm={r.confirm}
              steps={r.whatApplyDoes}
              facts={<ApprovalFacts r={r} />}
              closedNote={<ClosedNote r={r} />}
              run={{ requestApproval: requestApprovalAction, approve: approvePlanAction, reject: rejectPlanAction, apply: applyPlanAction }}
            />
          </>
        }
      />

      {callouts.length ? (
        <section aria-label="Needs attention" className="space-y-2">
          {callouts.slice(0, 3).map((c) => (
            <div key={c.key}>{c.node}</div>
          ))}
        </section>
      ) : null}

      {synced ? <p className="text-[13px] text-muted-foreground">{SYNCED_COMPARISON_NOTE}</p> : null}
      <section aria-label="Plan summary" className="flex flex-wrap gap-2">
        <SummaryChip n={r.tiles.contentUpdates} one="content update" many="content updates" />
        <SummaryChip n={r.tiles.statusChanges} one="status change" many="status changes" />
        {r.tiles.metadataUpdates > 0 ? <SummaryChip n={r.tiles.metadataUpdates} one="metadata update" many="metadata updates" /> : null}
        {r.tiles.creates ? <SummaryChip n={r.tiles.creates} one="create" many="creates" /> : null}
        {r.tiles.deletes ? <SummaryChip n={r.tiles.deletes} one="delete" many="deletes" tone="destructive" title="A snapshot is committed before each delete" /> : null}
        {checked ? (
          <SummaryChip n={r.tiles.skipped} one="skipped" many="skipped" tone={r.tiles.skipped > 0 ? "warning" : undefined} title={r.tiles.skipped ? "Changed in the live space since this plan was made" : "No asset changed in the live space since this plan was made"} />
        ) : (
          <SummaryChip text="Skips not checked yet" />
        )}
        {
          // Validation needs no live read, so it also runs in the comparison with the last synced version.
          !checked && !synced ? (
            <SummaryChip text="Validation not checked yet" />
          ) : (
            <SummaryChip
              icon={r.tiles.validation.passed ? <CircleCheck className="size-3.5 text-success-fg" aria-hidden /> : <CircleX className="size-3.5 text-destructive-fg" aria-hidden />}
              text={`${r.tiles.validation.passed ? "Validation passed" : `Validation failed for ${r.tiles.validation.failed}`}${r.tiles.validation.warnings ? `, ${r.tiles.validation.warnings} ${r.tiles.validation.warnings === 1 ? "warning" : "warnings"}` : ""}`}
              title={`${r.tiles.validation.checks} ${r.tiles.validation.checks === 1 ? "check" : "checks"}, ${r.tiles.validation.failed} failed${synced ? `, ${SYNCED_VALIDATION_NOTE}` : ""}`}
            />
          )
        }
      </section>

      {/* The list and the diff scroll on their own and fill the window below the top bar (72 px above, 16 px below), so the page doesn't grow with the plan. */}
      <div className="grid gap-4 lg:h-[calc(100dvh-88px)] lg:min-h-[32rem] lg:grid-cols-[340px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
        <ChangeList
          groups={groups}
          planHref={planHref}
          selectedId={r.selected?.id ?? null}
          className="max-lg:max-h-[60vh] lg:min-h-0"
          top={r.plan.state === "applying" && r.jobs.applyRunId ? <LiveJobProgress runId={r.jobs.applyRunId} /> : undefined}
        />
        {r.selected ? (
          <SelectedItemCard item={r.selected} nav={nav} className="max-lg:max-h-[85vh] lg:min-h-0" notReady={r.plan.checkError || checkFailed ? DIFF_CHECK_FAILED : DIFF_NOT_READY} />
        ) : (
          <Card className="justify-center py-0 lg:min-h-0">
            <p className="px-4 py-3 text-center text-[13px] text-muted-foreground">Choose a change to see its diff.</p>
          </Card>
        )}
      </div>
      {notes.length ? (
        <SectionCard id="plan-notes-h" title="Notes">
          <ul className="list-disc space-y-1 py-3 pr-4 pl-9 text-[13px]">
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}

function OriginLink({ r, base }: { r: PlanReview; base: string }) {
  const o = r.plan.origin;
  if (o.kind === "retry" && r.plan.retryOf) {
    return (
      <Link href={`${base}/plans/${r.plan.retryOf.id}`} className="underline underline-offset-2 hover:text-foreground">
        {r.plan.originLine}
      </Link>
    );
  }
  if (o.kind === "rollback" && o.target.kind === "release") {
    return (
      <Link href={`${base}/releases/${encodeURIComponent(o.target.name)}`} className="underline underline-offset-2 hover:text-foreground">
        {r.plan.originLine}
      </Link>
    );
  }
  if (o.kind === "package") return <span>{`${r.plan.originLine}, ${o.fileName}`}</span>;
  return <span>{r.plan.originLine}</span>;
}

const PROGRESS_TONE: Record<NonNullable<PlanItemView["progress"]>, NonNullable<ChangeRow["progress"]>["tone"]> = {
  waiting: "muted",
  writing: "info",
  verifying: "info",
  done: "success",
  skipped: "warning",
  failed: "destructive",
};

/** A changes-list row: "Instructions · v8 → v9", the status direction, a skip, and while applying the item's progress. */
function changeRow(i: PlanItemView, showProgress: boolean): ChangeRow {
  const skipped = Boolean(i.conflict) && i.progress !== "done";
  const word = itemChangeWord(i.change, { skipped, status: i.changeBadge.label === "Set Inactive" ? "INACTIVE" : "ACTIVE" });
  const type = i.parentName ? `${i.typeLabel} in ${i.parentName}` : i.typeLabel;
  return {
    id: i.id,
    name: i.name,
    detail: [type, i.versionLabel, i.change === "status" && !skipped ? CHANGE_WORDS[word.word].label : null].filter(Boolean).join(" · "),
    note: skipped ? CHANGE_WORDS["skip-live-changed"].label : null,
    validation: i.validation,
    added: i.added ?? 0,
    removed: i.removed ?? 0,
    progress: showProgress
      ? {
          word: i.progressLabel ?? "Waiting",
          tone: i.progress ? PROGRESS_TONE[i.progress] : "muted",
          message: i.progressMessage && (i.progress === "failed" || i.progress === "skipped") ? i.progressMessage : null,
        }
      : null,
  };
}

const CHIP_TONE = { warning: "text-warning-fg", destructive: "text-destructive-fg" } as const;

/** One summary fact: "25 content updates", or a sentence ("Validation passed, 5 warnings"). */
function SummaryChip({ n, one, many, text, icon, tone, title }: { n?: number; one?: string; many?: string; text?: string; icon?: ReactNode; tone?: keyof typeof CHIP_TONE; title?: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1 text-[13px]">
      {icon}
      {n !== undefined ? <span className={cn("font-semibold tabular-nums", tone && CHIP_TONE[tone])}>{n}</span> : null}
      {n !== undefined ? (n === 1 ? one : many) : text}
    </span>
  );
}

function ApprovalFacts({ r }: { r: PlanReview }) {
  const a = r.approval;
  const rows: [string, ReactNode][] = [["Approval", a.approvalRequired ? "A second person must approve" : "Not required for this space"]];
  if (a.approvalRequired) {
    rows.push(["Can approve", a.canApprove]);
    if (a.approved) {
      rows.push([
        "Approved",
        <>
          {a.approved.name ?? a.approved.by}, <Time value={a.approved.at} format="datetime" />
        </>,
      ]);
    } else if (a.requested) {
      rows.push([
        "Requested",
        <>
          <Time value={a.requested.at} format="datetime" />, no response yet
        </>,
      ]);
    } else if (a.rejected) {
      rows.push([
        "Rejected",
        <>
          {a.rejected.by}, <Time value={a.rejected.at} format="datetime" />
          {a.rejected.note ? <span className="block text-muted-foreground">{a.rejected.note}</span> : null}
        </>,
      ]);
    }
  }
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function ClosedNote({ r }: { r: PlanReview }) {
  const at = r.lastApply?.finishedAt;
  if (r.plan.state === "applied") return <>Applied{at ? <> <Time value={at} format="datetime" /></> : null}. Nothing more to do on this plan.</>;
  if (r.plan.state === "failed") return <>Apply finished with failures{at ? <> <Time value={at} format="datetime" /></> : null}. Items already written stay written.</>;
  return <>This plan was discarded. Its drafts are open again.</>;
}

type CalloutCtx = { base: string; planHref: string; canRelease: boolean; canCreate: boolean; alias: string; nextStep: ReactNode };

function buildCallouts(r: PlanReview, ctx: CalloutCtx): { key: string; tone: CalloutTone; node: ReactNode }[] {
  const out: { key: string; tone: CalloutTone; node: ReactNode }[] = [];
  if (r.plan.state === "checking" && r.jobs.check?.waitingForWorker) {
    out.push({
      key: "check-waiting",
      tone: "warning",
      node: (
        <Callout tone="warning" title="The live-space check hasn't started">
          {WORKER_WAIT_TEXT}
        </Callout>
      ),
    });
  }
  const job = r.applyJob;
  if (r.plan.state === "applying" && job && (job.status === "failed" || job.status === "cancelled")) {
    out.push({
      key: "job",
      tone: "warning",
      node: (
        <Callout tone="warning" title="The apply job stopped and will retry">
          {job.error ? `${job.error} ` : null}The worker retries the job a few times; items already written are not written again. If it gives up, this plan becomes Failed.
        </Callout>
      ),
    });
  }
  for (const c of r.callouts) out.push({ key: c.kind, tone: c.tone, node: <PlanCalloutView c={c} r={r} ctx={ctx} /> });
  return out.sort((a, b) => SEVERITY[a.tone] - SEVERITY[b.tone]);
}

function PlanCalloutView({ c, r, ctx }: { c: PlanCallout; r: PlanReview; ctx: CalloutCtx }) {
  switch (c.kind) {
    case "conflict":
      return (
        <Callout
          tone="warning"
          title={c.title}
          action={c.action && ctx.canCreate ? <PlanActionButton button={{ ...c.action, action: "recheck" }} run={recheckPlanAction.bind(null, ctx.alias, r.plan.id)} done="Re-check started" /> : undefined}
        >
          {c.items.map((i) => (
            <span key={i.planItemId}>
              {i.fromVersion !== null && i.toVersion !== null ? (
                <>
                  {i.name} moved from v{i.fromVersion} to v{i.toVersion}
                  {i.at ? (
                    <>
                      {" "}
                      at <Time value={i.at} format="datetime" />
                    </>
                  ) : null}
                  {i.source ? ` (${i.source})` : ""}.{" "}
                </>
              ) : (
                `${i.message} `
              )}
            </span>
          ))}
          {c.items.length === 1 ? "Apply will skip it. Re-check to plan it again against the new version." : "Apply will skip them. Re-check to plan them again against the new versions."}
        </Callout>
      );
    case "validation":
      return (
        <Callout
          tone="destructive"
          title={c.title}
          action={
            c.action ? (
              <Link className={outlineSm} href={draftHref(ctx.base, r, c.action.draftId)}>
                Open draft
              </Link>
            ) : undefined
          }
        >
          {c.body}
          {c.planErrors.length ? <span className="mt-1 block">{c.planErrors.map((e) => e.message).join(" ")}</span> : null}
        </Callout>
      );
    case "check-failed":
      return (
        <Callout
          tone="destructive"
          title={c.title}
          action={c.action && ctx.canCreate ? <PlanActionButton button={{ ...c.action, action: "recheck" }} run={recheckPlanAction.bind(null, ctx.alias, r.plan.id)} done="Re-check started" /> : undefined}
        >
          {c.body} {ctx.nextStep}
        </Callout>
      );
    case "applied":
      return (
        <Callout
          tone="success"
          title={c.title}
          action={
            <span className="flex flex-wrap gap-2">
              {ctx.canRelease && c.commit ? (
                <Link className={outlineSm} href={`${ctx.base}/releases?create=1&commit=${encodeURIComponent(c.commit)}&planId=${encodeURIComponent(r.plan.id)}`}>
                  <Tag aria-hidden />
                  Create release
                </Link>
              ) : null}
              <Link className={ghostSm} href={`${ctx.base}/history`}>
                View in History
              </Link>
            </span>
          }
        >
          {c.commit ? (
            <>
              Commit <span className="font-mono text-xs">{c.commit.slice(0, 7)}</span>
              {c.release ? ` · Release ${c.release}` : null}
            </>
          ) : (
            c.body
          )}
          {r.lastApply?.pushError ? <span className="mt-1 block text-muted-foreground">Not pushed yet: {r.lastApply.pushError}</span> : null}
        </Callout>
      );
    case "apply-failed":
      return (
        <Callout
          tone="destructive"
          title={c.title}
          action={
            c.action && ctx.canCreate ? (
              <PlanActionButton
                button={{ ...c.action, action: "retry-failed" }}
                run={retryFailedAction.bind(null, ctx.alias, r.plan.id)}
                navigateTo={`${ctx.base}/plans/{planId}`}
              />
            ) : undefined
          }
        >
          {c.items.length ? (
            <ul className="mb-1 list-disc pl-5">
              {c.items.map((i) => (
                <li key={i.planItemId}>
                  <span className="font-medium">{i.name}</span>
                  {i.message ? `: ${i.message}` : null}
                </li>
              ))}
            </ul>
          ) : null}
          {c.body}
        </Callout>
      );
  }
}

/** The draft editor of an item's draft: the asset's draft route, with ?draft= for another person's. */
function draftHref(base: string, r: PlanReview, draftId: string): string {
  const it = r.items.find((i) => i.draftId === draftId);
  return it?.assetId ? `${base}/assets/${encodeURIComponent(it.assetId)}/draft?draft=${encodeURIComponent(draftId)}` : `${base}/drafts`;
}

