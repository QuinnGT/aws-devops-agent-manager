import type { Policy } from "@/server/policy";
import type { Permission } from "@/server/policy/sections/roles";

/** Expand a role into its permissions, following `inherits`. Pure; unit-tested. */
export function permissionsForRole(policy: Pick<Policy, "roles">, roleName: string, seen = new Set<string>()): Set<Permission> {
  const out = new Set<Permission>();
  const role = policy.roles.roles[roleName];
  if (!role || seen.has(roleName)) return out;
  seen.add(roleName);
  for (const p of role.permissions) out.add(p);
  for (const parent of role.inherits) for (const p of permissionsForRole(policy, parent, seen)) out.add(p);
  return out;
}

export interface BindingRow {
  spaceId: string | null;
  subjectType: "user" | "group";
  subject: string;
  role: string;
}

/**
 * The effective role for a user in a space: the highest-ranked role among
 * bindings that match the user's email or IdP groups, for that space or global.
 */
export function effectiveRole(
  policy: Pick<Policy, "roles">,
  bindings: BindingRow[],
  who: { email: string; groups: string[] },
  spaceId: string | null,
): string | null {
  let best: { name: string; rank: number } | null = null;
  const email = who.email.toLowerCase();
  for (const b of bindings) {
    if (b.spaceId !== null && b.spaceId !== spaceId) continue;
    const match = b.subjectType === "user" ? b.subject.toLowerCase() === email : who.groups.includes(b.subject);
    if (!match) continue;
    const rank = policy.roles.roles[b.role]?.rank;
    if (rank === undefined) continue;
    if (!best || rank > best.rank) best = { name: b.role, rank };
  }
  return best?.name ?? null;
}
