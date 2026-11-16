import "server-only";
import { notFound } from "next/navigation";
import { type AppUser, permissionsIn, requireUserOrRedirect, roleFor } from "@/server/auth/dal";
import { decodeParam } from "@/server/assets/guard";
import type { Permission } from "@/server/policy";
import type { PlanActor } from "@/server/plans/types";
import { getSpaceByAlias, type Space } from "@/server/spaces/queries";

/**
 * Guard for the plan, draft and draft editor pages: signed in, the space
 * exists, and the user has `permission` there (404 otherwise, like the other
 * space pages). Returns the user's permissions and role in the space as the
 * actor the loaders and the buttons-by-role tables take.
 */
export async function loadPlansPage(alias: string, permission: Permission = "assets.read"): Promise<{ user: AppUser; space: Space; perms: Set<Permission>; role: string | null; viewer: PlanActor }> {
  const user = await requireUserOrRedirect();
  const space = await getSpaceByAlias(decodeParam(alias));
  if (!space) notFound();
  const [perms, role] = await Promise.all([permissionsIn(user, space.id), roleFor(user, space.id)]);
  if (!perms.has(permission)) notFound();
  return { user, space, perms, role, viewer: { email: user.email, name: user.name, permissions: perms, role } };
}
