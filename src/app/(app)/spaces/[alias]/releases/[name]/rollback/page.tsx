import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment, type ReactNode } from "react";
import { SpaceTopBar, syncIntervalFor } from "@/components/app-shell/space-top-bar";
import { SyncNowButton } from "@/components/app-shell/sync-now-button";
import { Callout } from "@/components/common/callout";
import { RelativeTime } from "@/components/common/relative-time";
import { RoleNote } from "@/components/common/role-note";
import { SectionCard } from "@/components/common/section-card";
import { shortSourceLabel } from "@/components/common/source-labels";
import { PageHeader } from "@/components/common/page-header";
import { syncState } from "@/components/common/sync-status-state";
import { Time } from "@/components/common/time";
import { ValidationList } from "@/components/common/validation-list";
import { VersionBadge } from "@/components/common/version-badge";
import { VersionStatus } from "@/components/releases/release-cells";
import { RollbackPlanForm } from "@/components/releases/rollback-plan-form";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, requireUserOrRedirect, roleFor } from "@/server/auth/dal";
import { roleNote } from "@/server/auth/role-words";
import { permissionsForRole } from "@/server/auth/roles";
import { decodeParam, firstParam } from "@/server/assets/guard";
import { getSyncState } from "@/server/assets/queries";
import { lastGoodSyncAt } from "@/server/sync/last-good";
import { getAppPolicy } from "@/server/policy";
import { loadRollbackPage, RELEASE_PERMISSIONS, type RollbackGroupKey, type RollbackViewRow } from "@/server/releases";
import { actorOf } from "@/server/spaces/actor";
import { getSpaceByAlias } from "@/server/spaces/queries";
import { createRollbackPlanAction } from "../../actions";

const GROUP_TITLES: Record<RollbackGroupKey | "matching", string> = {
  "restore-content": "Restore content",
  "restore-status": "Restore status",
  "restore-metadata": "Restore metadata",
  recreate: "Recreate",
  deactivate: "Set Inactive",
  "remove-keys": "Remove metadata keys",
  delete: "Delete",
  "left-out": "Left out",
  matching: "Already matches",
};

const plural = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;

/** "The Publisher role": the lowest-ranked role that may apply a restore plan. */
function applyRoleText(policy: ReturnType<typeof getAppPolicy>["policy"]): string {
  const roles = Object.entries(policy.roles.roles).sort(([, a], [, b]) => a.rank - b.rank);
  const found = roles.find(([name]) => permissionsForRole(policy, name).has(RELEASE_PERMISSIONS.applyRollback));
  if (!found) return `The ${RELEASE_PERMISSIONS.applyRollback} permission`;
  return `The ${found[0].charAt(0).toUpperCase()}${found[0].slice(1)} role`;
}

function LiveCell({ row }: { row: RollbackViewRow }): ReactNode {
  if (!row.live) return <VersionBadge version="deleted" />;
  if (row.group === "remove-keys") return <span className="font-mono text-xs">{row.removeMetadataKeys.join(", ")} set</span>;
  const showStatus = row.group === "restore-status" || row.group === "deactivate";
  return <VersionStatus version={row.live.version} status={showStatus ? row.live.status : null} />;
}

function AfterCell({ row }: { row: RollbackViewRow }): ReactNode {
  const a = row.after;
  switch (a.kind) {
    case "content":
      return (
        <span>
          v{a.releaseVersion} content{a.writtenAs !== null ? <>, written as <VersionBadge version={a.writtenAs} /></> : null}
        </span>
      );
    case "status":
      return <VersionStatus version={a.version} status={a.status} />;
    case "metadata":
      return (
        <span>
          {a.version !== null ? <VersionBadge version={a.version} /> : null} with the release&apos;s metadata
        </span>
      );
    case "recreate":
      return (
        <span>
          {a.releaseVersion !== null ? `v${a.releaseVersion} ` : ""}content and metadata, <VersionBadge version="new" />
        </span>
      );
    case "keys-removed":
      return <span className="font-mono text-xs">{a.keys.join(", ")} removed</span>;
    case "deleted":
      return <VersionBadge version="deleted" />;
    case "unchanged":
      return <span>{a.version !== null ? <><VersionBadge version={a.version} />, unchanged</> : "Unchanged"}</span>;
  }
}

