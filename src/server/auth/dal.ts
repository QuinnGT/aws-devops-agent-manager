import "server-only";
import { headers } from "next/headers";
import { connection } from "next/server";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/server/db/client";
import { roleBindings } from "@/server/db/schema";
import { env } from "@/server/env";
import { getAppPolicy } from "@/server/policy";
import type { Permission } from "@/server/policy/sections/roles";
import { auth } from "./better-auth";
import { effectiveRole, permissionsForRole } from "./roles";

/**
 * Data Access Layer: the only place that decides who the caller is and what
 * they may do. Every Server Action, Route Handler and data-reading Server
 * Component calls requireUser / requirePermission. proxy.ts only redirects
 * signed-out users; it is not the authorization check.
 */

export interface AppUser {
  id: string;
  email: string;
  name: string;
  groups: string[];
  /** True when signed in through AUTH_DEV_BYPASS */
  devBypass: boolean;
}

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Current user, or null. Fails closed: no IdP and no bypass means nobody is signed in. */
export const getCurrentUser = cache(async (): Promise<AppUser | null> => {
  // Auth is always decided per request: never let a page that checks the user be prerendered.
  await connection();
  const e = env();
  if (e.devBypass) {
    return { id: `dev:${e.devUser.email}`, email: e.devUser.email, name: e.devUser.name, groups: [], devBypass: true };
  }
  const a = auth();
  if (!a) return null;
  const s = await a.api.getSession({ headers: await headers() });
  if (!s) return null;
  const u = s.user as typeof s.user & { idpGroups?: string | null };
  let groups: string[] = [];
  try {
    groups = u.idpGroups ? (JSON.parse(u.idpGroups) as string[]) : [];
  } catch {
    groups = [];
  }
  return { id: u.id, email: u.email, name: u.name, groups, devBypass: false };
});

/** For Server Components and pages: redirect to sign-in when signed out. */
export async function requireUserOrRedirect(): Promise<AppUser> {
  const u = await getCurrentUser();
  if (!u) redirect("/sign-in");
  return u;
}

/** For Server Actions and Route Handlers: throw AuthError(401) when signed out. */
export async function requireUser(): Promise<AppUser> {
  const u = await getCurrentUser();
  if (!u) throw new AuthError(401, "Not signed in");
  return u;
}

/** The caller's role in a space (or globally when spaceId is null). */
export async function roleFor(u: AppUser, spaceId: string | null): Promise<string | null> {
  if (u.devBypass) return env().devUser.role;
  const bindings = await db().select().from(roleBindings);
  return effectiveRole(getAppPolicy().policy, bindings, { email: u.email, groups: u.groups }, spaceId);
}

export async function can(u: AppUser, permission: Permission, spaceId: string | null): Promise<boolean> {
  return (await permissionsIn(u, spaceId)).has(permission);
}

/** Every permission the caller has in the space (or globally when spaceId is null). */
export async function permissionsIn(u: AppUser, spaceId: string | null): Promise<Set<Permission>> {
  const role = await roleFor(u, spaceId);
  return role ? permissionsForRole(getAppPolicy().policy, role) : new Set();
}

/** Throw AuthError(403) unless the caller has `permission` in the space. */
export async function requirePermission(permission: Permission, spaceId: string | null): Promise<AppUser> {
  const u = await requireUser();
  if (!(await can(u, permission, spaceId))) throw new AuthError(403, `Missing permission ${permission}`);
  return u;
}

/** Map an AuthError to a JSON Response for Route Handlers. */
export function authErrorResponse(err: unknown): Response | null {
  if (err instanceof AuthError) return Response.json({ error: err.message }, { status: err.status });
  return null;
}
