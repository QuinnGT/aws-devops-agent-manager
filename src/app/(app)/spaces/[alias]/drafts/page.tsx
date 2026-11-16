import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { spaceBase } from "@/components/app-shell/nav";
import { Time } from "@/components/common/time";
import { DraftsTable } from "@/components/drafts/drafts-table";
import { loadPlansPage } from "@/components/plans/page-guard";
import { PlansHeader } from "@/components/plans/plans-header";
import { firstParam } from "@/server/assets/guard";
import { loadDraftTable } from "@/server/drafts/loaders";
import { countPlans } from "@/server/plans/loaders";
import { PLAN_STATUS_FILTERS } from "@/server/plans/view";
import { createPlanFromDraftsAction, discardDraftAction } from "./actions";

/** Drafts (design-system pages/drafts.md): open drafts of the space, and "Create plan" from your own. */
export default async function DraftsPage({ params, searchParams }: PageProps<"/spaces/[alias]/drafts">) {
  const { alias } = await params;
  const { user, space, perms, viewer } = await loadPlansPage(alias);
  const who = firstParam((await searchParams).who) === "mine" ? "mine" : "all";
  const base = spaceBase(space.alias);
  const [table, openPlans] = await Promise.all([loadDraftTable(space.id, viewer, { mine: who === "mine" }), countPlans(space.id, { states: PLAN_STATUS_FILTERS.open })]);
  const saved = Object.fromEntries(table.rows.map((r) => [r.id, <Time key={r.id} value={r.updatedAt} format="datetime" />]));

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={[{ label: "Plans", href: `${base}/plans` }, { label: "Drafts" }]} />
      <PlansHeader alias={space.alias} current="drafts" openPlans={openPlans} openDrafts={table.counts.all} canImport={perms.has("plans.create")} />
      <DraftsTable
        base={base}
        who={who}
        counts={table.counts}
        rows={table.rows}
        saved={saved}
        canCreatePlan={perms.has("plans.create")}
        canDiscard={perms.has("drafts.write")}
        createPlan={createPlanFromDraftsAction.bind(null, space.alias)}
        discard={discardDraftAction.bind(null, space.alias)}
      />
    </div>
  );
}
