import { fillTemplate, safeSegment } from "@/server/history/layout";
import type { Policy } from "@/server/policy";
import { checkReleaseName, isDuplicateName } from "@/server/releases/names";

/**
 * Revision name rules and the names derived from a revision name: the
 * branch, the package folder and the release tagged after apply. Pure.
 */

export type NameCheck = { ok: true } | { ok: false; message: string };

type NamePolicy = Pick<Policy, "revisions" | "releases">;

/** A revision name must be path-safe and pass the policy pattern, git's ref rules, and the release name rules. */
export function checkRevisionName(policy: NamePolicy, name: string, spaceAlias: string): NameCheck {
  const rule = policy.revisions.name;
  if (!name) return { ok: false, message: "Enter a revision name." };
  if (name.length > rule.maxLength) return { ok: false, message: `Keep the name to ${rule.maxLength} characters or fewer.` };
  if (!new RegExp(rule.pattern).test(name)) return { ok: false, message: rule.hint };
  if (name.includes("..") || name.includes("@{") || name.endsWith(".lock") || name.endsWith(".") || name.startsWith(".")) {
    return { ok: false, message: "A revision name can't contain .., @{, start or end with a dot, or end with .lock." };
  }
  if (/[\s~^:?*[\\/\x00-\x1f\x7f]/.test(name)) {
    return { ok: false, message: "A revision name can't contain spaces, slashes or any of ~ ^ : ? * [ \\." };
  }
  // The branch and the package folder use the name as one path segment.
  if (safeSegment(name) !== name) return { ok: false, message: rule.hint };
  const release = releaseNameFor(policy, name, spaceAlias);
  const releaseCheck = checkReleaseName(policy.releases, release);
  if (!releaseCheck.ok) return { ok: false, message: `Applying a revision tags a release named ${release}, and that name doesn't work: ${releaseCheck.message}` };
  return { ok: true };
}

/** The key that makes names unique per space (lowercase when names are unique ignoring case). */
export function revisionNameKey(policy: Pick<Policy, "revisions">, name: string): string {
  return policy.revisions.name.uniqueIgnoringCase ? name.toLowerCase() : name;
}

export function isDuplicateRevisionName(policy: Pick<Policy, "revisions">, name: string, existing: Iterable<string>): boolean {
  const key = revisionNameKey(policy, name);
  for (const e of existing) if (revisionNameKey(policy, e) === key) return true;
  return false;
}

/** The branch of a revision (history-layout.yaml revisionBranch). */
export function revisionBranch(policy: Pick<Policy, "historyLayout">, spaceAlias: string, name: string): string {
  return fillTemplate(policy.historyLayout.revisionBranch, { spaceAlias: safeSegment(spaceAlias), name: safeSegment(name) });
}

/** The package name (folder and zip top folder) of a revision (revisions.yaml packageName). */
export function revisionPackageName(policy: Pick<Policy, "revisions">, spaceAlias: string, name: string): string {
  return safeSegment(fillTemplate(policy.revisions.packageName, { name, spaceAlias }));
}

/** The package folder on the branch (history-layout.yaml packageDir). */
export function revisionPackageDir(policy: Pick<Policy, "historyLayout">, spaceAlias: string, packageName: string): string {
  return fillTemplate(policy.historyLayout.packageDir, { spaceAlias: safeSegment(spaceAlias), package: safeSegment(packageName) });
}

/** The release tagged after the revision's plan is applied (revisions.yaml release.name). */
export function releaseNameFor(policy: Pick<Policy, "revisions">, name: string, spaceAlias: string): string {
  return fillTemplate(policy.revisions.release.name, { name, spaceAlias });
}

/** True when a release name is already taken (by a release row or a tag), under the release case rule. */
export function releaseNameTaken(policy: Pick<Policy, "releases">, release: string, existing: { names: Iterable<string>; tags: Iterable<string>; tag: string }): boolean {
  return isDuplicateName(policy.releases, release, existing.names) || isDuplicateName(policy.releases, existing.tag, existing.tags);
}
