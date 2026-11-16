import { Check, Minus, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/common/empty-state";
import { Time } from "@/components/common/time";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { Policy } from "@/server/policy";
import type { ReleaseVerificationView } from "@/server/verify/loaders";
import type { RunCheckState } from "./action-state";
import { CheckCard } from "./check-card";
import { FileFilters } from "./file-filters";
import { lastRunProblem, ProblemCallout } from "./live-card";
import { changedSummary, fileRow, inLookView, orderRows, readCounts, skippedRow, visibleRows, type FileRowView, type FileShow } from "./views";
import { managedNote, NEVER_REQUESTED_NOTE, notComparedNote, type VerdictTone } from "./words";

const ICON = { success: Check, warning: TriangleAlert, muted: Minus } as const;
const TEXT: Record<VerdictTone, string> = { success: "text-success-fg", warning: "text-warning-fg", muted: "text-muted-foreground" };
const plural = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;

function typeLabel(policy: Pick<Policy, "assetTypes">, t: string): string {
  return policy.assetTypes.assetTypes[t]?.label ?? t;
}

function typeNoun(policy: Pick<Policy, "assetTypes">, t: string): string {
  return policy.assetTypes.assetTypes[t]?.noun?.other ?? typeLabel(policy, t);
}

function typePlural(policy: Pick<Policy, "assetTypes">, t: string): string {
  const other = typeNoun(policy, t);
  return other.charAt(0).toUpperCase() + other.slice(1);
}

/** The part of the table a row belongs to, when the release's changes are known. */
function groupOf(r: FileRowView): "changed" | "look" | "rest" {
  return r.changed ? "changed" : r.needsLook ? "look" : "rest";
}

const GROUP_WORDS = { changed: "Changed in this release", look: "Other files that need a look", rest: "Other files" } as const;

function FileTable({ rows, grouped }: { rows: readonly FileRowView[]; grouped: boolean }) {
  return (
    <Table>
      <TableHeader className="sticky top-0 bg-muted/50">
        <TableRow>
          <TableHead className="pl-4">File</TableHead>
          <TableHead className="text-right">Requested in</TableHead>
          <TableHead>What the agent got</TableHead>
          <TableHead className="pr-4">Records</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.flatMap((r, i) => {
          const Icon = ICON[r.tone];
          const group = groupOf(r);
          const header =
            grouped && (i === 0 || groupOf(rows[i - 1]!) !== group) ? (
              <TableRow key={`group:${group}`} className="bg-muted/30 hover:bg-muted/30">
                <TableCell colSpan={4} className="py-1.5 pl-4 text-xs font-semibold text-muted-foreground">
                  {GROUP_WORDS[group]}
                </TableCell>
              </TableRow>
            ) : null;
          return [
            header,
            <TableRow key={r.key} className="align-top">
              <TableCell className="max-w-[360px] min-w-[220px] py-2 pl-4 whitespace-normal">
                <div className="font-semibold break-words">{r.name}</div>
                <div className="text-xs text-muted-foreground">{r.typeLine}</div>
              </TableCell>
              <TableCell className="py-2 text-right tabular-nums">{r.requested ?? <span className="text-muted-foreground">Not checked</span>}</TableCell>
              <TableCell className="min-w-[240px] py-2 whitespace-normal">
                <span className={cn("inline-flex items-center gap-1.5", TEXT[r.tone])}>
                  <Icon className="size-4 shrink-0" aria-hidden />
                  {r.words}
                </span>
                {r.reason ? <div className="text-xs text-muted-foreground">{r.reason}</div> : null}
              </TableCell>
              <TableCell className="min-w-[200px] py-2 pr-4 whitespace-normal">
                {r.record ? (
                  <>
                    <Link href={r.record.href} className="inline-flex min-h-6 items-center break-words underline underline-offset-4">
                      {r.record.text}
                    </Link>
                    {r.more > 0 ? <div className="text-xs text-muted-foreground">and {r.more} more</div> : null}
                  </>
                ) : (
                  <span className="text-muted-foreground">None</span>
                )}
              </TableCell>
            </TableRow>,
          ];
        })}
      </TableBody>
    </Table>
  );
}

