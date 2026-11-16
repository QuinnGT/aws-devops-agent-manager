import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { AuditForm } from "@/components/audits/audit-form";
import { auditFormProps } from "@/components/audits/form-data";
import { auditsBase, loadAuditsPage } from "@/components/audits/page-guard";
import { ConnectionNextStep } from "@/components/common/connection-next-step";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { RoleNote } from "@/components/common/role-note";
import { roleNote } from "@/server/auth/role-words";
import { getAppPolicy } from "@/server/policy";
import { actorOf } from "@/server/spaces/actor";

/** New audit (design-system pages/audit-new.md). Nothing is stored until "Save draft", the first upload or Start. */
export default async function NewAuditPage({ params }: PageProps<"/spaces/[alias]/audits/new">) {
  const { alias } = await params;
  const { user, space, perms, role } = await loadAuditsPage(alias);
  const crumbs = [{ label: "Audits", href: auditsBase(space.alias) }, { label: "New audit" }];
  if (!perms.has("audits.run")) {
    return (
      <div className="mx-auto max-w-7xl space-y-4">
        <SpaceTopBar space={space} user={user} crumbs={crumbs} />
        <PageHeader title="New audit" />
        <EmptyState title="Starting an audit is for Editors">
          <RoleNote text={roleNote(getAppPolicy().policy, role, "audits.run", "run audits")} alias={space.alias} />
        </EmptyState>
      </div>
    );
  }
  const props = await auditFormProps(space, perms, null, actorOf(user));
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={crumbs} />
      <AuditForm {...props} connectionNextStep={<ConnectionNextStep alias={space.alias} canManage={perms.has("spaces.manage")} />} />
    </div>
  );
}
