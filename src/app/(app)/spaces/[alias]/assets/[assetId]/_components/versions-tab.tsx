import { ArrowRight, Lock } from "lucide-react";
import Link from "next/link";
import { ActionButton, type ActionResult } from "@/components/assets/action-button";
import { AddReasonButton } from "@/components/assets/add-reason-form";
import { FileDiffView, ValueChanges } from "@/components/assets/diff-view";
import { assetTabHref, restoreConfirm } from "@/components/assets/format";
import { VersionStrip } from "@/components/assets/version-strip";
import { ComparePanel } from "@/components/assets/view-toggle";
import { Callout } from "@/components/common/callout";
import { DisabledReason } from "@/components/common/disabled-reason";
import { EmptyState } from "@/components/common/empty-state";
import { SectionCard } from "@/components/common/section-card";
import { SourceBadge } from "@/components/common/source-badge";
import { displayPrincipal, shortSourceLabel } from "@/components/common/source-labels";
import { Time } from "@/components/common/time";
import { formatTime } from "@/components/common/time-format";
import { VersionBadge } from "@/components/common/version-badge";
import { getViewerZone } from "@/components/common/viewer-zone";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CHANGE_SOURCES } from "@/lib/assets/types";
import type { AssetPageView, CompareSide } from "@/server/assets/asset-page";
import { safeHttpUrl } from "@/server/assets/reasons";
import { changeKindLabel, previousEntry, restorableVersion, stripLabels, VERSION_STRIP_MAX, versionRef } from "@/server/assets/versions";
import { addReasonAction } from "../../../history/actions";

const ghostSm = buttonVariants({ variant: "ghost", size: "sm" });

function Side({ side, label }: { side: CompareSide; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <VersionBadge version={side.version} />
      <SourceBadge source={side.entry.source} principal={side.entry.principal} recordedLabel={side.entry.sourceLabel} />
      {side.entry.updatedAt ? <Time value={side.entry.updatedAt} format="date" className="text-muted-foreground" /> : null}
      <span className="sr-only">{label}</span>
    </span>
  );
}

function Compare({ view, restore, canPlan }: { view: AssetPageView; restore: (() => Promise<ActionResult | void>) | null; canPlan: boolean }) {
  const c = view.compare;
  if (!c) return null;
  if (!c.ok) {
    return (
      <div className="border-t p-4">
        <Callout tone="warning" title="These versions can't be compared">
          {c.message}
        </Callout>
      </div>
    );
  }
  const changed = c.diff.files.filter((f) => f.status !== "unchanged");
  const unchanged = c.diff.files.length - changed.length;
  const added = changed.reduce((n, f) => n + f.added, 0);
  const removed = changed.reduce((n, f) => n + f.removed, 0);
  const many = c.diff.files.length > 1;
  const files = (layout: "unified" | "split") =>
    changed.length === 0 ? (
      <EmptyState title="No file changes">{c.diff.metadata.length ? "Only the metadata differs. Switch to Metadata to see it." : "These versions have the same content."}</EmptyState>
    ) : (
      <div>
        {changed.map((f) => (
          <FileDiffView key={f.path} file={f} layout={layout} showHeader={many || f.status !== "modified"} />
        ))}
        {unchanged > 0 ? (
          <p className="border-t px-4 py-2 text-xs text-muted-foreground">
            {unchanged} unchanged {unchanged === 1 ? "file" : "files"} not shown.
          </p>
        ) : null}
      </div>
    );
  const metadata = (
    <div className="space-y-0">
      <h3 className="px-4 pt-3 pb-1.5 text-xs font-semibold text-muted-foreground">Metadata</h3>
      <ValueChanges changes={c.diff.metadata} empty="The metadata is the same in both versions." />
      <h3 className="border-t px-4 pt-3 pb-1.5 text-xs font-semibold text-muted-foreground">Version fields</h3>
      <ValueChanges changes={c.diff.fields} empty="The version fields are the same." />
    </div>
  );
  const lockReason = view.actions.contentLocked;
  const showRestore = canPlan && view.actions.typeEditable;
  return (
    <>
      <ComparePanel
        bar={
          <>
            <Side side={c.from} label="older version" />
            <ArrowRight className="size-4 text-muted-foreground" aria-label="to" />
            <Side side={c.to} label="newer version" />
          </>
        }
        added={added}
        removed={removed}
        initial={changed.length === 0 && c.diff.metadata.length > 0 ? "metadata" : "content"}
        unified={files("unified")}
        split={files("split")}
        metadata={metadata}
      />
      {showRestore ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2.5">
          <p className="text-xs text-muted-foreground">Restoring an older version creates a plan. Nothing changes in the space until the plan is applied.</p>
          {lockReason || !restore ? (
            <DisabledReason reason={lockReason ?? "This version can't be restored."}>
              <Button size="sm" variant="outline">
                Restore v{c.from.version} as a plan
              </Button>
            </DisabledReason>
          ) : (
            <ActionButton action={restore} pendingLabel="Creating plan" icon="restore" confirm={restoreConfirm(view.detail.displayName, c.from.version)}>
              Restore v{c.from.version} as a plan
            </ActionButton>
          )}
        </div>
      ) : null}
    </>
  );
}

