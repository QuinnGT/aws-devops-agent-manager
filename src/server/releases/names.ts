import { safeSegment } from "@/server/history/layout";
import type { ReleasesPolicy } from "@/server/policy/sections/releases";

/**
 * Release name rules. The pattern, length and case rule come from policy;
 * the git ref rules are checked here because every name becomes part of a
 * tag ("{spaceAlias}/{release}") and a file name.
 */

export type NameCheck = { ok: true } | { ok: false; message: string };

export function checkReleaseName(policy: Pick<ReleasesPolicy, "name">, name: string): NameCheck {
  const rule = policy.name;
  if (!name) return { ok: false, message: "Enter a release name." };
  if (name.length > rule.maxLength) return { ok: false, message: `Keep the name to ${rule.maxLength} characters or fewer.` };
  if (!new RegExp(rule.pattern).test(name)) return { ok: false, message: rule.hint };
  // git check-ref-format rules that a policy pattern could let through
  if (name.includes("..") || name.includes("@{") || name.endsWith(".lock") || name.endsWith(".") || name.startsWith(".")) {
    return { ok: false, message: "A release name can't contain .., @{, start or end with a dot, or end with .lock." };
  }
  if (/[\s~^:?*[\\/\x00-\x1f\x7f]/.test(name)) {
    return { ok: false, message: "A release name can't contain spaces, slashes or any of ~ ^ : ? * [ \\." };
  }
  // The tag and manifest path use safeSegment(name); it must be the name itself.
  if (safeSegment(name) !== name) return { ok: false, message: rule.hint };
  return { ok: true };
}

/** True when `name` matches one of `existing` under the policy's case rule. Also used for tag names. */
export function isDuplicateName(policy: Pick<ReleasesPolicy, "name">, name: string, existing: Iterable<string>): boolean {
  const norm = (s: string) => (policy.name.uniqueIgnoringCase ? s.toLowerCase() : s);
  const n = norm(name);
  for (const e of existing) if (norm(e) === n) return true;
  return false;
}
