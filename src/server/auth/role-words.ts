import type { Policy } from "@/server/policy";
import type { Permission } from "@/server/policy/sections/roles";
import { permissionsForRole } from "./roles";

type RolesPolicy = Pick<Policy, "roles">;

/** "publisher" becomes "Publisher". Role names are policy keys. */
export function roleTitle(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/** Roles that hold `permission`, lowest rank first. */
export function rolesWith(policy: RolesPolicy, permission: Permission): string[] {
  return Object.entries(policy.roles.roles)
    .filter(([name]) => permissionsForRole(policy, name).has(permission))
    .sort(([, a], [, b]) => a.rank - b.rank)
    .map(([name]) => name);
}

/** "Editors, Publishers and Admins" */
function pluralList(roles: string[]): string {
  const words = roles.map((r) => `${roleTitle(r)}s`);
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * Why the caller can't do something, naming the roles that can. `action` is a
 * verb phrase such as "apply plans".
 * "Only Publishers and Admins can apply plans. You're a Viewer."
 */
export function missingRoleReason(policy: RolesPolicy, role: string | null, permission: Permission, action: string): string {
  const who = rolesWith(policy, permission);
  const can = who.length ? `Only ${pluralList(who)} can ${action}.` : `No role can ${action}.`;
  return role ? `${can} You're ${article(role)} ${roleTitle(role)}.` : `${can} You don't have a role in this space.`;
}

/**
 * One line for a page whose controls the caller's role hides, or null when the
 * role holds `permission`. Use it once near the top of the page.
 * "You're a Viewer, so you can look but not draft changes. Editors, Publishers and Admins can draft changes."
 */
export function roleNote(policy: RolesPolicy, role: string | null, permission: Permission, action: string): string | null {
  if (role && permissionsForRole(policy, role).has(permission)) return null;
  const who = rolesWith(policy, permission);
  const others = who.length ? ` ${pluralList(who)} can ${action}.` : "";
  return role
    ? `You're ${article(role)} ${roleTitle(role)}, so you can look but not ${action}.${others}`
    : `You don't have a role in this space, so you can't ${action}.${others}`;
}

function article(role: string): string {
  return /^[aeiou]/i.test(role) ? "an" : "a";
}