function WhyCell({ row, release }: { row: RollbackViewRow; release: string }): ReactNode {
  const parts: ReactNode[] = [];
  const attribution = getAppPolicy().policy.attribution;
  if (row.group === "restore-content" && row.lastChange) {
    parts.push(
      <>
        {shortSourceLabel(row.lastChange.source, attribution)} changed it <Time value={row.lastChange.at} format="datetime" />.
      </>,
    );
  }
  if (row.group === "restore-status") parts.push("Status only, so no new version.");
  if (row.group === "restore-metadata") parts.push("Metadata only, so no new version.");
  if (row.group === "recreate") {
    parts.push("Gets a new asset ID.");
    parts.push(row.referencedBy.length ? `Custom agents ${row.referencedBy.join(", ")} reference it; their IDs are remapped.` : "No custom agent references it.");
  }
  if (row.group === "deactivate" && !row.note) parts.push(`Added after ${release}: set Inactive instead of deleting.`);
  if (row.note && row.group !== "recreate") parts.push(row.note);
  return (
    <span>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 ? " " : null}
          {p}
        </Fragment>
      ))}
    </span>
  );
}

export default async function RollbackPreviewPage({ params, searchParams }: PageProps<"/spaces/[alias]/releases/[name]/rollback">) {
  const user = await requireUserOrRedirect();
  const { alias, name: rawName } = await params;
  const space = await getSpaceByAlias(decodeParam(alias));
  if (!space || !(await can(user, RELEASE_PERMISSIONS.read, space.id))) notFound();
  const name = decodeParam(rawName);
  if (name.length > 200) notFound();

  const [view, canPlan, canSync, sync, role] = await Promise.all([
    loadRollbackPage(space, name, actorOf(user)),
    can(user, RELEASE_PERMISSIONS.planRollback, space.id),
    can(user, "sync.run", space.id),
    getSyncState(space.id),
    roleFor(user, space.id),
  ]);
  if (!view) notFound();

  const sp = await searchParams;
  const showAll = firstParam(sp.show) === "all";
  const policy = getAppPolicy().policy;
  const { release, preview, groups } = view;
  const base = `/spaces/${encodeURIComponent(space.alias)}/releases`;
  const releaseHref = `${base}/${encodeURIComponent(release.name)}`;
  const lastSync = sync?.lastSyncCompletedAt ?? null;
  const state = syncState({ lastCompletedAt: lastSync, status: sync?.status ?? null, intervalMinutes: syncIntervalFor(space) });
  // The comparison uses what the last successful sync recorded; a failed run recorded nothing new.
  const lastGood = lastGoodSyncAt(sync);

  const callouts: { key: string; node: ReactNode }[] = [];
  if (!preview.ok) {
    callouts.push({
      key: "failed",
      node: (
        <Callout tone="destructive" title="The restore can't be previewed">
          {preview.message}
        </Callout>
      ),
    });
  } else {
    const errors = preview.preview.problems.filter((p) => p.level === "error");
    if (errors.length) {
      callouts.push({
        key: "errors",
        node: (
          <Callout tone="destructive" title={`${plural(errors.length, "problem blocks", "problems block")} the restore plan`}>
            <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
              {errors.slice(0, 5).map((p, i) => (
                <li key={i}>{p.message}</li>
              ))}
            </ul>
          </Callout>
        ),
      });
    }
    if (groups?.cantRestore.length) {
      const n = groups.cantRestore.length;
      callouts.push({
        key: "cant-restore",
        node: (
          <Callout tone="warning" title={`${plural(n, "asset", "assets")} can't be restored yet`}>
            {groups.cantRestore.slice(0, 5).map((r) => (
              <p key={r.rowKey}>
                {r.name}: {r.note ?? "left as it is."}
                {r.live?.version != null ? ` The plan leaves it at v${r.live.version}.` : ""}
              </p>
            ))}
          </Callout>
        ),
      });
    }
  }
  if (state === "stale" || state === "failed" || state === "never") {
    callouts.push({
      key: "sync",
      node: (
        <Callout tone="warning" title="This preview may be out of date" action={canSync ? <SyncNowButton alias={space.alias} /> : undefined}>
          {lastGood ? (
            <>
              Last successful sync <Time value={lastGood} format="datetime" />.{" "}
            </>
          ) : (
            "No sync of this space has succeeded yet. "
          )}
          The plan re-checks the live space, but sync first to preview it accurately.
        </Callout>
      ),
    });
  }

  const p = preview.ok ? preview.preview : null;
  const changes = groups?.changes ?? 0;
  const disabledReason = !p ? "The preview failed, so there is nothing to plan." : p.blocked ? "Fix the problems listed above first." : changes === 0 ? `Nothing to restore: the live space matches ${release.name}.` : null;
  const shownGroups = groups ? [...groups.groups, ...(showAll && groups.matching.length ? [{ key: "matching" as const, rows: groups.matching }] : [])] : [];
  const shownRows = shownGroups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={[{ label: "Releases", href: base }, { label: release.name, href: releaseHref }, { label: "Restore" }]} />
      <PageHeader
        title={`Restore release ${release.name}`}
        meta={[
          <>
            Compared with the live space as of the last successful sync{lastGood ? <>, <RelativeTime value={lastGood.toISOString()} /></> : null}. Nothing is written until the plan is applied.
          </>,
        ]}
      />

      {callouts.length ? (
        <section aria-label="Needs attention" className="space-y-2">
          {callouts.slice(0, 3).map((c) => (
            <div key={c.key}>{c.node}</div>
          ))}
        </section>
      ) : null}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <SectionCard
          id="plan-will-do"
          title="What the plan will do"
          aside={groups ? <span className="text-xs text-muted-foreground tabular-nums">{`${shownRows} of ${plural(groups.total, "asset", "assets")}`}</span> : undefined}
        >
          {shownGroups.length === 0 ? (
            <p className="px-4 py-3.5 text-[13px] text-muted-foreground">{p ? `Every asset already matches ${release.name}.` : "No preview."}</p>
          ) : (
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="pl-4">Asset</TableHead>
                  <TableHead>Live now</TableHead>
                  <TableHead>After apply</TableHead>
                  <TableHead className="pr-4">Why</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shownGroups.map((g) => (
                  <Fragment key={g.key}>
                    <TableRow className="bg-muted hover:bg-muted">
                      <TableCell colSpan={4} className="py-1.5 pl-4 text-xs font-semibold" scope="colgroup">
                        {GROUP_TITLES[g.key]} ({g.rows.length})
                      </TableCell>
                    </TableRow>
                    {g.rows.map((r) => (
                      <TableRow key={r.rowKey} className="align-top">
                        <TableCell className="max-w-[220px] min-w-[170px] py-2 pl-4 whitespace-normal">
                          <div className="font-semibold break-words">{r.name}</div>
                          <div className="text-xs text-muted-foreground">{r.parentName ? `${r.typeLabel} in ${r.parentName}` : r.typeLabel}</div>
                        </TableCell>
                        <TableCell className="py-2 whitespace-normal">
                          <LiveCell row={r} />
                        </TableCell>
                        <TableCell className="min-w-[120px] py-2 whitespace-normal">
                          <AfterCell row={r} />
                        </TableCell>
                        <TableCell className="max-w-[300px] min-w-[200px] py-2 pr-4 whitespace-normal">
                          <WhyCell row={r} release={release.name} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          )}
          {groups && groups.matching.length && !showAll ? (
            <div className="border-t px-4 py-2 text-center">
              <Link href={`${releaseHref}/rollback?show=all`} scroll={false} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Show {plural(groups.matching.length, "asset that already matches", "assets that already match")}
              </Link>
            </div>
          ) : null}
          {p && p.validation.length ? (
            <div className="border-t px-4 py-3">
              <h3 className="mb-1 text-xs font-semibold">Checks on the planned assets</h3>
              <ValidationList results={p.validation} />
            </div>
          ) : null}
        </SectionCard>

        <SectionCard id="create-plan" title="Create the restore plan">
          <div className="grid gap-3 px-4 py-3.5 text-[13px]">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5">
              <dt className="text-muted-foreground">Changes</dt>
              <dd className="tabular-nums">{plural(changes, "asset", "assets")}</dd>
              <dt className="text-muted-foreground">Approval</dt>
              <dd>{space.parsedSettings.approvalRequired ? "A second person must approve" : "Not required for this space"}</dd>
              <dt className="text-muted-foreground">Apply needs</dt>
              <dd>{applyRoleText(policy)}</dd>
            </dl>
            {/* Where the form would be, a Viewer reads why there is no button. */}
            {!canPlan ? (
              <RoleNote
                className="grid grid-cols-[auto_minmax(0,1fr)] items-start [&>a]:col-start-2 [&>svg]:mt-0.5"
                text={roleNote(policy, role, RELEASE_PERMISSIONS.planRollback, "create restore plans")}
                alias={space.alias}
              />
            ) : null}
            {canPlan && p ? (
              <RollbackPlanForm
                action={createRollbackPlanAction.bind(null, space.alias, release.name)}
                defaultTitle={p.title}
                titleMaxChars={policy.plans.limits.titleMaxChars}
                disabledReason={disabledReason}
              />
            ) : null}
            <p className="text-xs text-muted-foreground">The plan re-reads the live space. You review each diff and apply it on the plan page, like any plan.</p>
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
