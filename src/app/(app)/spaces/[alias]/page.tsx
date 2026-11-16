import { ArrowRight, CircleX, Clock, Download, Layers, NotebookText, Plug, RefreshCw, Tag } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { SpaceTopBar, syncIntervalFor } from "@/components/app-shell/space-top-bar";
import { SyncNowButton } from "@/components/app-shell/sync-now-button";
import { Callout } from "@/components/common/callout";
import { ChangeFeed, feedTerms } from "@/components/common/change-feed";
import { ConnectionNextStep } from "@/components/common/connection-next-step";
import { DisabledReason } from "@/components/common/disabled-reason";
import { EmptyState } from "@/components/common/empty-state";
import { feedFilterQuery, feedSince, parseFeedFilters } from "@/components/common/feed-params";
import { LiveJobProgress } from "@/components/common/live-job-progress";
import { PageHeader } from "@/components/common/page-header";
import { RelativeTime } from "@/components/common/relative-time";
import { RoleNote } from "@/components/common/role-note";
import { SectionCard } from "@/components/common/section-card";
import { SOURCE_STYLE, SourceBadge } from "@/components/common/source-badge";
import { StatTile } from "@/components/common/stat-tile";
import { connectionStatusSpec } from "@/components/common/status-words";
import { Time } from "@/components/common/time";
import { dayKey, daysAgo } from "@/components/common/time-format";
import { getViewerZone } from "@/components/common/viewer-zone";
import type { FormState } from "@/components/spaces/form-state";
import { StartJobButton } from "@/components/spaces/start-job-button";
import { Button, buttonVariants } from "@/components/ui/button";
import { CHANGE_SOURCES } from "@/lib/assets/types";
import { cn } from "@/lib/utils";
import { can, requirePermission, requireUserOrRedirect, roleFor } from "@/server/auth/dal";
import { roleNote } from "@/server/auth/role-words";
import { countChangesBySource, countSettledUnknownSince, countUnknownByReason, listFeedItems } from "@/server/assets/feed";
import { decodeParam } from "@/server/assets/guard";
import { unknownReasonText } from "@/server/attribution/words";
import { openExistingHistoryRepo } from "@/server/assets/repo";
import { errorDetails, plainErrorText } from "@/server/jobs/error-text";
import { latestFailedRun, latestOpenRunId, loadJobStatus } from "@/server/jobs/status";
import { jobLabel, WORKER_WAIT_TEXT } from "@/server/jobs/words";
import { listExportJobs } from "@/server/journals/queries";
import { getAppPolicy } from "@/server/policy";
import { connectionBlocksRelease, loadLatestRelease, RELEASE_SENTENCE, type ReleaseSummary } from "@/server/releases";
import { errorState, okState } from "@/server/spaces/action-result";
import { actorOf } from "@/server/spaces/actor";
import { parseConnectionDetail } from "@/server/spaces/connection-detail";
import { connectionView } from "@/server/spaces/connection-state";
import { getSpaceOverview } from "@/server/spaces/overview";
import { getHistoryRepoForSpace, getSpaceByAlias, toHistoryRepoConfig } from "@/server/spaces/queries";
import { requestConnectionTest } from "@/server/spaces/service";
import { SYNC_SPACE_QUEUE } from "@/server/sync/contract";
import { lastGoodSyncAt } from "@/server/sync/last-good";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Rows or groups on Home before "Show older changes" (pages/space-home.md) */
const HOME_FEED_ENTRIES = 20;
/** Changes read for grouping; groups can hold many rows */
const HOME_FEED_READ = 200;

const outlineSm = buttonVariants({ variant: "outline", size: "sm" });
const ghostSm = buttonVariants({ variant: "ghost", size: "sm" });

