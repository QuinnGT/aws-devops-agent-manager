import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { checkRevisionName, isDuplicateRevisionName, releaseNameFor, releaseNameTaken, revisionBranch, revisionNameKey, revisionPackageDir, revisionPackageName } from "./names";

const policy = getAppPolicy().policy;

describe("revision names", () => {
  it("accepts path-safe names that also work as release names", () => {
    for (const n of ["v2.4", "v2.4.1", "nov-audit_fixes", "A1"]) expect(checkRevisionName(policy, n, "anycompany")).toEqual({ ok: true });
  });

  it("refuses names git, a folder or the release tag can't take", () => {
    const bad = ["", "a..b", "v2.4.lock", ".hidden", "trailing.", "has space", "a/b", "a\\b", "é-accent", "-start", "x".repeat(65), "a~b", "a:b", "a@{1}"];
    for (const n of bad) expect(checkRevisionName(policy, n, "anycompany").ok, n).toBe(false);
    expect(checkRevisionName(policy, "", "anycompany")).toEqual({ ok: false, message: "Enter a revision name." });
    expect(checkRevisionName(policy, "x".repeat(65), "anycompany")).toEqual({ ok: false, message: "Keep the name to 64 characters or fewer." });
  });

  it("checks the release name the revision will tag", () => {
    const strict = { ...policy, releases: { ...policy.releases, name: { ...policy.releases.name, pattern: "^v\\d+(\\.\\d+)*$", hint: "Use v and numbers." } } };
    const r = checkRevisionName(strict, "nov-fixes", "anycompany");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe("Applying a revision tags a release named nov-fixes, and that name doesn't work: Use v and numbers.");
    expect(checkRevisionName(strict, "v2.4", "anycompany").ok).toBe(true);
  });

  it("treats names that differ only in case as the same name by default", () => {
    expect(revisionNameKey(policy, "V2.4")).toBe("v2.4");
    expect(isDuplicateRevisionName(policy, "V2.4", ["v2.3", "v2.4"])).toBe(true);
    const caseSensitive = { ...policy, revisions: { ...policy.revisions, name: { ...policy.revisions.name, uniqueIgnoringCase: false } } };
    expect(isDuplicateRevisionName(caseSensitive, "V2.4", ["v2.4"])).toBe(false);
  });

  it("derives the branch, package folder and release from the layout templates", () => {
    expect(revisionBranch(policy, "anycompany", "v2.4")).toBe("revision/anycompany/v2.4");
    const pkg = revisionPackageName(policy, "anycompany", "v2.4");
    expect(pkg).toBe("v2.4");
    expect(revisionPackageDir(policy, "anycompany", pkg)).toBe("packages/anycompany/v2.4");
    expect(releaseNameFor(policy, "v2.4", "anycompany")).toBe("v2.4");
    expect(releaseNameTaken(policy, "V2.4", { names: ["v2.4"], tags: [], tag: "anycompany/V2.4" })).toBe(true);
    expect(releaseNameTaken(policy, "v2.5", { names: ["v2.4"], tags: ["anycompany/v2.5"], tag: "anycompany/v2.5" })).toBe(true);
    expect(releaseNameTaken(policy, "v2.6", { names: ["v2.4"], tags: ["anycompany/v2.5"], tag: "anycompany/v2.6" })).toBe(false);
  });
});
