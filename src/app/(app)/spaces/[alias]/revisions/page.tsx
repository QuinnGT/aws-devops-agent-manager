import { Check, CircleX } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { spaceBase } from "@/components/app-shell/nav";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { RoleNote } from "@/components/common/role-note";
import { StatusBadge } from "@/components/common/status-badge";
import { Time } from "@/components/common/time";
import { planStateBadge } from "@/components/plans/words";
import { NewRevisionButton } from "@/components/revisions/new-revision-button";
import { RevisionFilters } from "@/components/revisions/revision-filters";
import { baseCellText, matchesName, matchesState, parseRevisionListParams, REVISION_STATUS, revisionListQuery, revisionWord } from "@/components/revisions/words";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { decodeParam } from "@/server/assets/guard";
import { listLinkableFindings } from "@/server/audits/linkable";
import { permissionsIn, requireUserOrRedirect, roleFor } from "@/server/auth/dal";
import { roleNote } from "@/server/auth/role-words";
import { getAppPolicy } from "@/server/policy";
import type { PlanState } from "@/server/plans/types";
import { loadRevisionList, REVISION_PERMISSIONS, revisionBranch } from "@/server/revisions";
import { getSpaceByAlias } from "@/server/spaces/queries";

const DESCRIPTION = "A revision is a package you edit on its own branch of the history repository. Each change links to accepted findings, and a plan applies it to the live space.";

