import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { permissionsForRole } from "@/server/auth/roles";
import { planActions, type PlanActionInput, REASONS } from "./actions";
import type { PlanState } from "./types";

const policy = getAppPolicy().policy;
const perms = (role: string) => permissionsForRole(policy, role);
const AUTHOR = "author@example.com";

function input(state: PlanState, viewer: { email: string; role: string }, over: Partial<PlanActionInput> = {}): PlanActionInput {
  return {
    plan: { state, origin: { kind: "drafts", draftIds: ["d"] }, createdBy: AUTHOR, approvalRequestedAt: state === "waiting" ? new Date() : null, approvedAt: state === "approved" ? new Date() : null, checkError: null },
    viewer: { email: viewer.email, permissions: perms(viewer.role) },
    settings: { approvalRequired: true },
    writeCount: 3,
    validationFailed: 0,
    failedCount: 0,
    ...over,
  };
}

describe("planActions: buttons by role and state (plan-review.md)", () => {
  it("row 1: the author requests approval on a ready plan", () => {
    const a = planActions(input("ready", { email: AUTHOR, role: "editor" }));
    expect(a.primary).toEqual({ action: "request-approval", label: "Request approval", enabled: true, disabledReason: null });
    expect(a.discard?.enabled).toBe(true);
  });

  it("row 2: an approver who is not the author approves or rejects a waiting plan", () => {
    const a = planActions(input("waiting", { email: "pub@example.com", role: "publisher" }));
    expect(a.primary).toMatchObject({ action: "approve", label: "Approve", enabled: true });
    expect(a.reject).toMatchObject({ action: "reject", label: "Reject", enabled: true });
    expect(a.discard).toMatchObject({ enabled: false, disabledReason: REASONS.notAuthor });
  });

  it("row 3: a publisher applies an approved plan, counting only written items", () => {
    const a = planActions(input("approved", { email: "pub@example.com", role: "publisher" }, { writeCount: 1 }));
    expect(a.primary).toEqual({ action: "apply", label: "Apply 1 change", enabled: true, disabledReason: null });
  });

  it("row 3: a ready plan applies directly when the space needs no approval, even for its author", () => {
    const a = planActions(input("ready", { email: AUTHOR, role: "publisher" }, { settings: { approvalRequired: false } }));
    expect(a.primary).toMatchObject({ action: "apply", label: "Apply 3 changes", enabled: true });
  });

  it("rollbacks need rollbacks.apply, not plans.apply", () => {
    const viewer = { email: "x@example.com", permissions: ["plans.apply" as const] };
    const a = planActions({ ...input("ready", { email: "x@example.com", role: "publisher" }, { settings: { approvalRequired: false } }), viewer, plan: { ...input("ready", { email: AUTHOR, role: "editor" }).plan, origin: { kind: "rollback", target: { kind: "commit", commit: "abc" } } } });
    expect(a.primary).toMatchObject({ action: "apply", enabled: false, disabledReason: REASONS.publisher });
  });

  it("row 4: the author can't approve their own waiting plan", () => {
    const a = planActions(input("waiting", { email: AUTHOR.toUpperCase(), role: "publisher" }));
    expect(a.primary).toEqual({ action: "approve", label: "Approve", enabled: false, disabledReason: REASONS.ownPlan });
    expect(a.reject).toBeNull();
  });

  it("row 4: an editor sees the disabled apply button with the role reason", () => {
    const a = planActions(input("approved", { email: "ed@example.com", role: "editor" }));
    expect(a.primary).toMatchObject({ action: "apply", enabled: false, disabledReason: REASONS.publisher });
  });

  it("row 4: a publisher waits for approval", () => {
    expect(planActions(input("ready", { email: "pub@example.com", role: "publisher" })).primary).toMatchObject({ action: "apply", enabled: false, disabledReason: REASONS.approvalFirst });
    expect(planActions(input("waiting", { email: "viewer@example.com", role: "viewer" })).primary).toMatchObject({ action: "apply", enabled: false, disabledReason: REASONS.publisher });
  });

  it("validation failures block every primary button", () => {
    const failed = { validationFailed: 2 };
    expect(planActions(input("ready", { email: AUTHOR, role: "editor" }, failed)).primary).toMatchObject({ action: "request-approval", enabled: false, disabledReason: "Validation failed for 2 asset(s)." });
    expect(planActions(input("waiting", { email: "pub@example.com", role: "publisher" }, failed)).primary).toMatchObject({ action: "approve", enabled: false, disabledReason: REASONS.validation(2) });
    expect(planActions(input("approved", { email: "pub@example.com", role: "publisher" }, failed)).primary).toMatchObject({ action: "apply", enabled: false, disabledReason: REASONS.validation(2) });
  });

  it("a running check, a failed check and an empty plan block apply", () => {
    const pub = { email: "pub@example.com", role: "publisher" };
    const open = { settings: { approvalRequired: false } };
    expect(planActions(input("checking", pub, open)).primary).toMatchObject({ enabled: false, disabledReason: REASONS.checking });
    expect(planActions({ ...input("ready", pub, open), plan: { ...input("ready", pub).plan, checkError: "boom" } }).primary).toMatchObject({ enabled: false, disabledReason: REASONS.checkFailed });
    expect(planActions(input("ready", pub, { ...open, writeCount: 0 })).primary).toMatchObject({ label: "Apply 0 changes", enabled: false, disabledReason: REASONS.nothingToApply });
  });

  it("finished and running plans have no enabled primary button; a failed one offers a retry plan", () => {
    const pub = { email: "pub@example.com", role: "publisher" };
    expect(planActions(input("applying", pub)).primary).toMatchObject({ enabled: false, disabledReason: REASONS.applying });
    expect(planActions(input("applied", pub)).primary).toBeNull();
    expect(planActions(input("discarded", pub)).primary).toBeNull();
    const failed = planActions(input("failed", pub, { failedCount: 2 }));
    expect(failed.primary).toBeNull();
    expect(failed.retryFailed).toMatchObject({ enabled: true, label: "Create a plan for the failed items" });
    expect(planActions(input("failed", { email: "v@example.com", role: "viewer" }, { failedCount: 2 })).retryFailed).toMatchObject({ enabled: false, disabledReason: REASONS.editor });
  });

  it("a Viewer who wrote the plan can't discard it: the action needs plans.create", () => {
    const own = planActions(input("ready", { email: AUTHOR, role: "viewer" }));
    expect(own.discard).toMatchObject({ enabled: false, disabledReason: REASONS.editor });
    expect(planActions(input("ready", { email: AUTHOR, role: "editor" })).discard?.enabled).toBe(true);
  });

  it("a role that can't apply sees the role reason even while the check runs", () => {
    expect(planActions(input("checking", { email: "v@example.com", role: "viewer" })).primary).toMatchObject({ action: "apply", enabled: false, disabledReason: REASONS.publisher });
    expect(planActions(input("checking", { email: "pub@example.com", role: "publisher" }, { settings: { approvalRequired: false } })).primary).toMatchObject({ disabledReason: REASONS.checking });
  });

  it("names the roles that can, and a Viewer who wrote the plan sees the apply role reason, not Request approval", () => {
    const roleReasons = { apply: "Only Publishers and Admins can apply plans. You're a Viewer.", create: "Only Editors, Publishers and Admins can change plans. You're a Viewer." };
    const base = input("ready", { email: AUTHOR, role: "viewer" });
    const a = planActions({ ...base, plan: { ...base.plan, checkError: "boom" }, roleReasons });
    expect(a.primary).toMatchObject({ action: "apply", enabled: false, disabledReason: roleReasons.apply });
    expect(a.discard).toMatchObject({ enabled: false, disabledReason: roleReasons.create });
    expect(a.recheck).toMatchObject({ enabled: false, disabledReason: roleReasons.create });
  });

  it("an Admin can discard another user's plan; re-check needs plans.create", () => {
    expect(planActions(input("ready", { email: "admin@example.com", role: "admin" })).discard?.enabled).toBe(true);
    expect(planActions(input("ready", { email: "v@example.com", role: "viewer" })).recheck).toMatchObject({ enabled: false, disabledReason: REASONS.editor });
    expect(planActions(input("approved", { email: "ed@example.com", role: "editor" })).recheck?.enabled).toBe(true);
    expect(planActions(input("applied", { email: "admin@example.com", role: "admin" })).discard).toBeNull();
  });
});
