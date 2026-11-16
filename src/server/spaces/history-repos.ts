import { asc, eq } from "drizzle-orm";
import { recordAuditEvent } from "@/server/audit-log";
import type { Actor } from "@/server/aws/clients";
import { type Db, db } from "@/server/db/client";
import { agentSpaces, historyRepos } from "@/server/db/schema";
import { SpaceServiceError, uniqueViolation } from "./errors";
import type { HistoryRepoRow } from "./queries";
import type { HistoryRepoFields } from "./validators";

/**
 * History repositories: the remote URL, the deploy key file and the repository
 * each space writes to live in Postgres and are set through the settings UI.
 * Only a path to the deploy key is stored.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function listHistoryRepos(): Promise<HistoryRepoRow[]> {
  return db().select().from(historyRepos).orderBy(asc(historyRepos.name));
}

export async function getHistoryRepo(id: string): Promise<HistoryRepoRow | null> {
  const [row] = await db().select().from(historyRepos).where(eq(historyRepos.id, id));
  return row ?? null;
}

function duplicateName(err: unknown, name: string): never {
  if (uniqueViolation(err) !== null) {
    throw new SpaceServiceError(`A history repository named ${name} already exists.`, { name: "This name is taken." });
  }
  throw err;
}

/** Insert a repository row. Pass a transaction to create it together with a space. */
export async function insertHistoryRepo(fields: HistoryRepoFields, tx: Tx | Db = db()): Promise<HistoryRepoRow> {
  try {
    const [row] = await tx
      .insert(historyRepos)
      .values({
        name: fields.name,
        remoteUrl: fields.remoteUrl,
        deployKeyFile: fields.deployKeyFile,
        defaultBranch: fields.defaultBranch,
        pushEnabled: fields.pushEnabled,
      })
      .returning();
    return row!;
  } catch (err) {
    duplicateName(err, fields.name);
  }
}

function auditView(r: Pick<HistoryRepoRow, "name" | "remoteUrl" | "deployKeyFile" | "defaultBranch" | "pushEnabled">) {
  return { name: r.name, remoteUrl: r.remoteUrl, deployKeyFile: r.deployKeyFile, defaultBranch: r.defaultBranch, pushEnabled: r.pushEnabled };
}

/** Aliases of the spaces that write to each repository, by repository ID. */
export async function spacesByHistoryRepo(): Promise<Map<string, string[]>> {
  const rows = await db().select({ alias: agentSpaces.alias, repoId: agentSpaces.historyRepoId }).from(agentSpaces).orderBy(asc(agentSpaces.alias));
  const out = new Map<string, string[]>();
  for (const r of rows) if (r.repoId) out.set(r.repoId, [...(out.get(r.repoId) ?? []), r.alias]);
  return out;
}

export async function createHistoryRepo(fields: HistoryRepoFields, actor: Actor): Promise<HistoryRepoRow> {
  const row = await insertHistoryRepo(fields);
  await recordAuditEvent({
    actor,
    action: "history-repo.create",
    targetType: "history_repo",
    targetId: row.id,
    details: auditView(row),
  });
  return row;
}

export async function updateHistoryRepo(id: string, fields: HistoryRepoFields, actor: Actor): Promise<HistoryRepoRow> {
  const before = await getHistoryRepo(id);
  if (!before) throw new SpaceServiceError("That history repository no longer exists.");
  const renamed = fields.name !== before.name;
  const branchChanged = fields.defaultBranch !== before.defaultBranch;
  if (renamed || branchChanged) {
    // The working copy folder is derived from the name (HistoryRepo.workingDirFor), and the working
    // copy is created on the configured branch, so a rename or a branch change would strand unpushed
    // history. Allow them only while no space writes to the repository.
    const [user] = await db().select({ alias: agentSpaces.alias }).from(agentSpaces).where(eq(agentSpaces.historyRepoId, id)).limit(1);
    if (user) {
      const what = renamed ? "renamed" : "moved to another branch";
      throw new SpaceServiceError(`Space ${user.alias} writes to this repository, so it can't be ${what}.`, {
        ...(renamed ? { name: "Rename is allowed only while no space uses the repository." } : {}),
        ...(branchChanged ? { defaultBranch: "The branch can change only while no space uses the repository." } : {}),
      });
    }
  }
  let row: HistoryRepoRow | undefined;
  try {
    [row] = await db()
      .update(historyRepos)
      .set({
        name: fields.name,
        remoteUrl: fields.remoteUrl,
        deployKeyFile: fields.deployKeyFile,
        defaultBranch: fields.defaultBranch,
        pushEnabled: fields.pushEnabled,
      })
      .where(eq(historyRepos.id, id))
      .returning();
  } catch (err) {
    duplicateName(err, fields.name);
  }
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  const b = auditView(before);
  const a = auditView(row!);
  for (const k of Object.keys(a) as (keyof typeof a)[]) if (a[k] !== b[k]) changed[k] = { from: b[k], to: a[k] };
  await recordAuditEvent({
    actor,
    action: "history-repo.update",
    targetType: "history_repo",
    targetId: id,
    details: { name: row!.name, changed },
  });
  return row!;
}