export function ReadsCard({
  alias,
  view,
  action,
  canManage,
  canExport,
  show,
  type,
  policy,
  baseHref,
}: {
  alias: string;
  view: ReleaseVerificationView;
  action: ((prev: RunCheckState) => Promise<RunCheckState>) | null;
  canManage: boolean;
  canExport: boolean;
  show: FileShow;
  type: string | null;
  policy: Pick<Policy, "assetTypes">;
  /** This tab's URL, for "Show all <N> files" */
  baseHref: string;
}) {
  const check = view.reads;
  const last = check.lastResult;
  const problem = lastRunProblem(check);
  const result = last?.result ?? null;
  const live = view.live.lastResult?.result ?? null;

  const changed = view.changes ? new Set(view.changes.assetIds) : null;
  const rows = result
    ? orderRows([
        ...result.files.map((f) => fileRow(f, { live, stores: result.stores, changed })),
        ...result.skipped.map((s) => skippedRow(s, typeLabel(policy, s.assetType), null, changed)).filter((r): r is FileRowView => r !== null),
      ])
    : [];
  const types = [...new Set(rows.map((r) => r.assetType))].map((t) => ({ value: t, label: typePlural(policy, t) }));
  const typeFilter = type && types.some((t) => t.value === type) ? type : null;
  const look = rows.filter(inLookView).length;
  const answer = result
    ? changedSummary({ changes: view.changes, files: result.files, skipped: result.skipped, investigations: result.investigations, typeNoun: (t) => typeNoun(policy, t) })
    : null;
  const shown = visibleRows(rows, { show, type: typeFilter });
  const hiddenByLook = show === "look" ? visibleRows(rows, { show: "all", type: typeFilter }).length - shown.length : 0;
  const managed = managedNote(result?.skipped.filter((s) => s.reason === "managed").length ?? 0);
  const notComparedTypes = [...new Set((result?.skipped ?? []).filter((s) => s.reason === "not-compared").map((s) => s.assetType))];
  // A type the check doesn't compare whose contents it does compare (memory stores and their memories), so the note doesn't read as "memories".
  const comparedTypes = new Set((result?.files ?? []).map((f) => f.assetType));
  const container = notComparedTypes
    .map((t) => ({ t, item: [...comparedTypes].find((c) => policy.assetTypes.assetTypes[c]?.references?.some((r) => r.assetType === t && r.required)) }))
    .find((x) => x.item);
  const notCompared = notComparedNote(
    notComparedTypes.map((t) => typeNoun(policy, t)),
    { inside: container ? { items: typeNoun(policy, container.item!), containers: typeNoun(policy, container.t) } : null },
  );

  const meta = result ? (
    <>
      {plural(result.investigations, "investigation", "investigations")} since the release
      {result.investigationsInWindow > result.investigations ? ` (the newest ${result.investigations} of ${result.investigationsInWindow})` : ""} · last checked{" "}
      <Time value={last!.run.finishedAt ?? last!.run.createdAt} format="datetime" />
    </>
  ) : view.window.investigations > 0 ? (
    `${plural(view.window.investigations, "investigation", "investigations")} since the release`
  ) : null;

  const noJournals = check.cannotRun?.reason === "no-journals";
  const exportHref = `/spaces/${encodeURIComponent(alias)}/journals/exports`;

  return (
    <CheckCard
      titleId="verify-reads-title"
      title="What the agent read"
      meta={meta}
      staleNote={view.stale?.reads ? "New journals since the last check" : null}
      action={action}
      openRunId={check.open?.jobRunId ?? null}
      open={Boolean(check.open)}
      disabledReason={check.cannotRun ? (noJournals ? "No investigations since this release to check." : check.cannotRun.message) : null}
      startedText="Agent read check requested"
    >
      {problem ? <ProblemCallout problem={problem} alias={alias} canManage={canManage} /> : null}
      {result ? (
        <>
          {answer ? (
            <p className="border-b px-4 py-3 text-[13px] font-medium" data-testid="verify-answer">
              {answer}
            </p>
          ) : null}
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b px-4 py-3">
            {answer ? <span className="text-xs text-muted-foreground">Every compared file:</span> : null}
            {readCounts(result.files).map((c) => (
              <span key={c.key} className="text-[13px]">
                <b className={cn("mr-1.5 text-lg font-semibold tabular-nums", c.tone === "warning" && c.n > 0 ? "text-warning-fg" : "")}>{c.n}</b>
                {c.words}
              </span>
            ))}
          </div>
          {rows.length ? (
            <>
              <FileFilters show={show} look={look} all={rows.length} type={typeFilter} types={types} />
              {shown.length ? (
                <FileTable rows={shown} grouped={Boolean(changed)} />
              ) : (
                <EmptyState title={show === "look" ? "Nothing needs a look" : "No files of this type"}>
                  {show === "look" ? "Every file the agent requested came back with the release's body." : "Choose another type, or show all types."}
                </EmptyState>
              )}
            </>
          ) : (
            <EmptyState title="No files to compare">The release has no skill or memory files the check can compare.</EmptyState>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
            <div className="space-y-0.5">
              <p>{NEVER_REQUESTED_NOTE}</p>
              {managed ? <p>{managed}</p> : null}
              {notCompared ? <p>{notCompared}</p> : null}
            </div>
            {hiddenByLook > 0 ? (
              <Link href={`${baseHref}?files=all${typeFilter ? `&type=${encodeURIComponent(typeFilter)}` : ""}`} scroll={false} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Show all {plural(visibleRows(rows, { show: "all", type: typeFilter }).length, "file", "files")}
              </Link>
            ) : null}
          </div>
        </>
      ) : noJournals ? (
        <EmptyState
          title="No investigations since this release"
          action={
            canExport ? (
              <Link href={exportHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
                Export journals
              </Link>
            ) : undefined
          }
        >
          Journals synced after <Time value={view.window.from} format="datetime" /> show up here. Export journals to pull the latest ones.
        </EmptyState>
      ) : !problem ? (
        <EmptyState title="Not checked yet">
          Check what the agent read in the {plural(view.window.investigations, "investigation", "investigations")} synced since this release.
          {check.cannotRun && !action ? <p className="mt-1">{check.cannotRun.message}</p> : null}
        </EmptyState>
      ) : null}
    </CheckCard>
  );
}
