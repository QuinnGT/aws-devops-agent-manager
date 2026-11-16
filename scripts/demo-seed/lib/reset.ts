import { rm } from "node:fs/promises";
import { env } from "@/server/env";
import { HistoryRepo } from "@/server/git/history-repo";
import { boss } from "@/server/jobs/boss";
import { truncateAll } from "../../../test/helpers/db";

/**
 * Resetting for the demo seeds. A seed empties only the database DATABASE_URL
 * names, and only after checking it is a disposable one: the name starts
 * with "dam_" and is not "dam", the main dev database.
 */

export function databaseName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ""));
  } catch {
    return "";
  }
}

/** Throws unless DATABASE_URL names a disposable database. */
export function assertDisposableDatabase(): string {
  const name = databaseName(env().databaseUrl());
  if (!name.startsWith("dam_") || name === "dam") {
    throw new Error(`Refusing to reset database "${name || "(none)"}": the demo seed only empties a database whose name starts with "dam_" (not "dam", the main dev database).`);
  }
  return name;
}

/** Empty every app table and every pg-boss job of the database DATABASE_URL names (after the name check). */
export async function resetDatabase(): Promise<string> {
  const name = assertDisposableDatabase();
  await truncateAll();
  // Jobs a previous run left in pg-boss would otherwise run in the next worker.
  await (await boss()).deleteAllJobs();
  return name;
}

/** Remove the working copy of one history repository under DAM_DATA_DIR/history, and nothing else. */
export async function resetHistoryDir(repoName: string): Promise<string> {
  const dir = HistoryRepo.workingDirFor({ name: repoName });
  await rm(dir, { recursive: true, force: true });
  return dir;
}
