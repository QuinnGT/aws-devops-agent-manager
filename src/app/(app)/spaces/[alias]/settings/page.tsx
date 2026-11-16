import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { SectionCard } from "@/components/common/section-card";
import { Time } from "@/components/common/time";
import { AddBindingForm } from "@/components/spaces/binding-forms";
import { BindingsTable } from "@/components/spaces/bindings-table";
import { RolesCard } from "@/components/spaces/roles-card";
import { SettingsCard } from "@/components/spaces/settings-card";
import { CaptureSection, ConnectionSection, IncidentSection, InferenceSection, PlansSection, SpaceDetailsSection } from "@/components/spaces/space-settings-sections";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { can, requireUserOrRedirect, roleFor } from "@/server/auth/dal";
import { decodeParam } from "@/server/assets/guard";
import { getSyncState } from "@/server/assets/queries";
import { getAppPolicy } from "@/server/policy";
import { grantableRoles, listBindings, policyRoles, removeBlockReason } from "@/server/spaces/bindings";
import { connectionView } from "@/server/spaces/connection-state";
import { listMemoryStoreNames } from "@/server/spaces/overview";
import { approvalWarning, whoCanDoWhat } from "@/server/spaces/roles-view";
import { getHistoryRepoForSpace, getSpaceByAlias } from "@/server/spaces/queries";
import { removeBindingAction, saveBindingAction } from "../../../settings/actions";
import { ConnectionStatus } from "./_components/connection-status";
import { testConnectionAction, updateConnectionAction, updateSettingsSectionAction, updateSpaceDetailsAction } from "./actions";

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 px-4 py-3 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function SpaceSettingsPage({ params }: PageProps<"/spaces/[alias]/settings">) {
  const user = await requireUserOrRedirect();
  const { alias } = await params;
  const space = await getSpaceByAlias(decodeParam(alias));
  if (!space || !(await can(user, "assets.read", space.id))) notFound();

  const [canManage, canBind, canEditRepos] = await Promise.all([
    can(user, "spaces.manage", space.id),
    can(user, "bindings.manage", space.id),
    can(user, "spaces.manage", null),
  ]);
  const name = space.displayName ?? space.alias;
  const header = <PageHeader title="Space settings" description={`How the app reaches ${name}, records its history and runs plans. Each section saves on its own.`} />;
  const topBar = <SpaceTopBar space={space} user={user} crumbs={[{ label: "Space settings" }]} />;
  const policy = getAppPolicy().policy;
  const showHolders = canManage || canBind;
  const [repo, storeNames, bindings, myRole, sync] = await Promise.all([
    getHistoryRepoForSpace(space),
    canManage ? listMemoryStoreNames(space.id) : [],
    showHolders ? listBindings() : [],
    roleFor(user, space.id),
    canManage ? getSyncState(space.id) : null,
  ]);
  const bypass = user.devBypass && myRole ? { name: user.name, email: user.email, role: myRole } : null;
  const who = whoCanDoWhat(policy, bindings, space.id, bypass);

  if (!showHolders) {
    // Who holds each role is on the space's "Who can do what" page, so it isn't repeated here.
    return (
      <div className="mx-auto max-w-7xl space-y-4">
        {topBar}
        <PageHeader title="Space settings" />
        <SectionCard id="no-access" title="You can't change this space's settings">
          <EmptyState
            title="Space settings are for Admins"
            action={
              <Link href={`/spaces/${encodeURIComponent(space.alias)}/roles`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                See who has each role
              </Link>
            }
          >
            Changing them needs the Admin role. Ask an Admin of this space to change a setting or your role.
          </EmptyState>
        </SectionCard>
      </div>
    );
  }

  const settings = space.parsedSettings;
  const section = (s: Parameters<typeof updateSettingsSectionAction>[1]) => updateSettingsSectionAction.bind(null, space.id, s);
  const spaceBindings = bindings.filter((b) => b.spaceId === space.id);
  const roles = policyRoles(policy);

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      {topBar}
      {header}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <RolesCard spaceName={name} roles={who.roles} myRole={myRole} canChange bypass={bypass} />
          {canManage ? (
            <>
              <SpaceDetailsSection action={updateSpaceDetailsAction.bind(null, space.id)} displayName={space.displayName} environment={settings.environment} />
              <ConnectionSection
                action={updateConnectionAction.bind(null, space.id)}
                current={{ readRoleArn: space.readRoleArn, writeRoleArn: space.writeRoleArn, awsProfile: space.awsProfile }}
                accountId={space.accountId}
                externalId={space.externalId}
                status={<ConnectionStatus space={space} conn={connectionView(space, sync)} testAction={testConnectionAction.bind(null, space.id)} />}
              />
              <CaptureSection
                action={section("capture")}
                settings={settings}
                storeNames={storeNames}
                defaults={{
                  syncIntervalMinutes: policy.sync.intervalMinutes,
                  defaultStoreCommitPolicy: policy.sync.defaultStoreCommitPolicy,
                  storeCommitPolicies: policy.sync.storeCommitPolicies,
                }}
              />
              <IncidentSection action={section("incident")} rule={settings.incidentIdRule} />
              <PlansSection action={section("plans")} settings={settings} approvalWarning={approvalWarning(who.approvers, who.approverRoles, Boolean(bypass))} />
              <InferenceSection action={section("inference")} settings={settings.inference} spaceRegion={space.region} spaceAlias={space.alias} />
              {/* Replays stay hidden until they are built; their stored settings are kept. */}
            </>
          ) : null}
          {canBind ? (
            <SettingsCard
              id="bindings"
              title="Role bindings"
              description="Give a person or a group a role in this space only. Roles for all spaces are set in App settings."
            >
              <BindingsTable
                showScope={false}
                emptyText="Nobody has a role for this space only. Roles for all spaces, listed under Who can do what, still apply. Add a person or a sign-in group below."
                rows={spaceBindings.map((b) => ({
                  id: b.id,
                  scopeLabel: name,
                  subjectType: b.subjectType,
                  subject: b.subject,
                  role: b.role,
                  createdBy: b.createdBy,
                  remove: removeBindingAction.bind(null, b.id),
                  blockedReason: removeBlockReason(policy, b, bindings, myRole),
                }))}
              />
              <div className="border-t">
                <AddBindingForm
                  action={saveBindingAction}
                  scopes={[{ value: space.id, label: name }]}
                  roles={roles.map((r) => ({ name: r.name, description: r.description }))}
                  grantable={{ [space.id]: grantableRoles(policy, myRole) }}
                />
              </div>
            </SettingsCard>
          ) : null}
        </div>

        <aside className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1" aria-label="Registration and history repository">
          <SettingsCard id="registration" title="Registration" description="Fixed after registration. To change these, register the space again.">
            <Facts
              rows={[
                ["Alias", <span key="a" className="font-mono text-xs">{space.alias}</span>],
                ["Region", space.region],
                ["Account", <span key="b" className="font-mono text-xs">{space.accountId}</span>],
                ["Agent Space", <span key="c" className="font-mono text-xs break-all">{space.agentSpaceId}</span>],
                ["Registered", <Time key="d" value={space.createdAt} format="date" />],
              ]}
            />
          </SettingsCard>
          <SettingsCard id="history-repo" title="History repository" description="This space commits every change here. The repository is chosen at registration.">
            {repo ? (
              <>
                <Facts
                  rows={[
                    ["Name", <span key="a" className="font-mono text-xs break-all">{repo.name}</span>],
                    ["Remote", repo.remoteUrl ? <span key="b" className="font-mono text-xs break-all">{repo.remoteUrl}</span> : "None (local only)"],
                    ["Branch", <span key="c" className="font-mono text-xs">{repo.defaultBranch}</span>],
                    ["Push", repo.pushEnabled ? "On: commits go to the remote" : "Off: commits stay on this machine"],
                  ]}
                />
                <div className="border-t px-4 py-3">
                  {canEditRepos ? (
                    <Link href="/settings#repositories" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                      Edit in App settings
                    </Link>
                  ) : (
                    <p className="text-xs text-muted-foreground">An Admin for all spaces edits repositories in App settings.</p>
                  )}
                </div>
              </>
            ) : (
              <EmptyState title="No history repository">This space has no repository, so its changes are not recorded.</EmptyState>
            )}
          </SettingsCard>
        </aside>
      </div>
    </div>
  );
}