function Reasons({ alias, view, entry, canReason, openForm }: { alias: string; view: AssetPageView; entry: AssetPageView["entries"][number]; canReason: boolean; openForm: boolean }) {
  const name = view.detail.displayName;
  return (
    <div className="space-y-1.5">
      {entry.planId && entry.source === "app" ? (
        <p className="text-xs text-muted-foreground">
          Applied through this app.{" "}
          <Link className="font-medium underline underline-offset-4 hover:text-foreground" href={`/spaces/${encodeURIComponent(alias)}/plans/${encodeURIComponent(entry.planId)}`}>
            Open the plan
          </Link>
        </p>
      ) : null}
      {entry.notes.map((n, i) => {
        const href = safeHttpUrl(n.link);
        return (
          <div key={i}>
            <p className="break-words whitespace-pre-wrap">{n.reason}</p>
            <p className="text-xs text-muted-foreground">
              {n.addedBy}
              {n.addedAt ? (
                <>
                  {n.addedBy ? " · " : null}
                  <Time value={n.addedAt} format="date" />
                </>
              ) : null}
              {href ? (
                <>
                  {" · "}
                  <a className="underline underline-offset-4" href={href} rel="noopener noreferrer nofollow" target="_blank">
                    Link
                  </a>
                </>
              ) : null}
            </p>
          </div>
        );
      })}
      {entry.pendingReasons.map((r) => (
        <div key={r.id}>
          <p className="break-words whitespace-pre-wrap">{r.reason}</p>
          <p className="text-xs text-muted-foreground">{r.addedBy} · saved, not in the history repository yet</p>
        </div>
      ))}
      {canReason && entry.canAddReason && entry.commitHash && entry.notes.length === 0 && entry.pendingReasons.length === 0 ? (
        <AddReasonButton
          alias={alias}
          assetId={view.detail.asset.assetId}
          commit={entry.commitHash}
          target={`${name}${entry.version !== null ? ` v${entry.version}` : ""}`}
          action={addReasonAction}
          variant="ghost"
          defaultOpen={openForm}
        />
      ) : null}
      {!entry.planId && entry.notes.length === 0 && entry.pendingReasons.length === 0 && !(canReason && entry.canAddReason) ? <span className="text-muted-foreground">-</span> : null}
    </div>
  );
}

const RESTORE_LOCK_ID = "restore-lock-reason";

