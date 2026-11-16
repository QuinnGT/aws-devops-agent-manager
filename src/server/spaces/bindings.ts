import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { recordAuditEvent } from "@/server/audit-log";
import { permissionsForRole } from "@/server/auth/roles";
import type { Actor } from "@/server/aws/clients";
import { db } from "@/server/db/client";
import { agentSpaces, roleBindings } from "@/server/db/schema";
import { getAppPolicy, type Policy } from "@/server/policy";
import { SpaceServiceError } from "./errors";
import type { BindingInput } from "./validators";

/**
 * Role bindings: a user email or IdP group
 * bound to a role from the roles policy, globally (spaceId null) or for one
 * space. Callers check `bindings.manage` for the binding's scope first.
 */

export type BindingRow = typeof roleBindings.$inferSelect;

export interface BindingView extends BindingRow {
  spaceAlias: string | null;
}

/** Roles from policy, highest rank first. */
export function policyRoles(policy: Pick<Policy, "roles"> = getAppPolicy().policy): { name: string; rank: number; description: string }[] {
  return Object.entries(policy.roles.roles)
    .map(([name, r]) => ({ name, rank: r.rank, description: r.description }))
    .sort((a, b) => b.rank - a.rank);
}

/**
 * A grantor may only grant roles ranked at or below their own role in that
 * scope, so bindings.manage can't be used to climb above it.
 */
export function canGrant(policy: Pick<Policy, "roles">, grantorRole: string | null, role: string): boolean {
  const target = policy.roles.roles[role];
  if (!target || !grantorRole) return false;
  const own = policy.roles.roles[grantorRole];
  return own !== undefined && target.rank <= own.rank;
}

/**
 * Why the caller can't remove a binding, or null when they can. Mirrors the
 * checks in removeBinding, so the page can disable the button with a reason.
 */
export function removeBlockReason(
  policy: Pick<Policy, "roles">,
  binding: Pick<BindingRow, "spaceId" | "role">,
  all: readonly Pick<BindingRow, "spaceId" | "role">[],
  grantorRole: string | null,
): string | null {
  if (!canGrant(policy, grantorRole, binding.role)) return "This role is above your own role here.";
  if (binding.spaceId === null && permissionsForRole(policy, binding.role).has("bindings.manage")) {
    const managers = all.filter((b) => b.spaceId === null && permissionsForRole(policy, b.role).has("bindings.manage"));
    if (managers.length <= 1) return "This is the last global binding that can manage bindings. Add another one first.";
  }
  return null;
}

/** Roles the caller may grant in a scope, highest first. */
export function grantableRoles(policy: Pick<Policy, "roles">, grantorRole: string | null): string[] {
  return policyRoles(policy)
    .filter((r) => canGrant(policy, grantorRole, r.name))
    .map((r) => r.name);
}

export async function listBindings(): Promise<BindingView[]> {
  const rows = await db()
    .select({ b: roleBindings, alias: agentSpaces.alias })
    .from(roleBindings)
    .leftJoin(agentSpaces, eq(roleBindings.spaceId, agentSpaces.id))
    .orderBy(asc(agentSpaces.alias), asc(roleBindings.subjectType), asc(roleBindings.subject));
  return rows.map((r) => ({ ...r.b, spaceAlias: r.alias }));
}

export async function getBinding(id: string): Promise<BindingRow | null> {
  const [row] = await db().select().from(roleBindings).where(eq(roleBindings.id, id));
  return row ?? null;
}

function scopeFilter(spaceId: string | null) {
  return spaceId === null ? isNull(roleBindings.spaceId) : eq(roleBindings.spaceId, spaceId);
}

/**
 * Bind a subject to a role in a scope. If the subject already has a binding in
 * that scope, its role is replaced. Serialized with an advisory lock because
 * the unique index does not cover global (null space) bindings.
 */
export async function saveBinding(input: BindingInput, actor: Actor, grantorRole: string | null): Promise<BindingRow> {
  const policy = getAppPolicy().policy;
  if (!policy.roles.roles[input.role]) throw new SpaceServiceError(`Unknown role ${input.role}.`, { role: "Choose a role from the list." });
  if (!canGrant(policy, grantorRole, input.role)) {
    throw new SpaceServiceError(`You can't grant ${input.role}: it is above your own role in this scope.`, { role: "Choose a lower role." });
  }

  let alias: string | null = null;
  if (input.spaceId) {
    const [space] = await db().select({ alias: agentSpaces.alias }).from(agentSpaces).where(eq(agentSpaces.id, input.spaceId));
    if (!space) throw new SpaceServiceError("That space no longer exists.", { spaceId: "Choose another scope." });
    alias = space.alias;
  }

  const { row, previousRole } = await db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('dam.role_bindings'))`);
    const [existing] = await tx
      .select()
      .from(roleBindings)
      .where(and(scopeFilter(input.spaceId), eq(roleBindings.subjectType, input.subjectType), eq(roleBindings.subject, input.subject)));
    if (existing) {
      const [updated] = await tx.update(roleBindings).set({ role: input.role }).where(eq(roleBindings.id, existing.id)).returning();
      return { row: updated!, previousRole: existing.role };
    }
    const [inserted] = await tx
      .insert(roleBindings)
      .values({ spaceId: input.spaceId, subjectType: input.subjectType, subject: input.subject, role: input.role, createdBy: actor.email })
      .returning();
    return { row: inserted!, previousRole: null as string | null };
  });

  if (previousRole !== row.role) {
    await recordAuditEvent({
      actor,
      action: previousRole === null ? "binding.create" : "binding.update",
      spaceId: row.spaceId,
      targetType: "role_binding",
      targetId: row.id,
      details: { scope: alias ?? "global", subjectType: row.subjectType, subject: row.subject, role: row.role, previousRole },
    });
  }
  return row;
}

/**
 * Remove a binding. The last global binding that grants bindings.manage can't
 * be removed, so the app always has someone who can manage bindings.
 */
export async function removeBinding(id: string, actor: Actor, grantorRole: string | null): Promise<void> {
  const policy = getAppPolicy().policy;
  const removed = await db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('dam.role_bindings'))`);
    const [b] = await tx.select().from(roleBindings).where(eq(roleBindings.id, id));
    if (!b) throw new SpaceServiceError("That binding no longer exists.");
    if (!canGrant(policy, grantorRole, b.role)) {
      throw new SpaceServiceError(`You can't remove a ${b.role} binding: it is above your own role in this scope.`);
    }
    if (b.spaceId === null && permissionsForRole(policy, b.role).has("bindings.manage")) {
      const globals = await tx.select().from(roleBindings).where(isNull(roleBindings.spaceId));
      const managers = globals.filter((g) => permissionsForRole(policy, g.role).has("bindings.manage"));
      if (managers.length <= 1) {
        throw new SpaceServiceError("This is the last global binding that can manage bindings. Add another one before removing it.");
      }
    }
    await tx.delete(roleBindings).where(eq(roleBindings.id, id));
    return b;
  });
  let alias: string | null = null;
  if (removed.spaceId) {
    const [space] = await db().select({ alias: agentSpaces.alias }).from(agentSpaces).where(eq(agentSpaces.id, removed.spaceId));
    alias = space?.alias ?? null;
  }
  await recordAuditEvent({
    actor,
    action: "binding.delete",
    spaceId: removed.spaceId,
    targetType: "role_binding",
    targetId: removed.id,
    details: { scope: alias ?? "global", subjectType: removed.subjectType, subject: removed.subject, role: removed.role },
  });
}
