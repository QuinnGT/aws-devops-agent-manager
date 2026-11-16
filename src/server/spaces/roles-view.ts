import { permissionsForRole } from "@/server/auth/roles";
import type { Policy } from "@/server/policy";
import type { Permission } from "@/server/policy/sections/roles";

/**
 * "Who can do what" on Space settings: each role from policy with its
 * description and the people and groups that hold it in one space. A subject
 * holds the highest-ranked role among its bindings for the space and its
 * global bindings, as effectiveRole() decides at sign-in. Pure; unit-tested.
 */

/** Approving a plan and applying it: what "Require approval from a second person" needs two people for. */
export const APPROVE_AND_APPLY: readonly Permission[] = ["plans.approve", "plans.apply"];

export interface RoleHolder {
  kind: "user" | "group" | "bypass";
  subject: string;
  /** Where the winning binding is set; the bypass user has no binding */
  scope: "space" | "global" | "bypass";
}

export interface RoleSummary {
  name: string;
  description: string;
  canApproveAndApply: boolean;
  holders: RoleHolder[];
}

export interface WhoCanDoWhat {
  roles: RoleSummary[];
  /** People and groups that can approve and apply plans in the space */
  approvers: { people: number; groups: number };
  /** Role names that can approve and apply, lowest rank first */
  approverRoles: string[];
}

interface BindingLike {
  spaceId: string | null;
  subjectType: "user" | "group";
  subject: string;
  role: string;
}

function canApproveAndApply(policy: Pick<Policy, "roles">, role: string): boolean {
  const perms = permissionsForRole(policy, role);
  return APPROVE_AND_APPLY.every((p) => perms.has(p));
}

/**
 * With `bypass` (the local sign-in bypass), the bypass user is the only
 * person who can sign in, so only they count as an approver; the bindings
 * are still listed because they apply once people sign in through the IdP.
 */
export function whoCanDoWhat(
  policy: Pick<Policy, "roles">,
  bindings: readonly BindingLike[],
  spaceId: string,
  bypass: { email: string; role: string } | null,
): WhoCanDoWhat {
  const rank = (role: string) => policy.roles.roles[role]?.rank ?? -1;
  const best = new Map<string, { b: BindingLike; key: string }>();
  for (const b of bindings) {
    if (b.spaceId !== null && b.spaceId !== spaceId) continue;
    if (!policy.roles.roles[b.role]) continue;
    const key = `${b.subjectType}:${b.subjectType === "user" ? b.subject.toLowerCase() : b.subject}`;
    const prev = best.get(key);
    if (!prev || rank(b.role) > rank(prev.b.role) || (rank(b.role) === rank(prev.b.role) && b.spaceId !== null)) best.set(key, { b, key });
  }
  const roles: RoleSummary[] = Object.entries(policy.roles.roles)
    .sort(([, a], [, b]) => a.rank - b.rank)
    .map(([name, r]) => ({ name, description: r.description, canApproveAndApply: canApproveAndApply(policy, name), holders: [] }));
  const byName = new Map(roles.map((r) => [r.name, r]));
  for (const { b } of [...best.values()].sort((x, y) => x.b.subject.localeCompare(y.b.subject))) {
    byName.get(b.role)?.holders.push({ kind: b.subjectType, subject: b.subject, scope: b.spaceId === null ? "global" : "space" });
  }
  if (bypass) byName.get(bypass.role)?.holders.unshift({ kind: "bypass", subject: bypass.email, scope: "bypass" });

  const approving = roles.filter((r) => r.canApproveAndApply);
  const approvers = bypass
    ? { people: approving.some((r) => r.name === bypass.role) ? 1 : 0, groups: 0 }
    : {
        people: approving.reduce((n, r) => n + r.holders.filter((h) => h.kind === "user").length, 0),
        groups: approving.reduce((n, r) => n + r.holders.filter((h) => h.kind === "group").length, 0),
      };
  return { roles, approvers, approverRoles: approving.map((r) => r.name) };
}

/**
 * The warning for "Require approval from a second person", or null. A group
 * may hold several people, so a group that can approve silences it.
 */
export function approvalWarning(approvers: WhoCanDoWhat["approvers"], roleNames: readonly string[], bypass: boolean): { title: string; body: string } | null {
  if (approvers.groups > 0 || approvers.people >= 2) return null;
  const roles = roleNames.map((r) => r.charAt(0).toUpperCase() + r.slice(1));
  const who = roles.length > 1 ? `${roles.slice(0, -1).join(", ")} or ${roles.at(-1)}` : (roles[0] ?? "approver");
  if (bypass) {
    return {
      title: "Fewer than two people can approve and apply plans",
      body: "With the local sign-in bypass, everyone who opens the app is the same person, and nobody can approve their own plan. Plans would wait for approval until people sign in through your sign-in provider.",
    };
  }
  return {
    title: "Fewer than two people can approve and apply plans",
    body:
      approvers.people === 0
        ? `Nobody here has the ${who} role, so no plan could be approved. Give two people one of those roles first.`
        : `Only one person here has the ${who} role, and nobody can approve their own plan, so that person's plans could never be applied. Give a second person one of those roles first.`,
  };
}

/**
 * Who approves and applies plans here, and whether a second person must
 * approve first ("Who can do what" page). Pure.
 */
export function approvalSentence(approverRoles: readonly string[], approvalRequired: boolean): string {
  const words = approverRoles.map((r) => `${r.charAt(0).toUpperCase()}${r.slice(1)}s`);
  const who = words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : (words[0] ?? "No role");
  const can = words.length ? `${who} can approve and apply plans.` : "No role can approve and apply plans.";
  return approvalRequired
    ? `${can} This space requires approval from a second person: someone other than the plan's author approves a plan before anyone can apply it.`
    : `${can} This space doesn't require approval from a second person, so a plan can be applied without a separate approval.`;
}
