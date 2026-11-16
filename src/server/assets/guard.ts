import "server-only";
import { notFound } from "next/navigation";
import { can, requireUserOrRedirect, type AppUser } from "@/server/auth/dal";
import type { Permission } from "@/server/policy";
import { getSpaceByAlias, type Space } from "@/server/spaces/queries";
import { URL_ASSET_ID } from "./config";
import { liveDepsForSpace, type LiveDeps } from "./live";

/**
 * Page guard for the asset and history pages: signed in, space exists, and
 * the user has `permission` in that space. A missing space and a missing
 * permission both render 404, so the page doesn't reveal which spaces exist.
 */
export async function loadSpaceForPage(alias: string, permission: Permission): Promise<{ user: AppUser; space: Space; live: LiveDeps }> {
  const user = await requireUserOrRedirect();
  const space = await getSpaceByAlias(decodeParam(alias));
  if (!space || !(await can(user, permission, space.id))) notFound();
  return { user, space, live: liveDepsForSpace(space, { email: user.email }) };
}

export function decodeParam(s: string): string {
  if (!s.includes("%")) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Asset ID from a route param, or 404. */
export function assetIdParam(raw: string): string {
  const id = decodeParam(raw);
  if (!URL_ASSET_ID.test(id)) notFound();
  return id;
}

export function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
