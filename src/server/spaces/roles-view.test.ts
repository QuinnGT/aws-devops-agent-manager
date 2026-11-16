import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { approvalSentence, approvalWarning, whoCanDoWhat } from "./roles-view";

const policy = getAppPolicy().policy;
const SPACE = "s1";
const b = (subject: string, role: string, spaceId: string | null = SPACE, subjectType: "user" | "group" = "user") => ({ spaceId, subjectType, subject, role });

describe("who can do what", () => {
  it("lists each role with its own description and the highest role each subject holds here", () => {
    const w = whoCanDoWhat(policy, [b("ann@example.com", "viewer", null), b("Ann@example.com", "publisher"), b("bob@example.com", "editor"), b("cy@example.com", "admin", "other"), b("sre", "publisher", null, "group")], SPACE, null);
    expect(w.roles.map((r) => r.name)).toEqual(["viewer", "editor", "publisher", "admin"]);
    expect(w.roles.find((r) => r.name === "editor")?.description).toBe("Can view everything, sync the space, write change reasons, and draft changes and turn them into plans.");
    for (const r of w.roles) expect(r.description).not.toMatch(/permissions, plus/);
    expect(w.roles.find((r) => r.name === "publisher")?.holders).toEqual([
      { kind: "user", subject: "Ann@example.com", scope: "space" },
      { kind: "group", subject: "sre", scope: "global" },
    ]);
    expect(w.roles.find((r) => r.name === "admin")?.holders).toEqual([]);
    expect(w.approverRoles).toEqual(["publisher", "admin"]);
    expect(w.approvers).toEqual({ people: 1, groups: 1 });
  });

  it("counts only the bypass user when the local sign-in bypass is on", () => {
    const w = whoCanDoWhat(policy, [b("ann@example.com", "publisher"), b("bob@example.com", "admin")], SPACE, { email: "local@localhost", role: "admin" });
    expect(w.roles.find((r) => r.name === "admin")?.holders[0]).toEqual({ kind: "bypass", subject: "local@localhost", scope: "bypass" });
    expect(w.approvers).toEqual({ people: 1, groups: 0 });
  });

  it("warns when fewer than two people can approve and apply, unless a group can", () => {
    expect(approvalWarning({ people: 0, groups: 0 }, ["publisher", "admin"], false)?.body).toBe(
      "Nobody here has the Publisher or Admin role, so no plan could be approved. Give two people one of those roles first.",
    );
    expect(approvalWarning({ people: 1, groups: 0 }, ["publisher", "admin"], false)?.title).toBe("Fewer than two people can approve and apply plans");
    expect(approvalWarning({ people: 1, groups: 0 }, ["publisher", "admin"], true)?.body).toMatch(/local sign-in bypass/);
    expect(approvalWarning({ people: 2, groups: 0 }, ["publisher"], false)).toBeNull();
    expect(approvalWarning({ people: 0, groups: 1 }, ["publisher"], false)).toBeNull();
  });
});

describe("approval sentence", () => {
  it("names the roles that approve and apply, and says whether a second person must approve", () => {
    expect(approvalSentence(["publisher", "admin"], false)).toBe(
      "Publishers and Admins can approve and apply plans. This space doesn't require approval from a second person, so a plan can be applied without a separate approval.",
    );
    expect(approvalSentence(["admin"], true)).toBe(
      "Admins can approve and apply plans. This space requires approval from a second person: someone other than the plan's author approves a plan before anyone can apply it.",
    );
    expect(approvalSentence([], false).startsWith("No role can approve and apply plans.")).toBe(true);
  });
});
