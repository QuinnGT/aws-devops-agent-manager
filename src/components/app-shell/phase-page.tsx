import { notFound } from "next/navigation";
import { PhasePlaceholder } from "@/components/common/phase-placeholder";
import { can, requireUserOrRedirect } from "@/server/auth/dal";
import { decodeParam } from "@/server/assets/guard";
import { getSpaceByAlias } from "@/server/spaces/queries";
import { NAV_GROUPS } from "./nav";
import { SpaceTopBar } from "./space-top-bar";

/**
 * A space route whose nav item belongs to a later phase: checks the item's
 * read permission (404 without it, like other space pages), then renders the
 * top bar and PhasePlaceholder.
 */
export async function PhasePage({ alias, itemKey, description }: { alias: string; itemKey: string; description: string }) {
  const item = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.key === itemKey);
  if (!item || item.requires.kind !== "space") throw new Error(`no space nav item ${itemKey}`);
  const user = await requireUserOrRedirect();
  const space = await getSpaceByAlias(decodeParam(alias));
  if (!space || !(await can(user, item.requires.permission, space.id))) notFound();
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <SpaceTopBar space={space} user={user} crumbs={[{ label: item.label }]} />
      <PhasePlaceholder phase={item.phase} title={item.label} description={description} />
    </div>
  );
}
