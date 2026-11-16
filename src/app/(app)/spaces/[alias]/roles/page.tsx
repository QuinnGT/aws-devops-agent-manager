import Link from "next/link";
import { notFound } from "next/navigation";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { PageHeader } from "@/components/common/page-header";
import { SectionCard } from "@/components/common/section-card";
import { RolesCard } from "@/components/spaces/roles-card";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { can, requireUserOrRedirect, roleFor } from "@/server/auth/dal";
import { decodeParam } from "@/server/assets/guard";
import { getAppPolicy } from "@/server/policy";
import { listBindings } from "@/server/spaces/bindings";
import { approvalSentence, whoCanDoWhat } from "@/server/spaces/roles-view";
import { getSpaceByAlias } from "@/server/spaces/queries";

/**
 * "Who can do what" for everyone who can see the space: each role, what it
 * allows, and who holds it here, so "Ask an Admin of this space" leads
 * somewhere. Read only; role bindings are edited in Space settings.
 */
export default async function RolesPage({ params }: PageProps<"/spaces/[alias]/roles">) {
  const user = await requireUserOrRedirect();
  const { alias } = await params;
  const space = await getSpaceByAlias(decodeParam(alias));
  if (!space || !(await can(user, "assets.read", space.id))) notFound();

  const [bindings, myRole, canManage, canBind] = await Promise.all([
    listBindings(),
    roleFor(user, space.id),
    can(user, "spaces.manage", space.id),
    can(user, "bindings.manage", space.id),
  ]);
  const name = space.displayName ?? space.alias;
  const bypass = user.devBypass && myRole ? { name: user.name, email: user.email, role: myRole } : null;
  const who = whoCanDoWhat(getAppPolicy().policy, bindings, space.id, bypass);

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={[{ label: "Who can do what" }]} />
      <PageHeader
        title="Who can do what"
        description={`Each role in ${name}, what it can do, and who holds it here.`}
        actions={
          canManage || canBind ? (
            <Link href={`/spaces/${encodeURIComponent(space.alias)}/settings#bindings`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
              Change roles in Space settings
            </Link>
          ) : undefined
        }
      />
      <RolesCard title="Roles" spaceName={name} roles={who.roles} myRole={myRole} canChange={canManage || canBind} bypass={bypass} />
      <SectionCard id="approvals" title="Approving and applying plans">
        <p className="max-w-[72ch] px-4 py-3 text-[13px]">{approvalSentence(who.approverRoles, space.parsedSettings.approvalRequired)}</p>
      </SectionCard>
    </div>
  );
}
