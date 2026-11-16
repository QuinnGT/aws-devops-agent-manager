import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { exportBlocker, planBlocker, saveBlocker, type RevisionStateView } from "./states";
import type { RevisionBuild } from "./types";

const policy = getAppPolicy().policy.revisions;
const build = (status: RevisionBuild["status"], commit = "c2", errors = 0): RevisionBuild => ({ status, commit, ranAt: "", errors, warnings: 0, results: [], omitted: 0, validation: null, buildPaths: [], assets: 0 });
const open = (latestBuild: RevisionBuild | null, over: Partial<RevisionStateView> = {}): RevisionStateView => ({ state: "open", stateReason: null, headCommit: "c2", latestBuild, releaseName: null, ...over });

describe("why an action is unavailable", () => {
  it("allows a plan only when the build passed at the head and no plan is open or applied", () => {
    expect(planBlocker(open(build("passed")), null)).toBeNull();
    expect(planBlocker(open(build("passed")), { state: "discarded", title: "Apply revision v2.4" })).toBeNull();
    expect(planBlocker(open(build("failed", "c2", 3)), null)).toBe("The build and validation failed with 3 errors. Fix them and save again.");
    expect(planBlocker(open(build("failed", "c2", 1)), null)).toBe("The build and validation failed with 1 error. Fix it and save again.");
    expect(planBlocker(open(build("passed", "c1")), null)).toBe("The build of the latest save hasn't finished.");
    expect(planBlocker(open(build("passed")), { state: "ready", title: "Apply revision v2.4" })).toBe('The plan "Apply revision v2.4" from this revision is still open. Apply or discard it first.');
    expect(planBlocker(open(build("passed"), { state: "applied", releaseName: "v2.4" }), null)).toBe("A plan from this revision was already applied and tagged as release v2.4. Start a new revision for further changes.");
    expect(planBlocker(open(null, { state: "abandoned" }), null)).toBe("The revision was abandoned.");
    expect(planBlocker(open(null, { state: "failed", stateReason: "the sync failed" }), null)).toBe("The revision could not be created: the sync failed");
  });

  it("blocks the download until the build passes, unless policy allows it", () => {
    expect(exportBlocker(open(build("passed")), policy)).toBeNull();
    expect(exportBlocker(open(build("failed", "c2", 2)), policy)).toBe("The package can't be downloaded yet. The build and validation failed with 2 errors. Fix them and save again.");
    expect(exportBlocker(open(build("failed")), { export: { requirePassingBuild: false } })).toBeNull();
    expect(exportBlocker(open(null, { state: "creating", headCommit: null }), policy)).toBe("The revision is still being created.");
  });

  it("allows saves only while the revision is open", () => {
    expect(saveBlocker(open(null))).toBeNull();
    expect(saveBlocker(open(null, { state: "applied" }))).toMatch(/already applied/);
    expect(saveBlocker(open(null, { state: "abandoned" }))).toBe("The revision was abandoned.");
  });
});
