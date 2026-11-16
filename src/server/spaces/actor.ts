import type { Actor } from "@/server/aws/clients";

/** The acting user for service functions and the audit log. Comes from the session, never from request input. */
export function actorOf(user: { email: string; name?: string | null }): Actor & { name: string | null } {
  return { email: user.email, name: user.name ?? null };
}
