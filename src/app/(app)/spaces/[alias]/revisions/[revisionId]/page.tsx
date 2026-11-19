import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { spaceBase } from "@/components/app-shell/nav";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { Callout, type CalloutTone } from "@/components/common/callout";
import { RoleNote } from "@/components/common/role-note";
import { StatusBadge } from "@/components/common/status-badge";
import { Time } from "@/components/common/time";
import { getViewerZone } from "@/components/common/viewer-zone";
import { planStateBadge } from "@/components/plans/words";
import { RevisionWorkspace, type FileView } from "@/components/revisions/revision-workspace";
import { decodeParam, firstParam } from "@/server/assets/guard";
import { permissionsIn, requireUserOrRedirect, roleFor } from "@/server/auth/dal";
import { roleNote } from "@/server/auth/role-words";
import { policyForSpace } from "@/server/journals/policy";
import type { PlanState } from "@/server/plans/types";
import { REVISION_PERMISSIONS } from "@/server/revisions";
import { loadRevisionPage, loadSaveFindings, readRevisionFile, type RevisionPage } from "@/server/revisions/views";
import { getSpaceByAlias } from "@/server/spaces/queries";
import { abandonRevisionAction, createRevisionPlanAction, removeToAddressFindingAction, saveRevisionAction } from "../actions";

const OPEN_PLAN = ["checking", "ready", "waiting", "approved", "applying"];
const TONE_RANK: Record<CalloutTone, number> = { destructive: 0, warning: 1, info: 2, success: 3 };
const link = "underline underline-offset-4";

/** The file the editor opens first: one with a build error, else one the revision edited, else the first instructions file. */
function defaultFile(page: RevisionPage): string | null {
  const paths = page.detail.tree.map((t) => t.path);
  const m = page.marks;
  return paths.find((p) => m[p]?.errors) ?? paths.find((p) => m[p]?.edited && !m[p]?.generated) ?? paths.find((p) => m[p]?.instructions) ?? paths[0] ?? null;
}

