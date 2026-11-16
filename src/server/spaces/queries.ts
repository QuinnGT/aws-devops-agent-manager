import { asc, eq } from "drizzle-orm";
import type { SpaceAwsConfig } from "@/server/aws/clients";
import { db } from "@/server/db/client";
import { agentSpaces, historyRepos } from "@/server/db/schema";
import type { HistoryRepoConfig } from "@/server/git/history-repo";
import { parseSpaceSettings, type SpaceSettings } from "./settings-schema";

/**
 * Read helpers for registered spaces, used by every module. Callers check permissions first.
 */

export type SpaceRow = typeof agentSpaces.$inferSelect;
export type HistoryRepoRow = typeof historyRepos.$inferSelect;

export interface Space extends SpaceRow {
  parsedSettings: SpaceSettings;
}

function withSettings(row: SpaceRow): Space {
  return { ...row, parsedSettings: parseSpaceSettings(row.settings) };
}

export async function listSpaces(): Promise<Space[]> {
  const rows = await db().select().from(agentSpaces).orderBy(asc(agentSpaces.alias));
  return rows.map(withSettings);
}

export async function getSpaceByAlias(alias: string): Promise<Space | null> {
  const [row] = await db().select().from(agentSpaces).where(eq(agentSpaces.alias, alias));
  return row ? withSettings(row) : null;
}

export async function getSpaceById(id: string): Promise<Space | null> {
  const [row] = await db().select().from(agentSpaces).where(eq(agentSpaces.id, id));
  return row ? withSettings(row) : null;
}

export async function getHistoryRepoForSpace(space: SpaceRow): Promise<HistoryRepoRow | null> {
  if (!space.historyRepoId) return null;
  const [row] = await db().select().from(historyRepos).where(eq(historyRepos.id, space.historyRepoId));
  return row ?? null;
}

export function toAwsConfig(space: SpaceRow): SpaceAwsConfig {
  return {
    id: space.id,
    alias: space.alias,
    region: space.region,
    accountId: space.accountId,
    agentSpaceId: space.agentSpaceId,
    readRoleArn: space.readRoleArn,
    writeRoleArn: space.writeRoleArn,
    externalId: space.externalId,
    awsProfile: space.awsProfile,
  };
}

export function toHistoryRepoConfig(row: HistoryRepoRow): HistoryRepoConfig {
  return {
    id: row.id,
    name: row.name,
    remoteUrl: row.remoteUrl,
    deployKeyFile: row.deployKeyFile,
    defaultBranch: row.defaultBranch,
    pushEnabled: row.pushEnabled,
  };
}
