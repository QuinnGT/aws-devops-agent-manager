import { notFound } from "next/navigation";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { AuditChrome } from "@/components/audits/audit-buttons";
import { AuditHeader, type AuditTab } from "@/components/audits/audit-header";
import { auditHeaderData, getAuditCached } from "@/components/audits/detail-data";
import { auditsBase, loadAuditsPage } from "@/components/audits/page-guard";

/**
 * The audit's header and tabs (pages/audit-detail.md, "Shared header"), around
 * the Investigations, Findings and Report tabs. A draft renders the New audit
 * form without them, and an incident page has its own header, so the chrome
 * is chosen by the selected segment.
 */
export default async function AuditLayout({ children, params }: LayoutProps<"/spaces/[alias]/audits/[auditId]">) {
  const { alias, auditId } = await params;
  const { user, space, perms } = await loadAuditsPage(alias);
  const audit = await getAuditCached(space.id, auditId);
  if (!audit) notFound();
  if (audit.state === "draft") return <div className="mx-auto max-w-7xl space-y-4">{children}</div>;
  const data = await auditHeaderData(space, perms, audit.id, user.email);
  if (!data) notFound();
  const base = `${auditsBase(space.alias)}/${audit.id}`;
  const chrome = (tab: AuditTab, last: string | null) => (
    <>
      <SpaceTopBar
        space={space}
        user={user}
        crumbs={[{ label: "Audits", href: auditsBase(space.alias) }, last ? { label: audit.name, href: base } : { label: audit.name }, ...(last ? [{ label: last }] : [])]}
      />
      <AuditHeader data={data} tab={tab} />
    </>
  );
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <AuditChrome chrome={{ investigations: chrome("investigations", null), findings: chrome("findings", "Findings"), report: chrome("report", "Report") }} />
      {children}
    </div>
  );
}
