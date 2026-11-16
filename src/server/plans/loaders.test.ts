import { describe, expect, it } from "vitest";
import { permissionsForRole } from "@/server/auth/roles";
import { getAppPolicy } from "@/server/policy";
import { spaceSettingsSchema } from "@/server/spaces/settings-schema";
import { buildPlanReview, CHECK_NOT_STARTED, originLabel, restoredFrom, validationFixText, type SyncedItem } from "./loaders";
import { roleReasonsFor } from "./service";
import { itemRow, planRow } from "./testing";

const policy = getAppPolicy().policy;
const space = { id: "s1", alias: "test-space", displayName: "Customer Demo Space", parsedSettings: spaceSettingsSchema.parse({ approvalRequired: false }) };
const publisher = { email: "pub@example.com", name: "Pat", permissions: permissionsForRole(policy, "publisher") };

function review(checkJob: Parameters<typeof buildPlanReview>[0]["checkJob"], state: "checking" | "ready" = "checking") {
  const plan = planRow({ id: "p1", spaceId: "s1", state, checkRunId: "r1" });
  const items = [itemRow({ planId: "p1", position: 0, assetType: "agents_md", assetKey: "GENERIC" })];
  return buildPlanReview({ plan, items, space, viewer: publisher, lastApply: null, checkJob, authorName: "Ada Author" });
}

describe("plan review while the check waits or fails", () => {
  it("says the check hasn't started when no worker picked it up", () => {
    const r = review({ status: "queued", waitingForWorker: true, error: null });
    expect(r.jobs.check).toMatchObject({ waitingForWorker: true });
    expect(r.actions.primary).toMatchObject({ enabled: false, disabledReason: CHECK_NOT_STARTED });
    expect(CHECK_NOT_STARTED).toBe("The live-space check hasn't started yet.");
  });

  it("shows a check job that failed before it could record a result", () => {
    const r = review({ status: "failed", waitingForWorker: false, error: "Can't reach the space." });
    expect(r.callouts).toEqual([expect.objectContaining({ kind: "check-failed", title: "The live-space check failed", body: "Can't reach the space.", action: null })]);
  });

  it("ignores the check job once the plan has left checking, and uses the looked-up author name", () => {
    const r = review({ status: "failed", waitingForWorker: false, error: "x" }, "ready");
    expect(r.jobs.check).toBeNull();
    expect(r.plan.authorName).toBe("Ada Author");
    expect(r.selected).toMatchObject({ checked: false, writes: null });
  });

  it("after a failed check, fills the counts and the diff from the last synced version and keeps apply disabled", () => {
    const plan = planRow({ id: "p1", spaceId: "s1", state: "ready", checkedAt: new Date(), checkError: "CredentialsProviderError: Could not load credentials from any providers" });
    const item = itemRow({ planId: "p1", position: 0, assetType: "agents_md", assetKey: "GENERIC" });
    const synced = new Map<string, SyncedItem>([[item.id, { change: "content", liveVersion: 5, metadataDiff: [], contentDiff: [], addedLines: 2, removedLines: 0, sizeMeter: null, validation: [], validationStatus: "passed" }]]);
    const r = buildPlanReview({ plan, items: [item], space, viewer: publisher, lastApply: null, synced });
    expect(r.plan).toMatchObject({ checkFailed: true, comparedWith: "synced" });
    expect(r.tiles.contentUpdates).toBe(1);
    // Validation needs no live read, so the synced comparison fills it in.
    expect(r.items[0]).toMatchObject({ change: "content", versionLabel: "v5 → v6", validation: { status: "passed" } });
    expect(r.tiles.validation).toEqual({ passed: true, failed: 0, checks: 1, warnings: 0 });
    expect(r.selected).toMatchObject({ checked: true, comparedWith: "synced", added: 2, writes: null });
    expect(r.actions.primary).toMatchObject({ label: "Apply 1 change", enabled: false });
    expect(r.callouts[0]).toMatchObject({ kind: "check-failed", body: "This app has no AWS credentials for this space, so it can't reach AWS." });
    expect(buildPlanReview({ plan, items: [item], space, viewer: publisher, lastApply: null }).plan.comparedWith).toBeNull();
  });

  it("words the role reasons from policy", () => {
    expect(roleReasonsFor({ kind: "drafts", draftIds: [] }, "viewer")).toEqual({
      apply: "Only Publishers and Admins can apply plans. You're a Viewer.",
      create: "Only Editors, Publishers and Admins can change plans. You're a Viewer.",
    });
  });

  it("says where a version restore's content comes from", () => {
    const origin = { kind: "rollback" as const, target: { kind: "version" as const, assetId: "ki-1", version: 1 } };
    expect(restoredFrom(origin, { assetId: "ki-1", change: "content" })).toBe(", same content as v1");
    expect(restoredFrom(origin, { assetId: "ki-1", change: "status" })).toBe("");
    expect(restoredFrom({ kind: "drafts", draftIds: [] }, { assetId: "ki-1", change: "content" })).toBe("");
    const plan = planRow({ id: "p1", spaceId: "s1", state: "ready", origin, checkedAt: new Date() });
    const item = itemRow({ planId: "p1", position: 0, assetType: "skill", assetKey: "verity", assetId: "ki-1", change: "content", liveVersion: 2 });
    expect(buildPlanReview({ plan, items: [item], space, viewer: publisher, lastApply: null }).items[0]!.versionLabel).toBe("v2 → v3, same content as v1");
  });

  it("names restore origins with Restore", () => {
    expect(originLabel({ kind: "rollback", target: { kind: "release", releaseId: "r", name: "v1" } })).toBe("Restore to release v1");
    expect(originLabel({ kind: "rollback", target: { kind: "version", assetId: "a", version: 3 } })).toBe("Restore to v3");
  });
});

describe("validation fix text", () => {
  it("points to the draft only when there is one, and to the package or the source otherwise", () => {
    expect(validationFixText("drafts", true)).toBe("Fix the draft, then re-check.");
    expect(validationFixText("package", false)).toBe(
      "This plan can't be applied while an item fails validation. Fix the package and import it again, then discard this plan.",
    );
    expect(validationFixText("rollback", false)).toBe("This plan can't be applied while an item fails validation. Discard it and create it again once the cause is fixed.");
  });
});
