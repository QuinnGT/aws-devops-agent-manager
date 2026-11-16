import { CircleCheck, CircleX } from "lucide-react";
import Link from "next/link";
import { Callout } from "@/components/common/callout";
import { ConnectionNextStep } from "@/components/common/connection-next-step";
import { EmptyState } from "@/components/common/empty-state";
import { Time } from "@/components/common/time";
import { cn } from "@/lib/utils";
import { liveErrorNeedsSettings } from "@/server/assets/live";
import type { ReleaseVerificationView } from "@/server/verify/loaders";
import type { RunCheckState } from "./action-state";
import { CheckCard } from "./check-card";
import { atApplyText, differences, liveCounts } from "./views";
import { endedWithoutResult } from "./words";

const TONE = { default: "", warning: "text-warning-fg", destructive: "text-destructive-fg" } as const;

/** Why the newest run ended without a result, when it is newer than the last result. */
export function lastRunProblem(check: ReleaseVerificationView["live"] | ReleaseVerificationView["reads"]): { title: string; message: string | null; reason: string | null } | null {
  const latest = check.latest;
  if (!latest || latest.state === "succeeded" || latest.state === "queued" || latest.state === "running") return null;
  if (check.lastResult && check.lastResult.run.createdAt > latest.createdAt) return null;
  const title = endedWithoutResult(latest.state);
  return title ? { title, message: latest.message, reason: latest.blockedReason } : null;
}

export function ProblemCallout({ problem, alias, canManage }: { problem: NonNullable<ReturnType<typeof lastRunProblem>>; alias: string; canManage: boolean }) {
  const needsSettings = problem.reason === "space-unreachable" || (problem.message ? liveErrorNeedsSettings(problem.message) : false);
  return (
    <div className="border-b px-4 py-3">
      <Callout tone="destructive" title={problem.title}>
        {problem.message ? (/[.!?]$/.test(problem.message.trim()) ? problem.message.trim() : `${problem.message.trim()}.`) : "The check stopped without a message. Run it again."}
        {needsSettings ? (
          <>
            {" "}
            <ConnectionNextStep alias={alias} canManage={canManage} />
          </>
        ) : null}
      </Callout>
    </div>
  );
}

export function LiveStateCard({
  alias,
  releaseName,
  view,
  action,
  canManage,
}: {
  alias: string;
  releaseName: string;
  view: ReleaseVerificationView;
  action: ((prev: RunCheckState) => Promise<RunCheckState>) | null;
  canManage: boolean;
}) {
  const check = view.live;
  const last = check.lastResult;
  const problem = lastRunProblem(check);
  const releaseHref = `/spaces/${encodeURIComponent(alias)}/releases/${encodeURIComponent(releaseName)}`;
  const syncAt = last?.result.sync ? (last.result.sync.at ?? last.run.startedAt) : null;
  const meta = last ? (
    <>
      Last checked <Time value={last.run.finishedAt ?? last.run.createdAt} format="datetime" />
      {syncAt ? (
        <>
          , after the <Time value={syncAt} format="time" /> sync
        </>
      ) : null}
    </>
  ) : null;
  const applied = view.applied && view.applied.total > 0 ? view.applied : null;
  const apply = applied ? atApplyText(applied) : null;
  const planHref = applied ? `/spaces/${encodeURIComponent(alias)}/plans/${encodeURIComponent(applied.planId)}` : null;

  return (
    <CheckCard
      titleId="verify-live-title"
      title="Live state"
      meta={meta}
      staleNote={view.stale?.live ? "The space synced again since the last check" : null}
      action={action}
      openRunId={check.open?.jobRunId ?? null}
      open={Boolean(check.open)}
      disabledReason={check.cannotRun?.message ?? null}
      startedText="Live state check requested"
    >
      {problem ? <ProblemCallout problem={problem} alias={alias} canManage={canManage} /> : null}
      {apply && applied ? (
        <div className="grid grid-cols-[16px_minmax(0,1fr)] gap-2 border-b px-4 py-2.5 text-[13px]">
          {apply.ok ? <CircleCheck className="mt-0.5 size-4 text-success-fg" aria-hidden /> : <CircleX className="mt-0.5 size-4 text-destructive-fg" aria-hidden />}
          <p>
            <span className="font-semibold">{apply.lead}</span>{" "}
            {apply.ok ? (
              applied.at ? (
                <>
                  The apply job read every asset back on <Time value={applied.at} format="datetime" />.
                </>
              ) : (
                "The apply job read every asset back."
              )
            ) : (
              <>
                {applied.mismatched.length ? `${applied.mismatched.slice(0, 3).join(", ")}${applied.mismatched.length > 3 ? ` and ${applied.mismatched.length - 3} more` : ""}. ` : null}
                See plan{" "}
                <Link href={planHref!} className="underline underline-offset-4">
                  {applied.title}
                </Link>
                .
              </>
            )}
          </p>
        </div>
      ) : null}
      {last ? (
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 px-4 py-3">
          {liveCounts(last.result.counts).map((c) => (
            <span key={c.key} className="text-[13px]">
              <b className={cn("mr-1.5 text-lg font-semibold tabular-nums", TONE[c.tone])}>{c.n}</b>
              {c.words}
            </span>
          ))}
          {differences(last.result.counts) > 0 ? (
            <Link href={releaseHref} className="ml-auto inline-flex min-h-6 items-center text-[13px] underline underline-offset-4">
              See the {differences(last.result.counts)} {differences(last.result.counts) === 1 ? "difference" : "differences"}
            </Link>
          ) : (
            <span className="ml-auto text-[13px] text-muted-foreground">The live space matches this release.</span>
          )}
        </div>
      ) : !problem ? (
        <EmptyState title="Not checked yet">
          Check that the live space still matches this release.
          {check.cannotRun && !action ? <p className="mt-1">{check.cannotRun.message}</p> : null}
        </EmptyState>
      ) : null}
    </CheckCard>
  );
}
