import { describe, expect, it } from "vitest";
import { AUDIT_RESULTS } from "@/server/spaces/audit-filter";
import { actionLabel, auditTarget, detailsText, RESULT_WORDS, resultWord, targetKind } from "./audit-labels";

const PLAN = "0f4a5c3e-7b1d-4e2a-9c6f-1a2b3c4d5e6f";

describe("targetKind", () => {
  it("names known target types and makes unknown ones readable", () => {
    expect(targetKind("agent_space")).toBe("Space");
    expect(targetKind("history_repo")).toBe("History repository");
    expect(targetKind("export_job")).toBe("Journal export");
    expect(targetKind("audit_report")).toBe("Audit report");
  });
});

describe("auditTarget", () => {
  it("shows a space by alias and links to it", () => {
    expect(auditTarget({ targetType: "agent_space", targetId: "c95712bf-109c", spaceAlias: "customer-demo-space", details: { alias: "old" } })).toEqual({
      kind: "Space",
      name: "customer-demo-space",
      shortId: "c95712bf",
      href: "/spaces/customer-demo-space",
    });
  });

  it("takes a name from the details, and links plans and releases inside their space", () => {
    expect(auditTarget({ targetType: "plan", targetId: PLAN, spaceAlias: "demo", details: { title: "Shorter guidance" } })).toMatchObject({
      name: "Shorter guidance",
      href: `/spaces/demo/plans/${PLAN}`,
    });
    expect(auditTarget({ targetType: "release", targetId: "r1", spaceAlias: "demo", details: { name: "v1.3" } })?.href).toBe("/spaces/demo/releases/v1.3");
    expect(auditTarget({ targetType: "role_binding", targetId: PLAN, spaceAlias: null, details: { subject: "bob@example.com" } })).toEqual({
      kind: "Role binding",
      name: "bob@example.com",
      shortId: PLAN.slice(0, 8),
      href: null,
    });
  });

  it("names a plan by its title when the event's details don't (Plan checked)", () => {
    expect(auditTarget({ targetType: "plan", targetId: PLAN, spaceAlias: "demo", details: { summary: {} }, planTitle: "Global instructions" })).toMatchObject({
      name: "Global instructions",
      href: `/spaces/demo/plans/${PLAN}`,
    });
    expect(auditTarget({ targetType: "plan", targetId: PLAN, spaceAlias: "demo", details: { title: "From the event" }, planTitle: "Renamed" })?.name).toBe("From the event");
  });

  it("falls back to the short ID, and returns null without a target", () => {
    expect(auditTarget({ targetType: "history_repo", targetId: PLAN, spaceAlias: null, details: null })).toMatchObject({ name: null, shortId: "0f4a5c3e" });
    expect(auditTarget({ targetType: null, targetId: null, spaceAlias: "demo", details: {} })).toBeNull();
  });
});

describe("detailsText and result words", () => {
  it("indents details and hides empty ones", () => {
    expect(detailsText({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(detailsText({})).toBeNull();
    expect(detailsText(null)).toBeNull();
  });

  it("has a word, tone and icon for every stored result", () => {
    for (const r of AUDIT_RESULTS) expect(RESULT_WORDS[r].label).toBeTruthy();
    expect(RESULT_WORDS.denied.tone).toBe("warning");
  });
});

describe("action words", () => {
  it("names actions in plain words and makes unknown codes readable", () => {
    expect(actionLabel("space.settings-update")).toBe("Settings changed");
    expect(actionLabel("rollback.plan")).toBe("Restore plan created");
    expect(actionLabel("sync.request")).toBe("Sync requested");
    expect(actionLabel("plan.foo-bar")).toBe("Plan foo bar");
  });

  it("shows an accepted request as Requested, not Succeeded", () => {
    expect(resultWord("sync.request", "ok").label).toBe("Requested");
    expect(resultWord("journal.export.requested", "ok").label).toBe("Requested");
    expect(resultWord("sync.request", "error").label).toBe("Failed");
    expect(resultWord("release.create", "ok").label).toBe("Succeeded");
  });
});