export async function VersionsTab({
  alias,
  view,
  canReason,
  canPlan,
  restoreFor,
  openReason = null,
}: {
  alias: string;
  view: AssetPageView;
  canReason: boolean;
  canPlan: boolean;
  /** ?reason=<version>: open the reason form of that version (History's "Add reason" links here) */
  openReason?: number | null;
  /** The "Restore" action bound to one version, when the user may create the plan and the asset can be restored */
  restoreFor: ((version: number) => () => Promise<ActionResult | void>) | null;
}) {
  const { detail, points, entries } = view;
  const restore = view.compare?.ok && restoreFor ? restoreFor(view.compare.from.version) : null;
  // Same rules as the compare's restore button: shown with plans.create on an editable type, disabled with the lock reason.
  const showRestore = canPlan && view.actions.typeEditable;
  const lockReason = view.actions.contentLocked ?? (restoreFor ? null : "This version can't be restored.");
  const deleted = Boolean(detail.asset.deletedAt);
  const assetId = detail.asset.assetId;
  const attribution = detail.policy.attribution;
  const zone = await getViewerZone();
  const compare = view.compare?.ok ? view.compare : null;
  const selected = compare ? [compare.from.version, compare.to.version] : [];
  const labels = stripLabels(points, selected);
  const present = new Set(points.map((p) => p.source));
  const showStrip = points.length >= 2 && points.length <= VERSION_STRIP_MAX;
  const reasonKey = openReason !== null ? entries.find((e) => e.version === openReason)?.key : undefined;

  return (
    <div className="space-y-4">
      {showStrip || view.compare ? (
        <Card className="gap-0 overflow-hidden py-0" role="region" aria-label="Compare versions">
          {showStrip ? (
            <VersionStrip
              versions={points.map((p) => ({ version: p.version, source: p.source, sourceLabel: shortSourceLabel(p.source, attribution), labeled: labels.has(p.version) }))}
              from={compare?.from.version ?? null}
              to={compare?.to.version ?? null}
              legend={CHANGE_SOURCES.filter((s) => present.has(s)).map((s) => ({ source: s, label: shortSourceLabel(s, attribution) }))}
              firstDate={points[0]?.at ? formatTime(points[0].at, "date", zone) : ""}
              lastDate={points.at(-1)?.at ? formatTime(points.at(-1)!.at!, "date", zone) : ""}
            />
          ) : (
            <h2 className="px-4 pt-3.5 pb-3 text-sm font-semibold">Compare versions</h2>
          )}
          <Compare view={view} restore={restore} canPlan={canPlan} />
        </Card>
      ) : null}

      <SectionCard id="all-versions" title="All versions" aside={<span className="text-xs text-muted-foreground tabular-nums">{entries.length} recorded changes</span>}>
        {entries.length > 0 && showRestore ? (
          <p id={lockReason ? RESTORE_LOCK_ID : undefined} className="flex items-center gap-1.5 border-b px-4 py-2 text-xs text-muted-foreground">
            {lockReason ? <Lock className="size-3.5 shrink-0" aria-hidden /> : null}
            {lockReason ? `Restore is off: ${lockReason}` : "Restoring a version creates a plan. Nothing changes in the space until the plan is applied."}
          </p>
        ) : null}
        {entries.length === 0 ? (
          <EmptyState title="No versions recorded yet">Versions appear here after a sync saves this asset in the history.</EmptyState>
        ) : (
          <Table className="text-[13px]">
            <caption className="sr-only">Recorded versions of {detail.displayName}, newest first</caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-20 pl-4">Version</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Changed by</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => {
                const ref = versionRef(entries, e);
                const prev = e.state === "deleted" ? null : previousEntry(entries, e);
                const prevRef = prev ? versionRef(entries, prev) : null;
                const label = e.version !== null ? `v${e.version}` : "this change";
                const restorable = showRestore ? restorableVersion(entries, e, { deleted }) : null;
                return (
                  <TableRow key={e.key} className="align-top">
                    <TableCell className="py-2 pl-4">{e.state === "deleted" ? <VersionBadge version="deleted" /> : e.version !== null ? <VersionBadge version={e.version} /> : "-"}</TableCell>
                    <TableCell className="py-2">
                      <SourceBadge source={e.source} principal={e.principal} recordedLabel={e.sourceLabel} />
                    </TableCell>
                    <TableCell className="max-w-56 py-2 whitespace-normal">
                      {/* Agent and unknown rows store the source label as the principal; the badge already says it. */}
                      {e.principal && e.source !== "agent" && e.source !== "unknown" ? (
                        <span className="block font-mono text-xs break-words" title={e.principal}>
                          {displayPrincipal(e.principal)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="py-2 whitespace-nowrap">{e.updatedAt ? <Time value={e.updatedAt} format="datetime" /> : "-"}</TableCell>
                    <TableCell className="py-2">{changeKindLabel(e.changeKind ?? (e.state === "deleted" ? "deleted" : null))}</TableCell>
                    <TableCell className="max-w-80 py-2">
                      <Reasons alias={alias} view={view} entry={e} canReason={canReason} openForm={e.key === reasonKey} />
                    </TableCell>
                    <TableCell className="py-1.5 pr-4">
                      <div className="flex flex-wrap items-center justify-end gap-x-1 gap-y-1 whitespace-nowrap">
                        {ref && e.state !== "deleted" ? (
                          <Link className={ghostSm} href={assetTabHref(alias, assetId, "content", { version: ref })}>
                            View<span className="sr-only"> {label}</span>
                          </Link>
                        ) : null}
                        {ref && prevRef ? (
                          <Link className={ghostSm} href={assetTabHref(alias, assetId, "versions", { from: prevRef, to: ref })}>
                            Compare with previous<span className="sr-only"> for {label}</span>
                          </Link>
                        ) : null}
                        {restorable !== null ? (
                          lockReason || !restoreFor ? (
                            <Button size="sm" variant="ghost" disabled aria-describedby={RESTORE_LOCK_ID}>
                              Restore this version<span className="sr-only"> ({label})</span>
                            </Button>
                          ) : (
                            <ActionButton action={restoreFor(restorable)} pendingLabel="Creating plan" icon="restore" confirm={restoreConfirm(detail.displayName, restorable)}>
                              Restore this version<span className="sr-only"> ({label})</span>
                            </ActionButton>
                          )
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}
