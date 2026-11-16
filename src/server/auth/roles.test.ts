import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { effectiveRole, permissionsForRole } from "./roles";

describe("roles", () => {
  const { policy } = getAppPolicy();

  it("expands inherited permissions", () => {
    const admin = permissionsForRole(policy, "admin");
    expect(admin.has("assets.read")).toBe(true);
    expect(admin.has("plans.apply")).toBe(true);
    expect(admin.has("replays.start")).toBe(true);
    const viewer = permissionsForRole(policy, "viewer");
    expect(viewer.has("journals.export")).toBe(true);
    expect(viewer.has("drafts.write")).toBe(false);
  });

  it("only Admins can start replays", () => {
    expect(permissionsForRole(policy, "publisher").has("replays.start")).toBe(false);
  });

  it("picks the highest-ranked matching binding for the space", () => {
    const bindings = [
      { spaceId: null, subjectType: "group" as const, subject: "sre", role: "viewer" },
      { spaceId: "s1", subjectType: "user" as const, subject: "A@Example.com", role: "publisher" },
      { spaceId: "s2", subjectType: "user" as const, subject: "a@example.com", role: "admin" },
    ];
    const who = { email: "a@example.com", groups: ["sre"] };
    expect(effectiveRole(policy, bindings, who, "s1")).toBe("publisher");
    expect(effectiveRole(policy, bindings, who, "s3")).toBe("viewer");
    expect(effectiveRole(policy, bindings, { email: "x@example.com", groups: [] }, "s1")).toBeNull();
  });
});
