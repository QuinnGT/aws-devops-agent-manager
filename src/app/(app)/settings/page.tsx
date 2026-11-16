import { Pencil, Plus } from "lucide-react";
import { TopBar } from "@/components/app-shell/top-bar";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { SectionCard } from "@/components/common/section-card";
import { AddBindingForm } from "@/components/spaces/binding-forms";
import { BindingsTable } from "@/components/spaces/bindings-table";
import { HistoryRepoDialog } from "@/components/spaces/history-repo-form";
import { SettingsCard } from "@/components/spaces/settings-card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { can, requireUserOrRedirect, roleFor } from "@/server/auth/dal";
import { getAppPolicy } from "@/server/policy";
import { grantableRoles, listBindings, policyRoles, removeBlockReason } from "@/server/spaces/bindings";
import { listHistoryRepos, spacesByHistoryRepo } from "@/server/spaces/history-repos";
import { listSpaces } from "@/server/spaces/queries";
import { createHistoryRepoAction, removeBindingAction, saveBindingAction, updateHistoryRepoAction } from "./actions";

const header = <PageHeader title="App settings" description="History repositories and role bindings shared by every space. Each section saves on its own." />;
const topBar = <TopBar crumbs={[{ label: "App settings" }]} />;

export default async function SettingsPage() {
  const user = await requireUserOrRedirect();
  const spaces = await listSpaces();
  const [canRepos, canGlobalBindings] = await Promise.all([can(user, "spaces.manage", null), can(user, "bindings.manage", null)]);
  const bindingSpaces = [];
  for (const s of spaces) if (await can(user, "bindings.manage", s.id)) bindingSpaces.push(s);
  const bindingSpaceIds = new Set(bindingSpaces.map((s) => s.id));

  if (!canRepos && !canGlobalBindings && bindingSpaces.length === 0) {
    return (
      <div className="mx-auto max-w-7xl space-y-4">
        {topBar}
        <PageHeader title="App settings" />
        <SectionCard id="no-access" title="You can't change app settings">
          <EmptyState title="App settings are for Admins">
            Changing them needs the spaces.manage or bindings.manage permission, which the Admin role has. Ask an Admin to change a setting or your
            role.
          </EmptyState>
        </SectionCard>
      </div>
    );
  }

  const policy = getAppPolicy().policy;
  const [repos, usedBy, bindings] = await Promise.all([canRepos ? listHistoryRepos() : [], canRepos ? spacesByHistoryRepo() : new Map<string, string[]>(), listBindings()]);
  const visibleBindings = bindings.filter((b) => (b.spaceId === null ? canGlobalBindings : bindingSpaceIds.has(b.spaceId)));
  const spaceLabel = (s: { alias: string; displayName: string | null }) => s.displayName ?? s.alias;
  const scopes = [
    ...(canGlobalBindings ? [{ value: "", label: "All spaces" }] : []),
    ...bindingSpaces.map((s) => ({ value: s.id, label: spaceLabel(s) })),
  ];
  const myRoles = new Map<string, string | null>();
  for (const scope of scopes) myRoles.set(scope.value, await roleFor(user, scope.value || null));
  const roles = policyRoles(policy);
  const nameById = new Map(spaces.map((s) => [s.id, spaceLabel(s)]));

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      {topBar}
      {header}

      {canRepos ? (
        <SettingsCard
          id="repositories"
          title="History repositories"
          description="Each space commits its history to one repository. The app stores a path to the deploy key, never the key, and push stays off until you turn it on."
          aside={
            <HistoryRepoDialog
              action={createHistoryRepoAction}
              current={null}
              title="Add a history repository"
              description="Spaces choose a repository when they are registered."
              submitLabel="Add repository"
              trigger={
                <Button type="button" variant="outline" size="sm">
                  <Plus aria-hidden />
                  Add repository
                </Button>
              }
            />
          }
        >
          {repos.length === 0 ? (
            <EmptyState title="No repositories yet">Add one here, or when you register a space.</EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Name</TableHead>
                  <TableHead>Remote</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Push</TableHead>
                  <TableHead>Used by</TableHead>
                  <TableHead className="pr-4 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {repos.map((r) => {
                  const users = usedBy.get(r.id) ?? [];
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="pl-4 font-mono text-xs">{r.name}</TableCell>
                      <TableCell className="max-w-80 truncate font-mono text-xs" title={r.remoteUrl ?? undefined}>
                        {r.remoteUrl ?? <span className="font-sans text-muted-foreground">Local only</span>}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.defaultBranch}</TableCell>
                      <TableCell>{r.pushEnabled ? "On" : "Off"}</TableCell>
                      <TableCell className="text-xs">{users.length ? users.join(", ") : <span className="text-muted-foreground">No spaces</span>}</TableCell>
                      <TableCell className="pr-4 text-right">
                        <HistoryRepoDialog
                          action={updateHistoryRepoAction.bind(null, r.id)}
                          current={{ name: r.name, remoteUrl: r.remoteUrl, deployKeyFile: r.deployKeyFile, defaultBranch: r.defaultBranch, pushEnabled: r.pushEnabled }}
                          lockedBy={users[0] ?? null}
                          title={`Edit ${r.name}`}
                          description={users.length ? `Used by ${users.join(", ")}.` : "No space writes to this repository yet."}
                          submitLabel="Save repository"
                          trigger={
                            <Button type="button" variant="outline" size="sm" aria-label={`Edit ${r.name}`}>
                              <Pencil aria-hidden />
                              Edit
                            </Button>
                          }
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </SettingsCard>
      ) : null}

      {scopes.length > 0 ? (
        <SettingsCard
          id="bindings"
          title="Role bindings"
          description="Give a person (by email) or a group from your sign-in provider a role, for all spaces or one space. When several match, the highest role wins."
        >
          <BindingsTable
            showScope
            emptyText="Add a person or a sign-in group below."
            rows={visibleBindings.map((b) => ({
              id: b.id,
              scopeLabel: b.spaceId ? (nameById.get(b.spaceId) ?? b.spaceAlias ?? "Unknown space") : "All spaces",
              subjectType: b.subjectType,
              subject: b.subject,
              role: b.role,
              createdBy: b.createdBy,
              remove: removeBindingAction.bind(null, b.id),
              blockedReason: removeBlockReason(policy, b, bindings, myRoles.get(b.spaceId ?? "") ?? null),
            }))}
          />
          <div className="border-t">
            <AddBindingForm
              action={saveBindingAction}
              scopes={scopes}
              roles={roles.map((r) => ({ name: r.name, description: r.description }))}
              grantable={Object.fromEntries(scopes.map((s) => [s.value, grantableRoles(policy, myRoles.get(s.value) ?? null)]))}
            />
          </div>
        </SettingsCard>
      ) : null}
    </div>
  );
}
