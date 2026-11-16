import type { Permission } from "@/server/policy/sections/roles";

/** What the (app) layout passes to the client shell. */

/** Cookie with the last space the user opened, so app-wide pages keep the space navigation. */
export const LAST_SPACE_COOKIE = "dam_space";

export interface ShellSpace {
  alias: string;
  name: string;
  region: string;
  /** The space's optional environment setting ("Test", "Production") */
  environment: string | null;
  /** agent_spaces.connection_status: ok | failed | rejected | unknown */
  connection: string;
  /** The user's role in this space, or null */
  role: string | null;
  /** The nav read permissions the user has in this space */
  permissions: Permission[];
}

export interface ShellUser {
  name: string;
  email: string;
  devBypass: boolean;
  globalRole: string | null;
}

export interface ShellFlags {
  auditLog: boolean;
  appSettings: boolean;
  registerSpace: boolean;
}

export function initials(name: string): string {
  const words = name.trim().split(/[\s._@-]+/).filter(Boolean);
  const letters = words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

export function roleLabel(role: string | null): string {
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : "No role";
}

/** "Test · us-west-2", or only the Region when the environment is unset. */
export function spaceSubtitle(s: Pick<ShellSpace, "environment" | "region">): string {
  return s.environment ? `${s.environment} · ${s.region}` : s.region;
}

export const CONNECTION_WORDS: Record<string, { text: string; dot: string }> = {
  ok: { text: "Connected", dot: "bg-success" },
  failed: { text: "Connection failed", dot: "bg-destructive" },
  rejected: { text: "Connection failed", dot: "bg-destructive" },
  unknown: { text: "Connection not tested", dot: "bg-muted-foreground" },
};

export function safeDecode(v: string | undefined): string | null {
  if (!v) return null;
  try {
    return decodeURIComponent(v);
  } catch {
    return null;
  }
}
