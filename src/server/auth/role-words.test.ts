import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { missingRoleReason, roleNote, rolesWith, roleTitle } from "./role-words";

describe("role words", () => {
  const { policy } = getAppPolicy();

  it("lists the roles that hold a permission, lowest rank first", () => {
    expect(rolesWith(policy, "plans.apply")).toEqual(["publisher", "admin"]);
    expect(rolesWith(policy, "drafts.write")).toEqual(["editor", "publisher", "admin"]);
    expect(roleTitle("viewer")).toBe("Viewer");
  });

  it("names the roles that can, and the caller's role", () => {
    expect(missingRoleReason(policy, "viewer", "plans.apply", "apply plans")).toBe("Only Publishers and Admins can apply plans. You're a Viewer.");
    expect(missingRoleReason(policy, "editor", "releases.create", "create releases")).toBe(
      "Only Publishers and Admins can create releases. You're an Editor.",
    );
    expect(missingRoleReason(policy, null, "spaces.manage", "change space settings")).toBe(
      "Only Admins can change space settings. You don't have a role in this space.",
    );
  });

  it("writes a page note only when the role lacks the permission", () => {
    expect(roleNote(policy, "viewer", "drafts.write", "draft changes")).toBe(
      "You're a Viewer, so you can look but not draft changes. Editors, Publishers and Admins can draft changes.",
    );
    expect(roleNote(policy, "editor", "drafts.write", "draft changes")).toBeNull();
  });
});
