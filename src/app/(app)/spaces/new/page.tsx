import { TopBar } from "@/components/app-shell/top-bar";
import { Callout } from "@/components/common/callout";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { SectionCard } from "@/components/common/section-card";
import { RegisterSpaceForm } from "@/components/spaces/register-space-form";
import { can, requireUserOrRedirect } from "@/server/auth/dal";
import { listHistoryRepos } from "@/server/spaces/history-repos";
import { registerSpaceAction } from "./actions";

const topBar = <TopBar crumbs={[{ label: "All spaces", href: "/spaces" }, { label: "Register a space" }]} />;

export default async function NewSpacePage() {
  const user = await requireUserOrRedirect();
  const header = <PageHeader title="Register an Agent Space" description="Connect an Agent Space so the app can record its history and, later, apply plans to it." />;
  if (!(await can(user, "spaces.manage", null))) {
    return (
      <div className="mx-auto max-w-7xl space-y-4">
        {topBar}
        <PageHeader title="Register an Agent Space" />
        <SectionCard id="no-access" title="You can't register spaces">
          <EmptyState title="Registering a space is for Admins">
            It needs the spaces.manage permission for all spaces, which the Admin role has. Ask an Admin to register the space.
          </EmptyState>
        </SectionCard>
      </div>
    );
  }
  const repos = await listHistoryRepos();
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      {topBar}
      {header}
      <div className="max-w-4xl space-y-4">
        <Callout tone="info" title="What happens next">
          The app runs a connection test (GetAgentSpace, ListAssetTypes and ListAssets with one item) and shows its progress on the space&apos;s
          home page. When it passes, the first sync writes every asset to the history repository.
        </Callout>
        <RegisterSpaceForm action={registerSpaceAction} repos={repos.map((r) => ({ id: r.id, name: r.name, remoteUrl: r.remoteUrl }))} />
      </div>
    </div>
  );
}