/** Revision detail, option 1: the editor (design-system pages/revision-detail.md), with option 2's change list as the Saves tab. */
export default async function RevisionDetailPage({ params, searchParams }: PageProps<"/spaces/[alias]/revisions/[revisionId]">) {
  const user = await requireUserOrRedirect();
  const { alias, revisionId } = await params;
  const space = await getSpaceByAlias(decodeParam(alias));
  if (!space) notFound();
  const [perms, role] = await Promise.all([permissionsIn(user, space.id), roleFor(user, space.id)]);
  if (!perms.has(REVISION_PERMISSIONS.read)) notFound();

  const sp = await searchParams;
  const fileParam = firstParam(sp.file) ?? null;
  const tabParam = firstParam(sp.tab);
  const initialTab = tabParam === "diff" || tabParam === "changelog" || tabParam === "saves" ? tabParam : "edit";
  const idOrName = decodeParam(revisionId);
  const page = await loadRevisionPage(space, idOrName, { permissions: perms, role }, { path: fileParam });
  if (!page) notFound();
  const { detail } = page;
  const r = detail.revision;
  const base = spaceBase(space.alias);
  const revisionsHref = `${base}/revisions`;

  // The first file: the one in the URL when the package has it, else the default.
  let initial: { path: string; view: FileView } | null = detail.file?.view ? { path: detail.file.path, view: detail.file.view as FileView } : null;
  if (!initial) {
    const path = defaultFile(page);
    const read = path ? await readRevisionFile(space, r.id, path) : null;
    initial = read ? { path: read.path, view: read.view as FileView } : null;
  }

  const canSave = perms.has(REVISION_PERMISSIONS.build);
  const canPlan = canSave && perms.has(REVISION_PERMISSIONS.plan);
  const canExport = perms.has(REVISION_PERMISSIONS.export);
  const [zone, { policy }, saveFindings] = await Promise.all([getViewerZone(), policyForSpace(space), canSave ? loadSaveFindings(space, detail.changes.flatMap((c) => c.findingIds), { toAddress: r.toAddressIds }) : Promise.resolve([])]);
  const buildSave = detail.build ? page.saves.find((s) => s.commit === detail.build!.commit)?.number ?? null : null;
  const plan = detail.plan;
  const planOpen = plan ? OPEN_PLAN.includes(plan.state) : false;
  const planHref = plan ? `${base}/plans/${encodeURIComponent(plan.planId)}` : null;
  const takesFindings = r.state === "open" || r.state === "creating";

  // At most three callouts, most severe first (MASTER "Attention callouts").
  const ranked: { rank: number; node: ReactNode }[] = [];
  const add = (tone: CalloutTone, node: ReactNode) => ranked.push({ rank: TONE_RANK[tone], node });
  if (!detail.repo.ok) {
    add(
      "destructive",
      <Callout key="repo" tone="destructive" title="The history repository can't be read">
        {detail.repo.message}
      </Callout>,
    );
  } else if (page.branchMissing) {
    add(
      "destructive",
      <Callout key="branch" tone="destructive" title={`The branch ${r.branch} isn't in the history repository.`}>
        {perms.has("spaces.manage") ? (
          <>
            Check the repository in{" "}
            <Link href={`${base}/settings`} className={link}>
              Space settings
            </Link>
            . The files below are from the last commit the app recorded.
          </>
        ) : (
          "Ask an Admin to check the history repository in Space settings."
        )}
      </Callout>,
    );
  }
  if (r.state === "creating") {
    add(
      "info",
      <Callout key="creating" tone="info" title="The revision is being created">
        The base is being written as a package on the branch. The page refreshes when it is ready.
      </Callout>,
    );
  } else if (r.state === "failed") {
    add(
      "destructive",
      <Callout key="failed" tone="destructive" title="The revision wasn't created">
        {r.stateReason ?? "The create job stopped without an error message."} Start a new revision with the same name to try again.
      </Callout>,
    );
  } else if (r.state === "abandoned") {
    add(
      "info",
      <Callout key="abandoned" tone="info" title={<>Abandoned{r.abandonedAt ? <> <Time value={r.abandonedAt} format="datetime" /></> : null}{r.abandonedBy ? ` by ${r.abandonedBy}` : ""}</>}>
        {r.stateReason ? `${r.stateReason}. ` : ""}The revision is read only. Its branch stays in the history repository.
      </Callout>,
    );
  } else if (r.state === "applied" || plan?.state === "applied") {
    add(
      "success",
      <Callout
        key="applied"
        tone="success"
        title={
          <>
            Applied <Time value={r.updatedAt} format="datetime" /> by plan{" "}
            {planHref ? (
              <Link href={planHref} className={link}>
                {plan?.title}
              </Link>
            ) : null}
            .
          </>
        }
      >
        {detail.release?.created ? (
          <>
            Release{" "}
            <Link href={`${base}/releases/${encodeURIComponent(detail.release.name)}`} className={link}>
              {detail.release.name}
            </Link>{" "}
            was tagged. The revision is read only; start a new one from that release for further changes.
          </>
        ) : detail.release?.error ? (
          `Release ${detail.release.name} wasn't tagged: ${detail.release.error}`
        ) : detail.release ? (
          `Release ${detail.release.name} is being tagged.`
        ) : (
          "The revision is read only."
        )}
      </Callout>,
    );
  } else if (plan && planOpen && planHref) {
    add(
      "info",
      <Callout
        key="planned"
        tone="info"
        title={
          <>
            Plan{" "}
            <Link href={planHref} className={link}>
              {plan.title}
            </Link>{" "}
            is open
          </>
        }
      >
        <span className="inline-flex flex-wrap items-center gap-2">
          <StatusBadge {...planStateBadge(plan.state as PlanState, plan.checkFailed, plan.validationFailed)} />
          <span>Editing is still allowed; apply or discard the plan before creating another.</span>
        </span>
      </Callout>,
    );
    if (plan.outOfDate) {
      add(
        "warning",
        <Callout key="outdated" tone="warning" title={`The latest save is not in plan ${plan.title}`}>
          Discard the plan and create a new one to include it.
        </Callout>,
      );
    }
  }

  // What a plan from this revision leaves as it is live, and what changed on both sides (open revisions with saves).
  const scope = page.scope;
  if (scope && (scope.conflicts.length || scope.leftAlone.length)) {
    const tone = scope.conflicts.length ? "warning" : "info";
    add(
      tone,
      <Callout key="scope" tone={tone} title={`The live space changed after ${scope.after}`}>
        <ul className="list-disc space-y-0.5 pl-4">
          {[...scope.conflicts, ...scope.leftAlone].map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Callout>,
    );
  }
  const callouts = ranked
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((c) => c.node);

  const roleText = roleNote(policy, role, REVISION_PERMISSIONS.build, "edit revisions");
  const baseShort = r.baseRelease?.name ?? r.base.label;
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={[{ label: "Revisions", href: revisionsHref }, { label: r.name }]} keepLastTwoBelow="lg" />
      <RevisionWorkspace
        alias={space.alias}
        zone={zone}
        revision={{
          id: r.id,
          name: r.name,
          branch: r.branch,
          headCommit: r.headCommit,
          baseLabel: r.base.label,
          baseKind: r.base.kind,
          baseShort,
          createdBy: r.createdBy,
          createdAt: r.createdAt.toISOString(),
          saves: r.changes,
          linkedFindings: r.linkedFindings,
        }}
        initialTab={initialTab}
        stateInput={{ state: r.state, changes: r.changes, lastBuild: r.lastBuild, plan: plan ? { state: plan.state } : null }}
        callouts={
          callouts.length || roleText ? (
            <>
              <RoleNote text={roleText} alias={space.alias} />
              {callouts.slice(0, 3)}
            </>
          ) : null
        }
        can={{ save: canSave, plan: canPlan, export: canExport, abandon: canSave }}
        saveBlocked={canSave ? detail.actions.save.reason : null}
        server={{ createPlan: detail.actions.createPlan, export: detail.actions.export, abandon: detail.actions.abandon }}
        plan={plan && planHref ? { planId: plan.planId, title: plan.title, state: plan.state, outOfDate: plan.outOfDate, href: planHref } : null}
        planScope={page.scope ? { changed: page.scope.changed } : null}
        exportHref={`/api/spaces/${encodeURIComponent(space.alias)}/revisions/${encodeURIComponent(r.id)}/export`}
        plansHref={`${base}/plans`}
        tree={detail.tree.map((t) => ({ path: t.path, size: t.size }))}
        folders={page.folders}
        marks={page.marks}
        initial={initial}
        build={
          detail.build
            ? { status: detail.build.status, errors: detail.build.errors, warnings: detail.build.warnings, ranAt: detail.build.ranAt, results: detail.build.results, omitted: detail.build.omitted, saveNumber: buildSave, leftOut: detail.build.leftOut ?? null }
            : null
        }
        leftOutNote={policy.revisions.export.leftOut.path}
        resultFiles={page.resultFiles}
        rebuilt={page.rebuilt}
        toAddress={page.toAddress}
        showToAddress={page.toAddress.length > 0 || takesFindings}
        canRemoveToAddress={canSave && takesFindings}
        removeToAddressAction={removeToAddressFindingAction.bind(null, space.alias, r.id)}
        auditsHref={`${base}/audits`}
        sourceAudits={page.sourceAudits}
        findings={detail.findings.map((f) => ({ id: f.id, title: f.title, incidentId: f.incidentId, kindLabel: page.findingLinks[f.id]?.kindLabel ?? f.kind, auditName: f.auditName, href: page.findingLinks[f.id]?.href ?? null, state: f.state }))}
        changelog={detail.changelog}
        changelogPath={page.changelogPath}
        baseDiff={page.baseDiff}
        saves={page.saves.map((s) => ({ ...s, createdAt: s.createdAt.toISOString() }))}
        limits={page.limits}
        pendingRunId={page.pendingRun?.runId ?? null}
        saveFindings={saveFindings}
        saveRules={{ unlinked: policy.revisions.save.unlinked, reasonMinChars: policy.revisions.save.reasonMinChars, reasonMaxChars: policy.revisions.save.reasonMaxChars, messageMaxChars: policy.revisions.save.messageMaxChars, maxFindings: policy.revisions.save.maxFindings }}
        saveAction={saveRevisionAction.bind(null, space.alias)}
        planAction={createRevisionPlanAction.bind(null, space.alias)}
        abandonAction={abandonRevisionAction.bind(null, space.alias)}
      />
    </div>
  );
}
