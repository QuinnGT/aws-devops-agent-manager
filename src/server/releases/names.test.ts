import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { releasesSection } from "@/server/policy/sections/releases";
import { checkReleaseName, isDuplicateName } from "./names";

const policy = getAppPolicy().policy;

describe("release name rules", () => {
  it("accepts names like v2.3 and dated names", () => {
    for (const name of ["v2.3", "v2.3.1", "2026-11-release", "rc_1", "V2", "a"]) expect(checkReleaseName(policy.releases, name)).toEqual({ ok: true });
  });

  it("rejects names that can't be a git tag or a file name", () => {
    const bad = ["", " v2", "v2 ", "-v2", "v2-", ".v2", "v2.", "v..2", "v2.lock", "a/b", "a\\b", "v2:1", "v2~1", "v2^", "v2?", "v2*", "v[2]", "v@{2}", "ü2", "x".repeat(65)];
    for (const name of bad) expect(checkReleaseName(policy.releases, name), name).toMatchObject({ ok: false });
    expect(checkReleaseName(policy.releases, "x".repeat(65))).toEqual({ ok: false, message: "Keep the name to 64 characters or fewer." });
    expect(checkReleaseName(policy.releases, "a/b")).toEqual({ ok: false, message: policy.releases.name.hint });
  });

  it("applies the git ref rules even when policy allows more", () => {
    const loose = releasesSection.schema.parse({ name: { pattern: ".*" } });
    expect(checkReleaseName(loose, "v2.3")).toEqual({ ok: true });
    for (const name of ["a..b", "x.lock", "a b", "a/b", "@{x}", "trailing."]) expect(checkReleaseName(loose, name), name).toMatchObject({ ok: false });
  });

  it("treats names that differ only in case as duplicates unless policy says otherwise", () => {
    expect(isDuplicateName(policy.releases, "V2.3", ["v2.2", "v2.3"])).toBe(true);
    expect(isDuplicateName(policy.releases, "v2.4", ["v2.2", "v2.3"])).toBe(false);
    const exact = releasesSection.schema.parse({ name: { uniqueIgnoringCase: false } });
    expect(isDuplicateName(exact, "V2.3", ["v2.3"])).toBe(false);
    expect(isDuplicateName(exact, "v2.3", ["v2.3"])).toBe(true);
  });
});

describe("releases policy section", () => {
  it("loads policy/releases.yaml with the documented defaults", () => {
    expect(policy.releases.rollback.addedAfterTarget).toEqual({ skill: "deactivate", default: "keep" });
    expect(policy.releases.rollback.managed).toBe("skip");
    expect(policy.releases.rollback.inactiveValue).toBe("INACTIVE");
    expect(releasesSection.schema.parse({})).toEqual(policy.releases);
  });

  it("rejects a pattern that is not a regular expression and an unknown rollback action", () => {
    expect(releasesSection.schema.safeParse({ name: { pattern: "(" } }).success).toBe(false);
    expect(releasesSection.schema.safeParse({ rollback: { addedAfterTarget: { skill: "archive" } } }).success).toBe(false);
  });
});
