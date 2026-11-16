import { CircleCheck, CircleX, FilePlus2, Power, SquarePen, Tag, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { spaceBase } from "@/components/app-shell/nav";
import { Callout, type CalloutTone } from "@/components/common/callout";
import { ChangeChip } from "@/components/common/change-chip";
import { LiveJobProgress } from "@/components/common/live-job-progress";
import { PageHeader } from "@/components/common/page-header";
import { SectionCard } from "@/components/common/section-card";
import { StatTile } from "@/components/common/stat-tile";
import { StatusBadge } from "@/components/common/status-badge";
import { Time } from "@/components/common/time";
import { AutoRefresh } from "@/components/plans/auto-refresh";
import { loadPlansPage } from "@/components/plans/page-guard";
import { ApproveApplyPanel, PlanActionButton } from "@/components/plans/plan-controls";
import { SelectedItemCard } from "@/components/plans/selected-item-card";
import { ConnectionNextStep } from "@/components/common/connection-next-step";
import { DIFF_CHECK_FAILED, DIFF_NOT_READY, itemChangeWord, planStateBadge, reasonLockedText, skipTileDetail, SYNCED_COMPARISON_NOTE, SYNCED_VALIDATION_NOTE, validationSpec } from "@/components/plans/words";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { firstParam } from "@/server/assets/guard";
import { liveErrorNeedsSettings } from "@/server/assets/live";
import { loadPlanReview, type PlanCallout, type PlanItemView, type PlanReview } from "@/server/plans/loaders";
import { WORKER_WAIT_TEXT } from "@/server/jobs/words";
import { REASONS } from "@/server/plans/actions";
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
  const checkFailedCause = r.callouts.find((c) => c.kind === "check-failed")?.body ?? null;
  const primaryReason =
    r.actions.primary?.disabledReason === REASONS.checkFailed && checkFailedCause ? (
      // One span, so the reason wraps as one line of text inside DisabledReason's flex row.
      <span>
        {checkFailedCause} {nextStep}
      </span>
    ) : undefined;
  const synced = r.plan.comparedWith === "synced";

  const callouts = buildCallouts(r, { base, planHref, canRelease: perms.has("releases.create"), canCreate: perms.has("plans.create"), alias: space.alias, nextStep });

  const showProgress = r.jobs.showProgress;
  const notes = r.plan.notes.filter(Boolean);

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
        actions={
          r.actions.discard?.enabled ? (
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
          ) : null
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
      <section aria-label="Plan summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile icon={<SquarePen />} label="Content updates" value={r.tiles.contentUpdates} detail={namesOf(r.items, "content") ?? "None"} />
        <StatTile icon={<Power />} label="Status changes" value={r.tiles.statusChanges} detail={statusDetail(r.items) ?? "None"} />
        <StatTile
          icon={<TriangleAlert />}
          label="Apply will skip"
          value={!checked ? <span className="text-muted-foreground">Not checked</span> : <span className={cn(r.tiles.skipped > 0 && "text-warning-fg")}>{r.tiles.skipped}</span>}
          detail={skipTileDetail(r.tiles.skipped, checked)}
        />
        {r.tiles.metadataUpdates > 0 ? <StatTile icon={<SquarePen />} label="Metadata updates" value={r.tiles.metadataUpdates} detail={namesOf(r.items, "metadata")} /> : null}
        {r.tiles.creates ? <StatTile icon={<FilePlus2 />} label="Creates" value={r.tiles.creates} detail={namesOf(r.items, "create")} /> : null}
        {r.tiles.deletes ? (
          <StatTile icon={<Trash2 />} label="Deletes" value={<span className="text-destructive-fg">{r.tiles.deletes}</span>} detail="A snapshot is committed before each delete" />
        ) : null}
        <StatTile
          icon={<CircleCheck />}
          label="Validation"
          value={
            // Validation needs no live read, so it also runs in the comparison with the last synced version.
            !checked && !synced ? (
              <span className="text-muted-foreground">Not checked</span>
            ) : r.tiles.validation.passed ? (
              <>
                <CircleCheck className="text-success-fg" aria-hidden />
                Passed
              </>
            ) : (
              <>
                <CircleX className="text-destructive-fg" aria-hidden />
                {r.tiles.validation.failed} failed
              </>
            )
          }
          detail={`${r.tiles.validation.checks} ${r.tiles.validation.checks === 1 ? "check" : "checks"}, ${r.tiles.validation.failed} failed${r.tiles.validation.warnings ? `, ${r.tiles.validation.warnings} ${r.tiles.validation.warnings === 1 ? "warning" : "warnings"}` : ""}${synced ? `, ${SYNCED_VALIDATION_NOTE}` : ""}`}
        />
      </section>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <Card className="gap-0 py-0" role="region" aria-labelledby="plan-items-h">
            <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2">
              <h2 id="plan-items-h" className="text-sm font-semibold">
                Changes in this plan
              </h2>
              <span className="text-xs text-muted-foreground tabular-nums">
                {r.items.length} {r.items.length === 1 ? "asset" : "assets"}
              </span>
            </div>
            {r.plan.state === "applying" && r.jobs.applyRunId ? (
              <div className="border-b px-4 py-3">
                <LiveJobProgress runId={r.jobs.applyRunId} />
              </div>
            ) : null}
            <ItemsTable items={r.items} planHref={planHref} showProgress={showProgress} synced={synced} />
          </Card>
          {r.selected ? <SelectedItemCard key={r.selected.id} item={r.selected} notReady={r.plan.checkError || checkFailed ? DIFF_CHECK_FAILED : DIFF_NOT_READY} /> : null}
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

        <aside className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1" aria-label="Approval">
          <SectionCard id="approve-h" title="Approve and apply">
            <ApproveApplyPanel
              alias={space.alias}
              planId={r.plan.id}
              spaceName={r.space.name}
              actions={r.actions}
              reason={r.plan.reason}
              reasonRequired={r.approval.reasonRequired}
              reasonLocked={reasonLockedText(r.actions, r.plan.state, roleReasonsFor(r.plan.origin, role).apply)}
              primaryReason={primaryReason}
              confirm={r.confirm}
              facts={<ApprovalFacts r={r} />}
              closedNote={<ClosedNote r={r} />}
              run={{ requestApproval: requestApprovalAction, approve: approvePlanAction, reject: rejectPlanAction, apply: applyPlanAction }}
            />
          </SectionCard>
          <SectionCard id="what-apply-h" title="What apply does">
            <ol className="list-decimal space-y-1.5 py-3 pr-4 pl-9 text-[13px]">
              {r.whatApplyDoes.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </SectionCard>
        </aside>
      </div>
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

/** Names of the items with this change, for a tile's detail line ("Instructions GENERIC, skill verity"). */
function namesOf(items: readonly PlanItemView[], change: PlanItemView["change"]): string | null {
  const hit = items.filter((i) => i.change === change && !i.conflict);
  if (!hit.length) return null;
  const shown = hit.slice(0, 3).map((i) => i.name);
  return hit.length > 3 ? `${shown.join(", ")} and ${hit.length - 3} more` : shown.join(", ");
}

function statusDetail(items: readonly PlanItemView[]): string | null {
  const hit = items.filter((i) => i.change === "status" && !i.conflict);
  if (!hit.length) return null;
  const off = hit.filter((i) => i.changeBadge.label === "Set Inactive").length;
  const on = hit.length - off;
  return [off ? `${off} set to Inactive` : null, on ? `${on} set to Active` : null].filter(Boolean).join(", ");
}

function ItemsTable({ items, planHref, showProgress, synced }: { items: readonly PlanItemView[]; planHref: string; showProgress: boolean; synced: boolean }) {
  return (
    <Table>
      <TableHeader className="bg-muted/50">
        <TableRow className="hover:bg-transparent">
          <TableHead className="pl-4 text-[13px] text-muted-foreground">Asset</TableHead>
          <TableHead className="text-[13px] text-muted-foreground">Change</TableHead>
          <TableHead className="text-[13px] text-muted-foreground">{synced ? "Last synced → new" : "Live → new"}</TableHead>
          <TableHead className={cn("text-[13px] text-muted-foreground", !showProgress && "pr-4")}>Validation</TableHead>
          {showProgress ? <TableHead className="pr-4 text-[13px] text-muted-foreground">Progress</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((i) => {
          const word = itemChangeWord(i.change, { skipped: Boolean(i.conflict) && i.progress !== "done", status: i.changeBadge.label === "Set Inactive" ? "INACTIVE" : "ACTIVE" });
          return (
            <TableRow key={i.id} className={cn("align-top", i.selected && "bg-foreground/5 shadow-[inset_3px_0_0_var(--foreground)] hover:bg-foreground/5")}>
              <TableCell className="min-w-48 py-2.5 pl-4 whitespace-normal">
                <Link
                  href={`${planHref}?item=${i.id}`}
                  scroll={false}
                  aria-current={i.selected ? "true" : undefined}
                  className="inline-flex min-h-6 items-center rounded-sm font-semibold break-words underline-offset-4 hover:underline"
                >
                  {i.name}
                </Link>
                <p className="text-xs text-muted-foreground">{i.parentName ? `${i.typeLabel} in ${i.parentName}` : i.typeLabel}</p>
              </TableCell>
              <TableCell className="py-3">
                <ChangeChip word={word.word} label={word.label} />
              </TableCell>
              <TableCell className="py-3 font-mono text-xs">{i.versionLabel}</TableCell>
              <TableCell className={cn("py-2.5", !showProgress && "pr-4")}>
                <StatusBadge {...validationSpec(i.validation)} />
              </TableCell>
              {showProgress ? (
                <TableCell className="py-3 pr-4 whitespace-normal">
                  <ProgressWord progress={i.progress} label={i.progressLabel} message={i.progressMessage} />
                </TableCell>
              ) : null}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

const PROGRESS_STYLE: Record<NonNullable<PlanItemView["progress"]>, string> = {
  waiting: "text-muted-foreground",
  writing: "text-info-fg",
  verifying: "text-info-fg",
  done: "text-success-fg",
  skipped: "text-warning-fg",
  failed: "text-destructive-fg",
};

function ProgressWord({ progress, label, message }: { progress: PlanItemView["progress"]; label: string | null; message: string | null }) {
  if (!progress) return <span className="text-[13px] text-muted-foreground">Waiting</span>;
  return (
    <div className="max-w-56 text-[13px]">
      <span className={cn("font-medium", PROGRESS_STYLE[progress])}>{label}</span>
      {message && (progress === "failed" || progress === "skipped") ? <p className="text-xs break-words text-muted-foreground">{message}</p> : null}
    </div>
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

