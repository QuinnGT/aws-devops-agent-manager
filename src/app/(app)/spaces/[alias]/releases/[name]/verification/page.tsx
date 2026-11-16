import Link from "next/link";
import { notFound } from "next/navigation";
import { SpaceTopBar } from "@/components/app-shell/space-top-bar";
import { Callout } from "@/components/common/callout";
import { Time } from "@/components/common/time";
import { LiveStateCard } from "@/components/verify/live-card";
import { ReadsCard } from "@/components/verify/reads-card";
import type { FileShow } from "@/components/verify/views";
import { can, requireUserOrRedirect } from "@/server/auth/dal";
import { decodeParam, firstParam } from "@/server/assets/guard";
import { loadExportOptions } from "@/server/package-io/loaders";
import { getAppPolicy } from "@/server/policy";
import { loadReleasePage, RELEASE_PERMISSIONS } from "@/server/releases";
import { getSpaceByAlias } from "@/server/spaces/queries";
import { loadVerificationFor, VERIFY_PERMISSIONS } from "@/server/verify";
import { getReleaseByName } from "@/server/releases/queries";
import { ReleaseHeader, ReleaseTabs } from "../_components/release-header";
import { runVerificationCheckAction } from "./actions";

const TYPE_RE = /^[a-z][a-z0-9_]{0,40}$/;

/**
 * The release page's Verification tab (pages/release-verification.md):
 * whether the live space still matches the release, and what the agent read
 * in the investigations since. Reading needs history.read; "Run check" needs
 * sync.run.
 */
export default async function ReleaseVerificationPage({ params, searchParams }: PageProps<"/spaces/[alias]/releases/[name]/verification">) {
  const user = await requireUserOrRedirect();
  const { alias, name: rawName } = await params;
  const space = await getSpaceByAlias(decodeParam(alias));
  if (!space || !(await can(user, VERIFY_PERMISSIONS.read, space.id))) notFound();
  const name = decodeParam(rawName);
  if (name.length > 200) notFound();
  const row = await getReleaseByName(space.id, name);
  if (!row) notFound();

  const [page, verification, canRollback, canManage, canRun, canExport, exportOptions] = await Promise.all([
    loadReleasePage(space, name),
    loadVerificationFor(space, row),
    can(user, RELEASE_PERMISSIONS.planRollback, space.id),
    can(user, "spaces.manage", space.id),
    can(user, VERIFY_PERMISSIONS.start, space.id),
    can(user, "journals.export", space.id),
    loadExportOptions(space),
  ]);
  if (!page) notFound();

  const sp = await searchParams;
  const show: FileShow = firstParam(sp.files) === "all" ? "all" : "look";
  const rawType = firstParam(sp.type);
  const type = rawType && TYPE_RE.test(rawType) ? rawType : null;
  const spaceBase = `/spaces/${encodeURIComponent(space.alias)}`;
  const base = `${spaceBase}/releases`;
  const tabHref = `${base}/${encodeURIComponent(page.release.name)}/verification`;
  const action = (kind: "live" | "reads") => (canRun ? runVerificationCheckAction.bind(null, space.alias, page.release.name, kind) : null);
  const applied = verification.applied;

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={[{ label: "Releases", href: base }, { label: page.release.name }]} />
      <ReleaseHeader alias={space.alias} view={page} canRollback={canRollback} canManage={canManage} exportOptions={exportOptions} />
      <ReleaseTabs alias={space.alias} view={page} current="verification" />

      <p className="text-[13px] text-muted-foreground">
        {applied ? (
          <>
            Applied by plan{" "}
            <Link href={`${spaceBase}/plans/${encodeURIComponent(applied.planId)}`} className="text-foreground underline underline-offset-4">
              {applied.title}
            </Link>{" "}
            on <Time value={applied.at ?? verification.release.createdAt} format="datetime" />.
          </>
        ) : (
          <>
            Created from the live space on <Time value={verification.release.createdAt} format="datetime" />.
          </>
        )}{" "}
        The checks compare the live space and what the agent read with this release.
      </p>

      {!page.manifestOk ? (
        <Callout tone="destructive" title={`The manifest of ${page.release.name} can't be read`}>
          Neither check can run until the release row holds a manifest this version of the app understands.
        </Callout>
      ) : null}

      <LiveStateCard alias={space.alias} releaseName={page.release.name} view={verification} action={action("live")} canManage={canManage} />
      <ReadsCard
        alias={space.alias}
        view={verification}
        action={action("reads")}
        canManage={canManage}
        canExport={canExport}
        show={show}
        type={type}
        policy={getAppPolicy().policy}
        baseHref={tabHref}
      />
    </div>
  );
}