export default async function SpaceHomePage({ params, searchParams }: PageProps<"/spaces/[alias]">) {
  const user = await requireUserOrRedirect();
  const { alias } = await params;
  const space = await getSpaceByAlias(decodeParam(alias));
  if (!space || !(await can(user, "assets.read", space.id))) notFound();

  const spaceId = space.id;
  const sp = await searchParams;
  const filters = parseFeedFilters(sp, { range: "30d" });
  const policy = getAppPolicy().policy;
  const retentionSince = daysAgo(policy.attribution.lookupEvents.retentionDays);

  const [overview, repoRow, perms, feed, bySource, unknownRecent, unknownWhy, exports, zone, role] = await Promise.all([
    getSpaceOverview(spaceId),
    getHistoryRepoForSpace(space),
    Promise.all(
      (["sync.run", "spaces.manage", "journals.export", "reasons.write", "history.read", "releases.create"] as const).map(async (p) => [p, await can(user, p, spaceId)] as const),
    ).then((e) => Object.fromEntries(e) as Record<"sync.run" | "spaces.manage" | "journals.export" | "reasons.write" | "history.read" | "releases.create", boolean>),
    listFeedItems(spaceId, { sources: filters.sources, types: filters.types, since: feedSince(filters.range), name: filters.q, limit: HOME_FEED_READ }),
    countChangesBySource(spaceId),
    countSettledUnknownSince(spaceId, retentionSince),
    countUnknownByReason(spaceId, retentionSince),
    listExportJobs(spaceId, 20),
    getViewerZone(),
    roleFor(user, spaceId),
  ]);

  // A requested sync that no worker has picked up, and the newest failure after the last connection check.
  const [syncJob, laterFailure] = await Promise.all([
    latestOpenRunId(spaceId, SYNC_SPACE_QUEUE).then((id) => loadJobStatus(id)),
    space.connectionStatus === "ok" ? latestFailedRun(spaceId, space.connectionCheckedAt) : Promise.resolve(null),
  ]);

  // Releases card: the newest release and its changes since (history.read, like the Releases page)
  const latestRelease: ReleaseSummary | null = perms["history.read"] ? await loadLatestRelease(space) : null;

  let unpushed: number | null = null;
  if (repoRow) {
    try {
      const repo = await openExistingHistoryRepo(toHistoryRepoConfig(repoRow));
      unpushed = repo ? await repo.unpushedCommitCount() : null;
    } catch {
      unpushed = null;
    }
  }

  const run = sp.run;
  const registrationRunId = typeof run === "string" && UUID_RE.test(run) ? run : null;
  const sync = overview.sync;
  const interval = syncIntervalFor(space);
  const base = `/spaces/${encodeURIComponent(space.alias)}`;
  const name = space.displayName ?? space.alias;
  const terms = feedTerms();
  const totalChanges = CHANGE_SOURCES.reduce((n, s) => n + bySource[s], 0);
  const lastExport = exports.find((e) => e.status === "succeeded");
  // Why changes are Unknown, said only for the reasons that apply (not "older than 90 days" next to today's changes).
  const unknownNotes = unknownReasonText(unknownWhy, {
    retentionDays: policy.attribution.lookupEvents.retentionDays,
    deliveryDelaySeconds: policy.attribution.eventDeliveryDelaySeconds,
  });

  async function testConnection(): Promise<FormState> {
    "use server";
    try {
      const u = await requirePermission("spaces.manage", spaceId);
      const runId = await requestConnectionTest(spaceId, actorOf(u), "manual");
      return okState("Connection test started.", { runId });
    } catch (err) {
      return errorState(err);
    }
  }

  // ---------- attention callouts, most severe first, at most three, one per cause ----------
  const conn = connectionView(space, sync);
  const syncError = sync?.status === "error" ? (plainErrorText(sync.error) ?? "It stopped without an error message.") : null;
  // The raw error behind each plain sentence, for the callout's Details (support text, never the main text).
  const syncDetails = sync?.status === "error" ? errorDetails(sync.error) : null;
  const testError = conn.failedBy === "test" && space.connectionStatus === "failed" ? parseConnectionDetail(space.connectionDetail).error : undefined;
  const connDetails = conn.failedBy === "sync" ? syncDetails : testError ? errorDetails(`${testError.name}: ${testError.message}`) : null;
  // A failed sync that shares the connection's cause is said once, in the connection callout.
  const syncSameCause = Boolean(conn.failedBy && syncError === conn.cause);
  const goodAt = lastGoodSyncAt(sync);
  const latestRecordedAll = goodAt && sync?.lastSyncCompletedAt && goodAt >= sync.lastSyncCompletedAt;
  const missing: ReactNode =
    !syncError || latestRecordedAll ? null : goodAt ? (
      <>
        History may be missing changes made after <Time value={goodAt} format="datetime" />, when a sync last succeeded.
      </>
    ) : sync?.baselineCompletedAt ? (
      "History may be missing changes made since the last sync that succeeded."
    ) : (
      "No sync of this space has succeeded yet, so History may be missing changes."
    );
  const callouts: { key: string; node: ReactNode }[] = [];
  if (conn.failedBy) {
    callouts.push({
      key: "connection",
      node: (
        <Callout
          tone="destructive"
          title="Can't reach this space"
          details={connDetails}
          action={perms["spaces.manage"] ? <StartJobButton action={testConnection} label="Test connection" pendingLabel="Starting…" doneText="Connection test finished." variant="outline" /> : undefined}
        >
          {conn.cause}
          {conn.needsSettings ? (
            <>
              {" "}
              <ConnectionNextStep alias={space.alias} canManage={perms["spaces.manage"]} />
            </>
          ) : null}
          {syncSameCause && missing ? <> {missing}</> : null}
        </Callout>
      ),
    });
  }
  if (syncError && !syncSameCause && syncJob?.status !== "running") {
    callouts.push({
      key: "sync-failed",
      node: (
        <Callout tone="destructive" title="Last sync failed" details={syncDetails} action={perms["sync.run"] && !syncJob ? <SyncNowButton alias={space.alias} /> : undefined}>
          {syncError}
          {missing ? <> {missing}</> : null}
        </Callout>
      ),
    });
  }
  if (syncJob?.waitingForWorker) {
    callouts.push({
      key: "sync-waiting",
      node: (
        <Callout tone="warning" title="The sync you requested hasn't started">
          {WORKER_WAIT_TEXT}
        </Callout>
      ),
    });
  }
  if (!sync?.lastSyncCompletedAt && sync?.status !== "running" && sync?.status !== "error" && !syncJob) {
    callouts.push({
      key: "never",
      node: (
        <Callout tone="info" title="Not synced yet" action={perms["sync.run"] ? <SyncNowButton alias={space.alias} /> : undefined}>
          Assets and history appear after the first sync.
        </Callout>
      ),
    });
  }
  // Only an Admin can change where the history is stored, so only an Admin sees this.
  if (perms["spaces.manage"] && repoRow && unpushed && unpushed > 0 && !repoRow.pushEnabled) {
    callouts.push({
      key: "unpushed",
      node: (
        <Callout
          tone="warning"
          title="History is only on this machine"
          action={
            <Link className={outlineSm} href="/settings">
              Repository settings
            </Link>
          }
        >
          {unpushed} saved {unpushed === 1 ? "change" : "changes"} in the history repository <span className="font-mono text-xs">{repoRow.name}</span>{" "}
          {repoRow.remoteUrl
            ? `${unpushed === 1 ? "hasn't" : "haven't"} been copied to its remote repository. Copying (git push) is off for this repository. Turn it on so the history is also kept off this machine.`
            : `${unpushed === 1 ? "exists" : "exist"} only here: the repository has no remote to copy ${unpushed === 1 ? "it" : "them"} to (git push). Add one so the history is also kept off this machine.`}
        </Callout>
      ),
    });
  }
  if (unknownRecent > 0) {
    callouts.push({
      key: "unknown",
      node: (
        <Callout
          tone="info"
          title={`${unknownRecent} recent ${unknownRecent === 1 ? "change has" : "changes have"} no known source`}
          action={
            perms["history.read"] ? (
              <Link className={ghostSm} href={`${base}/history?source=unknown&range=90d`}>
                Show these changes
              </Link>
            ) : undefined
          }
        >
          The CloudTrail lookup found no event for them. Check that the space&apos;s read role is allowed to look up CloudTrail events.
        </Callout>
      ),
    });
  }

  // ---------- stat tiles ----------
  const connected = conn.status === "ok";
  const checkedAt = space.connectionCheckedAt;
  const connSpec = connectionStatusSpec(conn.status);
  // Connected, but a sync or job failed after the check for a reason the connection doesn't explain (connectionView).
  const syncFailedLater = syncError && sync && (!checkedAt || !sync.lastSyncCompletedAt || sync.lastSyncCompletedAt > checkedAt);
  const later: { what: string; at: Date | null; error: string } | null = !connected
    ? null
    : syncFailedLater
      ? { what: "The last sync", at: sync.lastSyncCompletedAt, error: syncError }
      : laterFailure
        ? { what: jobLabel(laterFailure.queue), at: laterFailure.finishedAt, error: laterFailure.error }
        : null;
  const access = space.awsProfile
    ? `the AWS profile ${space.awsProfile}`
    : space.readRoleArn && space.writeRoleArn
      ? "its read and write roles"
      : space.readRoleArn
        ? "its read role"
        : "this app's own AWS credentials";
  const onDay = (d: Date) => (dayKey(d, zone.timeZone) === dayKey(new Date(), zone.timeZone) ? "at" : "on");
  const checkedText = (prefix: string) =>
    checkedAt ? (
      <>
        {prefix} {onDay(checkedAt)} <Time value={checkedAt} format="datetime" />
      </>
    ) : null;

  const policyOrder = Object.keys(policy.assetTypes.assetTypes);
  const rank = (t: string) => (policyOrder.indexOf(t) < 0 ? policyOrder.length : policyOrder.indexOf(t));
  const counts = [...overview.assetCounts].sort((a, b) => rank(a.assetType) - rank(b.assetType) || a.assetType.localeCompare(b.assetType));
  const liveTotal = counts.reduce((n, c) => n + c.count, 0);
  const breakdown = counts.map((c) => `${c.count} ${terms.noun(c.assetType, c.count)}`).join(", ");
  const typeOptions = [...new Set([...counts.map((c) => c.assetType), ...filters.types])].map((t) => ({ value: t, label: terms.typeLabel(t) }));

  const meta = [
    space.parsedSettings.environment ? `${space.parsedSettings.environment} space` : null,
    space.region,
    // Twelve digits, as in Space settings and in role ARNs.
    `account ${space.accountId}`,
    repoRow ? (
      <>
        history in <span className="font-mono text-xs">{repoRow.name}</span>
      </>
    ) : (
      "no history repository"
    ),
  ];

  // "Create release" (Releases card): hidden without releases.create, with the role note; disabled while the space can't be reached,
  // because a release starts with a sync (same rule and reason as the Releases page: connectionBlocksRelease).
  const releaseRoleText = roleNote(policy, role, "releases.create", "create releases");
  const releaseBlocked = connectionBlocksRelease(conn, { syncFirst: policy.releases.syncBeforeCreate, commit: null });
  const createRelease = !perms["history.read"] ? undefined : releaseRoleText ? (
    // In the narrow card, keep the icon beside the text instead of on a row of its own.
    <RoleNote text={releaseRoleText} alias={space.alias} className="grid grid-cols-[auto_minmax(0,1fr)] items-start [&>a]:col-start-2 [&>svg]:mt-0.5" />
  ) : releaseBlocked ? (
    <DisabledReason
      reason={
        <span>
          {releaseBlocked}
          {conn.needsSettings ? (
            <>
              {" "}
              <ConnectionNextStep alias={space.alias} canManage={perms["spaces.manage"]} />
            </>
          ) : null}
        </span>
      }
    >
      <Button variant="outline" size="sm">
        <Tag aria-hidden />
        Create release
      </Button>
    </DisabledReason>
  ) : (
    <Link className={outlineSm} href={`${base}/releases?create=1`}>
      <Tag aria-hidden />
      Create release
    </Link>
  );

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={[{ label: "Home" }]} />
      <PageHeader title={name} meta={meta} />

      {registrationRunId && perms["spaces.manage"] ? (
        <Callout tone="info" title="Testing the connection">
          <div className="mt-1 max-w-md">
            <LiveJobProgress runId={registrationRunId} />
          </div>
        </Callout>
      ) : null}

      {callouts.length ? (
        <section aria-label="Needs attention" className="space-y-2">
          {callouts.slice(0, 3).map((c) => (
            <div key={c.key}>{c.node}</div>
          ))}
        </section>
      ) : null}

      <section aria-label="Space status" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          icon={<Plug />}
          label="Connection"
          value={
            <>
              {connSpec.icon ? <connSpec.icon className={connected ? "text-success-fg" : conn.failedBy ? "text-destructive-fg" : "text-muted-foreground"} aria-hidden /> : null}
              {connSpec.label}
            </>
          }
          detail={
            // While the space can't be reached, the tile shows only when; the callout above has the cause and the next step.
            conn.failedBy ? (
              conn.at ? (
                <>
                  Failed {onDay(conn.at)} <Time value={conn.at} format="datetime" />
                </>
              ) : null
            ) : later ? (
              <>
                {checkedText("Connected when checked")}
                {checkedAt ? ". " : null}
                {later.what} failed
                {later.at ? (
                  <>
                    {" "}
                    {onDay(later.at)} <Time value={later.at} format="datetime" />
                  </>
                ) : null}
                {/* A failed sync's error is in the "Last sync failed" callout. */}
                {syncFailedLater ? "." : `: ${later.error}`}
              </>
            ) : checkedAt ? (
              <>
                {checkedText(connected ? "Connected when checked" : "Last checked")}, using {access}.
              </>
            ) : (
              `Not checked yet. Uses ${access}.`
            )
          }
          action={
            // When the space isn't connected, the callout above has the cause, the next step and Test connection.
            later && perms["spaces.manage"] ? <StartJobButton action={testConnection} label="Test connection" pendingLabel="Starting…" doneText="Connection test finished." variant="outline" size="sm" /> : undefined
          }
        />
        <StatTile
          icon={<RefreshCw />}
          label="Last sync"
          value={
            sync?.status === "error" ? (
              <>
                <CircleX className="text-destructive-fg" aria-hidden />
                Failed
              </>
            ) : syncJob?.waitingForWorker ? (
              <>
                <Clock className="text-warning-fg" aria-hidden />
                Not started
              </>
            ) : sync?.lastSyncCompletedAt ? (
              <RelativeTime value={sync.lastSyncCompletedAt} />
            ) : (
              "Never"
            )
          }
          detail={
            <>
              {sync?.status === "error" && sync.lastSyncCompletedAt ? (
                <>
                  Failed <RelativeTime value={sync.lastSyncCompletedAt} /> ·{" "}
                </>
              ) : syncJob?.waitingForWorker && sync?.lastSyncCompletedAt ? (
                <>
                  Last finished <RelativeTime value={sync.lastSyncCompletedAt} /> ·{" "}
                </>
              ) : null}
              Every {interval} min · {totalChanges} {totalChanges === 1 ? "change" : "changes"} recorded
            </>
          }
        />
        <StatTile icon={<Layers />} label="Live assets" value={liveTotal} detail={liveTotal ? breakdown : "No assets indexed yet"} />
        <StatTile
          icon={<NotebookText />}
          label="Journals"
          value={overview.investigationCount}
          detail={
            overview.investigationCount === 0 ? (
              perms["journals.export"] ? (
                "No investigations copied from the space yet. Export journals copies them here and builds a zip to download."
              ) : (
                "No investigations copied from the space yet. They're copied here when someone exports journals."
              )
            ) : lastExport ? (
              <>
                Last export <Time value={lastExport.createdAt} format="datetime" />
              </>
            ) : (
              "No exports yet"
            )
          }
          action={
            perms["journals.export"] ? (
              <Link className={outlineSm} href={`${base}/journals/exports`}>
                <Download aria-hidden />
                Export journals
              </Link>
            ) : undefined
          }
        />
      </section>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <SectionCard
          id="recent-changes"
          title="Recent changes"
          aside={
            perms["history.read"] ? (
              <Link className={ghostSm} href={`${base}/history`}>
                Open history
                <ArrowRight aria-hidden />
              </Link>
            ) : undefined
          }
        >
          <ChangeFeed
            alias={space.alias}
            items={feed.items}
            hasMore={feed.hasMore}
            limit={HOME_FEED_ENTRIES}
            showFilters
            filters={filters}
            typeOptions={typeOptions}
            canWriteReasons={perms["reasons.write"]}
            olderHref={perms["history.read"] ? `${base}/history?${feedFilterQuery(filters)}` : undefined}
          />
        </SectionCard>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
          <SectionCard id="who-changed" title="Who made changes" aside={<span className="text-xs text-muted-foreground tabular-nums">All {totalChanges} recorded</span>}>
            <ul className="py-1.5">
              {CHANGE_SOURCES.map((s) => {
                const n = bySource[s];
                const pct = totalChanges ? Math.round((n / totalChanges) * 100) : 0;
                return (
                  <li key={s} className="grid grid-cols-[112px_minmax(0,1fr)_64px] items-center gap-2.5 px-4 py-1.5 text-[13px]">
                    <SourceBadge source={s} />
                    <span className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
                      <span className={cn("block h-full rounded-full", SOURCE_STYLE[s].bar)} style={{ width: `${pct}%` }} />
                    </span>
                    <span className="text-right text-xs text-muted-foreground tabular-nums">
                      <span className="font-semibold text-foreground">{n}</span>
                      {n > 0 ? ` · ${pct}%` : null}
                    </span>
                  </li>
                );
              })}
            </ul>
            {unknownNotes.length ? (
              <div className="space-y-1 border-t px-4 py-2.5 text-xs text-muted-foreground">
                {unknownNotes.map((t) => (
                  <p key={t}>{t}</p>
                ))}
              </div>
            ) : null}
          </SectionCard>

          <SectionCard id="releases" title="Releases">
            {latestRelease ? (
              <div className="space-y-2 px-4 py-3.5 text-[13px]">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <Link href={`${base}/releases/${encodeURIComponent(latestRelease.name)}`} className="inline-flex min-h-6 items-center font-semibold underline-offset-4 hover:underline">
                    {latestRelease.name}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    <Time value={latestRelease.createdAt} format="datetime" />
                  </span>
                </div>
                <p className="text-muted-foreground tabular-nums">
                  {latestRelease.changesSince ?? 0} {(latestRelease.changesSince ?? 0) === 1 ? "change" : "changes"} since this release
                </p>
                <p className="text-xs text-muted-foreground">{RELEASE_SENTENCE}</p>
                <Link className={outlineSm} href={`${base}/releases/${encodeURIComponent(latestRelease.name)}`}>
                  Compare with live
                </Link>
              </div>
            ) : (
              <EmptyState title="No releases yet" action={createRelease}>
                {RELEASE_SENTENCE}
              </EmptyState>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