/** Revisions list (design-system pages/revisions.md). Reads only; creating a revision runs a worker job from the dialog. */
export default async function RevisionsPage({ params, searchParams }: PageProps<"/spaces/[alias]/revisions">) {
  const user = await requireUserOrRedirect();
  const { alias } = await params;
  const space = await getSpaceByAlias(decodeParam(alias));
  if (!space) notFound();
  const [perms, role] = await Promise.all([permissionsIn(user, space.id), roleFor(user, space.id)]);
  if (!perms.has(REVISION_PERMISSIONS.read)) notFound();

  const p = parseRevisionListParams(await searchParams);
  const base = spaceBase(space.alias);
  const [view, linkable] = await Promise.all([loadRevisionList(space, { limit: 500 }), listLinkableFindings(space.id, { limit: 1 })]);
  const canBuild = perms.has(REVISION_PERMISSIONS.build);
  const canSync = perms.has("sync.run");
  const canManage = perms.has("spaces.manage");

  const all = view.revisions;
  const rows = all.filter((r) => matchesState(r.state, p.state) && matchesName(r.name, p.q));
  const abandoned = all.filter((r) => r.state === "abandoned" && matchesName(r.name, p.q)).length;
  const policy = getAppPolicy().policy;
  const roleText = roleNote(policy, role, REVISION_PERMISSIONS.build, "create revisions");
  const newButton = canBuild ? <NewRevisionButton space={space} canSync={canSync} canManage={canManage} takenNames={all.filter((r) => r.state !== "failed").map((r) => r.name)} /> : null;
  const noFindings = linkable.length === 0;

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={[{ label: "Revisions" }]} />
      <PageHeader title="Revisions" description={DESCRIPTION} actions={newButton} />
      <RoleNote text={roleText} alias={space.alias} />

      {all.length === 0 ? (
        <Card className="gap-0 py-0">
          <EmptyState title="No revisions yet" action={canBuild ? <NewRevisionButton space={space} canSync={canSync} canManage={canManage} /> : undefined} className="px-6 py-6">
            Start one from the live space or a release to edit the instruction package on its own branch. Accepted audit findings become the evidence in its changelog.
            {noFindings ? (
              <p className="mt-2">
                No audit has accepted findings yet, so changes can&apos;t be linked.{" "}
                <Link href={`${base}/audits`} className="underline underline-offset-4">
                  Start with an audit
                </Link>
                .
              </p>
            ) : null}
          </EmptyState>
        </Card>
      ) : (
        <Card className="gap-0 py-0" role="region" aria-label="Revisions">
          <RevisionFilters value={p} />
          {rows.length === 0 ? (
            <EmptyState
              title="No revisions match these filters"
              action={
                <Link href={`${base}/revisions`} className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Clear filters
                </Link>
              }
            >
              Clear the filters to see the open revisions.
            </EmptyState>
          ) : (
            <Table>
              <TableHeader className="sticky top-0 bg-muted/50">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4 text-[13px] text-muted-foreground">Revision</TableHead>
                  <TableHead className="text-[13px] text-muted-foreground">Based on</TableHead>
                  <TableHead className="text-[13px] text-muted-foreground">State</TableHead>
                  <TableHead className="text-right text-[13px] text-muted-foreground">Linked findings</TableHead>
                  <TableHead className="text-[13px] text-muted-foreground">Last build</TableHead>
                  <TableHead className="text-[13px] text-muted-foreground">Plan and release</TableHead>
                  <TableHead className="pr-4 text-right text-[13px] text-muted-foreground">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const href = `${base}/revisions/${encodeURIComponent(r.name)}`;
                  const branch = revisionBranch(policy, space.alias, r.name);
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="py-2.5 pl-4 whitespace-normal">
                        <Link href={href} className="inline-flex min-h-6 items-center rounded-sm font-semibold underline-offset-4 hover:underline">
                          {r.name}
                        </Link>
                        <p className="font-mono text-xs break-all text-muted-foreground">{branch}</p>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {r.base.kind === "release" && r.base.releaseName ? (
                          <Link href={`${base}/releases/${encodeURIComponent(r.base.releaseName)}`} className="inline-flex min-h-6 items-center underline underline-offset-4">
                            {baseCellText(r.base)}
                          </Link>
                        ) : (
                          <>
                            Live space, <Time value={r.createdAt} format="date" />
                          </>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge {...REVISION_STATUS[revisionWord(r)]} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.linkedFindings}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {r.lastBuild && r.changes > 0 ? (
                          <>
                            {r.lastBuild.status === "passed" ? (
                              <span className="inline-flex items-center gap-1 text-success-fg">
                                <Check className="size-3.5" aria-hidden />
                                Passed
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-destructive-fg">
                                <CircleX className="size-3.5" aria-hidden />
                                {r.lastBuild.errors} {r.lastBuild.errors === 1 ? "error" : "errors"}
                              </span>
                            )}
                            <span className="block text-xs text-muted-foreground">
                              <Time value={r.lastBuild.ranAt} format="datetime" />
                            </span>
                          </>
                        ) : (
                          <span className="text-muted-foreground">Not built yet</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        {r.plan ? (
                          <>
                            <Link href={`${base}/plans/${encodeURIComponent(r.plan.planId)}`} className="inline-flex min-h-6 items-center underline underline-offset-4">
                              {r.plan.title || "Plan"}
                            </Link>
                            {r.release ? (
                              <span className="block text-xs">
                                {r.release.created ? (
                                  <Link href={`${base}/releases/${encodeURIComponent(r.release.name)}`} className="inline-flex min-h-6 items-center text-muted-foreground underline underline-offset-4">
                                    Release {r.release.name}
                                  </Link>
                                ) : (
                                  <span className="text-muted-foreground">{r.release.error ? `Release ${r.release.name} wasn't tagged` : `Tagging release ${r.release.name}`}</span>
                                )}
                              </span>
                            ) : (
                              <span className="mt-0.5 block">
                                <StatusBadge {...planStateBadge(r.plan.state as PlanState, r.plan.checkFailed, r.plan.validationFailed)} />
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">No plan yet</span>
                        )}
                      </TableCell>
                      <TableCell className="pr-4 text-right whitespace-nowrap">
                        <Time value={r.updatedAt} format="datetime" />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {p.state === "open" && abandoned > 0 ? (
            <div className="border-t px-4 py-2 text-center">
              <Link href={`${base}/revisions${revisionListQuery({ ...p, state: "abandoned" })}`} scroll={false} className={buttonVariants({ variant: "ghost", size: "sm" })}>
                Show {abandoned} abandoned {abandoned === 1 ? "revision" : "revisions"}
              </Link>
            </div>
          ) : null}
          {view.hasMore ? (
            <p className="border-t px-4 py-2 text-xs text-muted-foreground">Showing the {view.pageSize} most recently updated revisions.</p>
          ) : null}
        </Card>
      )}
    </div>
  );
}
