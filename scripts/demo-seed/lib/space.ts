import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { agentSpaces, historyRepos } from "@/server/db/schema";
import { HistoryRepo, type FileChange } from "@/server/git/history-repo";
import { getSpaceById, toHistoryRepoConfig, type Space } from "@/server/spaces/queries";
import { updateSpaceSettings } from "@/server/spaces/service";
import { ACCOUNT_ID, AGENT_SPACE_ID, ALIAS, DISPLAY_NAME, minutesAgo, NO_AWS_PROFILE, REGION, type SeedPerson } from "./common";

export interface DemoSpaceOptions {
  alias?: string;
  displayName?: string;
  /** History repository name; its working copy is created under DAM_DATA_DIR/history */
  repoName: string;
  agentSpaceId?: string;
  awsProfile?: string | null;
  environment?: string;
  /** Space default review model, set through Space settings (recorded in the audit log) */
  reviewModelId?: string | null;
  /** A folder of policy files (for example sample-data/policy), committed as the history repository's policy/ directory */
  policyOverlayDir?: string;
  /** Who sets the settings and commits the overlay */
  actor: SeedPerson;
}

/** Every file under `dir`, as a path relative to it with forward slashes. */
function filesUnder(dir: string, rel = ""): string[] {
  return readdirSync(path.join(dir, rel)).flatMap((name) => {
    const r = rel ? `${rel}/${name}` : name;
    return statSync(path.join(dir, r)).isDirectory() ? filesUnder(dir, r) : [r];
  });
}

/**
 * Commit a policy overlay into the history repository's policy/ directory, as
 * a person would to give the space its own layouts and rules. The app reads it
 * back through getPolicyForRepo (src/server/policy/loader.ts), merged over its
 * own policy/.
 */
export async function commitPolicyOverlay(repo: HistoryRepo, overlayDir: string, actor: SeedPerson): Promise<string | null> {
  const changes: FileChange[] = filesUnder(overlayDir)
    .sort()
    .map((rel) => ({ path: `policy/${rel}`, content: readFileSync(path.join(overlayDir, rel)) }));
  const who = { name: actor.name, email: actor.email };
  return repo.writeAndCommit(changes, { message: "Add the policy overlay for this space", author: who, committer: who, date: minutesAgo(60 * 24 * 8) });
}

/** Create a space with a local history repository. The caller has reset the database or removed an older space with this alias. */
export async function createDemoSpace(o: DemoSpaceOptions): Promise<Space> {
  const [repoRow] = await db().insert(historyRepos).values({ name: o.repoName }).returning();
  const repo = await HistoryRepo.open(toHistoryRepoConfig(repoRow!));
  if (o.policyOverlayDir) await commitPolicyOverlay(repo, o.policyOverlayDir, o.actor);
  const [row] = await db()
    .insert(agentSpaces)
    .values({
      alias: o.alias ?? ALIAS,
      displayName: o.displayName ?? DISPLAY_NAME,
      region: REGION,
      accountId: ACCOUNT_ID,
      agentSpaceId: o.agentSpaceId ?? AGENT_SPACE_ID,
      historyRepoId: repoRow!.id,
      awsProfile: o.awsProfile ?? null,
    })
    .returning();
  const space = (await getSpaceById(row!.id))!;
  const settings = space.parsedSettings;
  await updateSpaceSettings(
    space.id,
    { ...settings, environment: o.environment ?? "Test", inference: { ...settings.inference, reviewModelId: o.reviewModelId ?? settings.inference.reviewModelId } },
    { email: o.actor.email },
  );
  return (await getSpaceById(space.id))!;
}

/** Delete a space by alias and its history repository row (for seeds that rebuild one space without emptying the database). */
export async function deleteSpaceByAlias(alias: string, repoName: string): Promise<void> {
  const [old] = await db().select().from(agentSpaces).where(eq(agentSpaces.alias, alias));
  if (old) {
    await db().delete(agentSpaces).where(eq(agentSpaces.id, old.id));
    if (old.historyRepoId) await db().delete(historyRepos).where(eq(historyRepos.id, old.historyRepoId)).catch(() => {});
  }
  await db().delete(historyRepos).where(eq(historyRepos.name, repoName)).catch(() => {});
}

/**
 * The demo space when the database has it, else a new one made like all.ts
 * makes it (history repository with the sample overlay, review model in
 * settings). For the per-screen seeds, which add to a space without emptying
 * the database.
 */
export async function ensureDemoSpace(o: Pick<DemoSpaceOptions, "repoName" | "policyOverlayDir" | "actor"> & { alias?: string; reviewModelId?: string | null }): Promise<Space> {
  const [found] = await db().select({ id: agentSpaces.id }).from(agentSpaces).where(eq(agentSpaces.alias, o.alias ?? ALIAS));
  if (found) return (await getSpaceById(found.id))!;
  return createDemoSpace({ ...o, awsProfile: NO_AWS_PROFILE });
}
