import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { resolveAuditScope } from "./audit-log";
import { canGrant, grantableRoles, policyRoles, removeBlockReason } from "./bindings";

describe("policyRoles", () => {
  it("reads roles from policy, highest rank first", () => {
    expect(policyRoles().map((r) => r.name)).toEqual(["admin", "publisher", "editor", "viewer"]);
  });
});

describe("canGrant", () => {
  const policy = getAppPolicy().policy;

  it("allows roles at or below the grantor's own role", () => {
    expect(canGrant(policy, "admin", "admin")).toBe(true);
    expect(canGrant(policy, "admin", "viewer")).toBe(true);
    expect(canGrant(policy, "publisher", "editor")).toBe(true);
  });

  it("refuses higher roles, unknown roles and grantors without a role", () => {
    expect(canGrant(policy, "editor", "admin")).toBe(false);
    expect(canGrant(policy, "admin", "owner")).toBe(false);
    expect(canGrant(policy, null, "viewer")).toBe(false);
  });
});

describe("removeBlockReason", () => {
  const policy = getAppPolicy().policy;
  const globalAdmin = { spaceId: null, role: "admin" };
  const otherAdmin = { spaceId: null, role: "admin" };
  const spaceAdmin = { spaceId: "s1", role: "admin" };
  const spaceViewer = { spaceId: "s1", role: "viewer" };

  it("allows removing a binding at or below the caller's role", () => {
    expect(removeBlockReason(policy, spaceViewer, [globalAdmin, spaceViewer], "publisher")).toBeNull();
    expect(removeBlockReason(policy, globalAdmin, [globalAdmin, otherAdmin], "admin")).toBeNull();
  });

  it("blocks a role above the caller's own", () => {
    expect(removeBlockReason(policy, spaceAdmin, [globalAdmin, spaceAdmin], "publisher")).toMatch(/above your own role/);
    expect(removeBlockReason(policy, spaceViewer, [spaceViewer], null)).toMatch(/above your own role/);
  });

  it("blocks the last global binding that can manage bindings, but not a space one", () => {
    expect(removeBlockReason(policy, globalAdmin, [globalAdmin, spaceAdmin], "admin")).toMatch(/last global binding/);
    expect(removeBlockReason(policy, spaceAdmin, [globalAdmin, spaceAdmin], "admin")).toBeNull();
  });
});

describe("grantableRoles", () => {
  const policy = getAppPolicy().policy;
  it("lists roles at or below the caller's, highest first", () => {
    expect(grantableRoles(policy, "admin")).toEqual(["admin", "publisher", "editor", "viewer"]);
    expect(grantableRoles(policy, "editor")).toEqual(["editor", "viewer"]);
    expect(grantableRoles(policy, null)).toEqual([]);
  });
});

describe("resolveAuditScope", () => {
  it("returns every event for a global reader", async () => {
    expect(await resolveAuditScope(["a", "b"], async (s) => s === null)).toEqual({ all: true });
  });

  it("limits a space-level reader to their spaces", async () => {
    expect(await resolveAuditScope(["a", "b", "c"], async (s) => s === "a" || s === "c")).toEqual({ all: false, spaceIds: ["a", "c"] });
  });

  it("returns null when the caller can read nothing", async () => {
    expect(await resolveAuditScope(["a"], async () => false)).toBeNull();
  });
});
