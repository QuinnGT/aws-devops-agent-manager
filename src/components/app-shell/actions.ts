"use server";

import { z } from "zod";
import { AuthError, permissionsIn, requirePermission, requireUser, type AppUser } from "@/server/auth/dal";
import { listIndexedAssets } from "@/server/assets/queries";
import { assetLabel } from "@/server/history/display-name";
import { getAppPolicy } from "@/server/policy";
import { actorOf } from "@/server/spaces/actor";
import { getSpaceByAlias } from "@/server/spaces/queries";
import { requestSpaceSync } from "@/server/spaces/service";
import { commandPagesFor, type CommandPageLink } from "./command-pages";
import { spaceBase } from "./nav";

/**
 * Server Actions for the shell: thin wrappers that check the permission for
 * the space named by alias, then call the module's service function.
 */

const aliasSchema = z.string().min(1).max(100);

export type ShellActionResult = { ok: true; message: string; runId?: string } | { ok: false; message: string };

const NO_ACCESS = "You don't have permission to do this in this space.";

/** "Sync now" in the top bar and in Home callouts. */
export async function syncNowAction(alias: string): Promise<ShellActionResult> {
  const parsed = aliasSchema.safeParse(alias);
  const space = parsed.success ? await getSpaceByAlias(parsed.data) : null;
  // A missing space and a missing permission read the same, so the action doesn't reveal which spaces exist.
  if (!space) return { ok: false, message: NO_ACCESS };
  try {
    const user = await requirePermission("sync.run", space.id);
    const runId = await requestSpaceSync(space.id, actorOf(user));
    return { ok: true, message: "Sync requested", runId };
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, message: err.status === 401 ? "Sign in again to continue." : NO_ACCESS };
    return { ok: false, message: err instanceof Error ? `Could not request a sync: ${err.message}` : "Could not request a sync." };
  }
}

export interface CommandAsset {
  assetId: string;
  /** Display name ("Global instructions") */
  name: string;
  /** The stored name and other words it should match ("GENERIC") */
  keywords: string[];
  assetType: string;
}

export interface CommandIndex {
  pages: CommandPageLink[];
  assets: CommandAsset[];
  types: { assetType: string; label: string; count: number }[];
}

const EMPTY: CommandIndex = { pages: [], assets: [], types: [] };

/** Pages and actions the user may open, plus asset names and types of one space, for the command search. */
export async function commandIndexAction(alias: string): Promise<CommandIndex> {
  const parsed = aliasSchema.safeParse(alias);
  const space = parsed.success ? await getSpaceByAlias(parsed.data) : null;
  if (!space) return EMPTY;
  let user: AppUser;
  try {
    user = await requirePermission("assets.read", space.id);
  } catch (err) {
    if (err instanceof AuthError) return EMPTY;
    throw err;
  }
  const [rows, perms, globalPerms] = await Promise.all([listIndexedAssets(space.id), permissionsIn(user, space.id), permissionsIn(user, null)]);
  const policy = getAppPolicy().policy;
  const policyTypes = policy.assetTypes.assetTypes;
  const pages = commandPagesFor(spaceBase(space.alias), {
    space: perms,
    auditLog: perms.has("auditlog.read") || globalPerms.has("auditlog.read"),
    appSettings: perms.has("bindings.manage") || globalPerms.has("spaces.manage") || globalPerms.has("bindings.manage"),
  });
  const order = Object.keys(policyTypes);
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.assetType, (counts.get(r.assetType) ?? 0) + 1);
  const rank = (t: string) => (order.indexOf(t) < 0 ? order.length : order.indexOf(t));
  const types = [...counts.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([assetType, count]) => ({ assetType, label: policyTypes[assetType]?.label ?? assetType, count }));
  return {
    pages,
    assets: rows.map((r) => {
      const name = assetLabel(policy, r);
      return { assetId: r.assetId, name, keywords: name === r.name ? [] : [r.name], assetType: r.assetType };
    }),
    types,
  };
}

/** What each role can do (policy/roles.yaml descriptions), for the account menu. */
export async function roleDescriptionsAction(): Promise<Record<string, string>> {
  try {
    await requireUser();
  } catch (err) {
    if (err instanceof AuthError) return {};
    throw err;
  }
  return Object.fromEntries(Object.entries(getAppPolicy().policy.roles.roles).map(([name, r]) => [name, r.description]));
}
