import { permissionsForRole } from "@/server/auth/roles";
import { roleTitle, rolesWith } from "@/server/auth/role-words";
import type { Policy } from "@/server/policy";
import type { Permission } from "@/server/policy/sections/roles";

/**
 * Role notes for the audit pages, in the shared pattern "You're a <role>, so
 * you can <what> but not <what>." followed by the roles that can. Pure; for
 * the RoleNote component. Null when the role holds the permission.
 */

const article = (role: string) => (/^[aeiou]/i.test(role) ? "an" : "a");

function rolesSentence(policy: Pick<Policy, "roles">, permission: Permission, action: string): string {
  const who = rolesWith(policy, permission).map((r) => `${roleTitle(r)}s`);
  if (!who.length) return "";
  const list = who.length === 1 ? who[0]! : `${who.slice(0, -1).join(", ")} and ${who.at(-1)}`;
  return ` ${list} can ${action}.`;
}

function note(policy: Pick<Policy, "roles">, role: string | null, permission: Permission, can: string, cannot: string, others: string): string | null {
  if (role && permissionsForRole(policy, role).has(permission)) return null;
  const head = role ? `You're ${article(role)} ${roleTitle(role)}, so you can ${can} but not ${cannot}.` : `You don't have a role in this space, so you can ${can} but not ${cannot}.`;
  return `${head}${rolesSentence(policy, permission, others)}`;
}

/** Incident page and Findings tab. */
export function decideFindingsNote(policy: Pick<Policy, "roles">, role: string | null): string | null {
  return note(policy, role, "findings.review", "read findings", "decide them", "accept, edit and reject findings");
}

/** Audits list, where "New audit" would be. */
export function startAuditsNote(policy: Pick<Policy, "roles">, role: string | null): string | null {
  return note(policy, role, "audits.run", "read audits and their reports", "start audits", "start audits");
}
