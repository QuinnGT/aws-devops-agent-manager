import { notFound } from "next/navigation";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { PageHeader } from "@/components/common/page-header";
import { RoleNote } from "@/components/common/role-note";
import { SectionCard } from "@/components/common/section-card";
import { can, requireUserOrRedirect, roleFor } from "@/server/auth/dal";
import { roleNote } from "@/server/auth/role-words";
import { decodeParam } from "@/server/assets/guard";
import { policyForSpace } from "@/server/journals/policy";
import { PACKAGE_IO_PERMISSIONS } from "@/server/package-io";
import { formatBytes } from "@/server/package-io/format";
import { listLayouts } from "@/server/packages/layout";
import { getSpaceByAlias } from "@/server/spaces/queries";
import { UploadForm } from "./_components/upload-form";

/**
 * Upload a package (pages/package-import.md, "Upload"). Uploading needs
 * plans.create in the space; anyone who can read the space sees the page,
 * and a role without it reads why instead of the form.
 */
export default async function ImportPackagePage({ params }: PageProps<"/spaces/[alias]/plans/import">) {
  const user = await requireUserOrRedirect();
  const space = await getSpaceByAlias(decodeParam((await params).alias));
  if (!space || !(await can(user, PACKAGE_IO_PERMISSIONS.read, space.id))) notFound();
  const [{ policy }, canImport, role] = await Promise.all([policyForSpace(space), can(user, PACKAGE_IO_PERMISSIONS.import, space.id), roleFor(user, space.id)]);
  const limits = policy.limits.packageRead;
  const base = `/spaces/${encodeURIComponent(space.alias)}`;
  const note = canImport ? null : roleNote(policy, role, PACKAGE_IO_PERMISSIONS.import, "import packages");

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={[{ label: "Plans", href: `${base}/plans` }, { label: "Import package" }]} />
      <PageHeader
        title="Import package"
        description="Upload an instruction package as a zip. The app finds the asset each file belongs to and builds a plan that shows every change. Nothing changes in the space until the plan is applied."
      />
      {note ? <RoleNote text={note} alias={space.alias} /> : null}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        {note ? null : (
          <UploadForm
            alias={space.alias}
            layouts={listLayouts(policy).map(({ name, label }) => ({ name, label }))}
            defaultLayout={policy.packageLayouts.defaultLayout ?? null}
            limits={{ maxZipBytes: limits.maxZipBytes, maxEntries: limits.maxEntries, maxTotalBytes: limits.maxTotalBytes }}
            limitsLine={`Up to ${formatBytes(limits.maxZipBytes)} and ${limits.maxEntries.toLocaleString("en-US")} files. Absolute paths, .. segments and symlinks are rejected.`}
          />
        )}
        <SectionCard id="import-checks-h" title="What the import checks">
          <ol className="list-decimal space-y-1.5 py-3 pr-4 pl-8 text-[13px]">
            <li>Finds the asset each file belongs to, and lists the files that aren&apos;t assets</li>
            <li>Packs each skill and each memory store&apos;s list of memories from the source files, the way the space stores them</li>
            <li>Checks the package, and each asset against the rules for its type</li>
            <li>Compares each asset with the live space: create, update or unchanged</li>
          </ol>
        </SectionCard>
      </div>
    </div>
  );
}
