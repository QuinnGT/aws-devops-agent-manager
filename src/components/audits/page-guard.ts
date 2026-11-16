import "server-only";
import { notFound } from "next/navigation";
import { type AppUser, permissionsIn, requireUserOrRedirect, roleFor } from "@/server/auth/dal";
import { decodeParam } from "@/server/assets/guard";
import type { AuditViewer } from "@/server/audits/actions";
import type { Permission } from "@/server/policy";
import { getSpaceByAlias, type Space } from "@/server/spaces/queries";

/**
 * Guard for the audit pages: signed in, the space exists, and the user holds
 * `audits.read` there (404 otherwise, like the other space pages). Returns
 * the permissions as the viewer the audits loaders take.
 */
export async function loadAuditsPage(alias: string): Promise<{ user: AppUser; space: Space; perms: Set<Permission>; role: string | null; viewer: AuditViewer }> {
  const user = await requireUserOrRedirect();
  const space = await getSpaceByAlias(decodeParam(alias));
  if (!space) notFound();
  const [perms, role] = await Promise.all([permissionsIn(user, space.id), roleFor(user, space.id)]);
  if (!perms.has("audits.read")) notFound();
  return { user, space, perms, role, viewer: { permissions: perms } };
}

export const auditsBase = (alias: string) => `/spaces/${encodeURIComponent(alias)}/audits`;
