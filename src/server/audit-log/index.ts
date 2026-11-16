import { db } from "@/server/db/client";
import { auditEvents } from "@/server/db/schema";

/**
 * Append-only audit log. Record sign-ins, plans,
 * approvals, applies, rollbacks, exports, imports and settings changes.
 * Action names are `<area>.<verb>`, e.g. "space.register", "journal.export".
 */
export interface AuditEventInput {
  actor: { email: string; name?: string | null };
  action: string;
  spaceId?: string | null;
  targetType?: string;
  targetId?: string;
  result?: "ok" | "error" | "denied";
  details?: Record<string, unknown>;
}

export async function recordAuditEvent(e: AuditEventInput): Promise<void> {
  await db()
    .insert(auditEvents)
    .values({
      actorEmail: e.actor.email,
      actorName: e.actor.name ?? null,
      action: e.action,
      spaceId: e.spaceId ?? null,
      targetType: e.targetType ?? null,
      targetId: e.targetId ?? null,
      result: e.result ?? "ok",
      details: e.details ?? null,
    });
}
