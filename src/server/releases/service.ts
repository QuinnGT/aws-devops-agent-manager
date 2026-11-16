import { openSpaceHistoryRepo } from "@/server/assets/repo";
import type { Permission } from "@/server/policy";
import { getAppPolicy, getPolicyForRepo } from "@/server/policy";
import { releaseTagName } from "@/server/history/layout";
import { getSpaceById } from "@/server/spaces/queries";
import { checkReleaseName, isDuplicateName, type NameCheck } from "./names";
import { releaseNames } from "./queries";

/**
 * Service functions for the release Server Actions. Actions check
 * the permission below with the DAL, parse the form, then call:
 *
 * - requestCreateRelease(request, actor)       from ./jobs      (releases.create)
 * - createRollbackPlan(request, actor, deps?)  from ./rollback  (plans.create; apply needs rollbacks.apply)
 * - checkReleaseNameForSpace(spaceId, name)    here             (releases.create), for inline form validation
 */

export const RELEASE_PERMISSIONS = {
  /** Release list, detail, compare and the rollback preview */
  read: "history.read",
  create: "releases.create",
  /** Creating a rollback plan is creating a plan */
  planRollback: "plans.create",
  /** Applying a rollback plan: applyPermissionFor({ kind: "rollback", ... }) */
  applyRollback: "rollbacks.apply",
} as const satisfies Record<string, Permission>;

/** Check a release name against policy and the space's existing releases and tags. */
export async function checkReleaseNameForSpace(spaceId: string, name: string): Promise<NameCheck> {
  const space = await getSpaceById(spaceId);
  if (!space) return { ok: false, message: "Space not found." };
  const opened = await openSpaceHistoryRepo(space);
  const policy = opened.ok ? getPolicyForRepo(opened.repo.dir).policy : getAppPolicy().policy;
  const trimmed = name.trim();
  const check = checkReleaseName(policy.releases, trimmed);
  if (!check.ok) return check;
  const tag = releaseTagName(policy.historyLayout, space.alias, trimmed);
  const tags = opened.ok ? await opened.repo.tags() : [];
  if (isDuplicateName(policy.releases, trimmed, await releaseNames(space.id)) || isDuplicateName(policy.releases, tag, tags)) {
    return { ok: false, message: `A release named ${trimmed} already exists in this space.` };
  }
  return { ok: true };
}
