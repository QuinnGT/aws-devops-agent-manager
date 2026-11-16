import { existsSync } from "node:fs";
import { HistoryRepo } from "@/server/git/history-repo";
import { getAppPolicy, getPolicyForRepo, type LoadedPolicy } from "@/server/policy";
import { getHistoryRepoForSpace, type SpaceRow } from "@/server/spaces/queries";

/** Policy for a space: app defaults, overlaid with its history repository's policy/ when a working copy exists. */
export async function policyForSpace(space: SpaceRow): Promise<LoadedPolicy> {
  const repo = await getHistoryRepoForSpace(space);
  if (!repo) return getAppPolicy();
  const dir = HistoryRepo.workingDirFor(repo);
  return existsSync(dir) ? getPolicyForRepo(dir) : getAppPolicy();
}
