import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Report tab's Server Actions with the DAL answering from the shipped
 * roles policy: a Viewer can't build, edit, hide, draft or finalize; an
 * Editor can. The service is mocked.
 */

const m = vi.hoisted(() => ({ role: "viewer" as string, asked: [] as string[], calls: [] as { fn: string; input: unknown; actor: unknown }[], fail: null as Error | null }));

vi.mock("@/server/auth/dal", async () => {
  const { getAppPolicy } = await import("@/server/policy");
  const { permissionsForRole } = await import("@/server/auth/roles");
  class AuthError extends Error {
    constructor(
      readonly status: 401 | 403,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    AuthError,
    requirePermission: vi.fn(async (permission: string) => {
      m.asked.push(permission);
      if (!permissionsForRole(getAppPolicy().policy, m.role).has(permission as never)) throw new AuthError(403, "forbidden");
      return { id: "u1", email: `${m.role}@example.com`, name: m.role, groups: [], devBypass: false };
    }),
  };
});
vi.mock("@/server/spaces/queries", () => ({ getSpaceByAlias: vi.fn(async (alias: string) => (alias === "demo" ? { id: "space-1", alias: "demo" } : null)) }));
vi.mock("@/server/audit-reports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/audit-reports")>();
  const rec = (fn: string, out: unknown) =>
    vi.fn(async (input: unknown, actor: unknown) => {
      m.calls.push({ fn, input, actor });
      if (m.fail) throw m.fail;
      return out;
    });
  return {
    ...actual,
    buildAuditReport: rec("build", {}),
    saveReportNarrative: rec("save", {}),
    approveReportNarrative: rec("approve", {}),
    setReportSectionHidden: rec("hide", {}),
    requestDraftNarrative: rec("draft", { runId: "run-draft" }),
    requestFinalizeAudit: rec("finalize", { runId: "run-finalize" }),
  };
});

const actions = await import("./actions");
const { AuditReportError } = await import("@/server/audit-reports");

const AUDIT = "dddddddd-0000-4000-8000-000000000001";
const all = () => [
  actions.buildReportAction("demo", AUDIT),
  actions.saveNarrativeAction("demo", AUDIT, "summary", "New text"),
  actions.setSectionHiddenAction("demo", AUDIT, "run-metrics", true),
  actions.draftNarrativeAction("demo", AUDIT, "summary", false),
  actions.finalizeAuditAction("demo", AUDIT),
  actions.approveNarrativeAction("demo", AUDIT, "summary", "Model text"),
];

beforeEach(() => {
  m.role = "viewer";
  m.asked = [];
  m.calls = [];
  m.fail = null;
});

describe("report Server Actions", () => {
  it("refuse a Viewer every change, asking for audits.run", async () => {
    for (const r of await Promise.all(all())) expect(r).toEqual({ ok: false, message: "You don't have permission to do this in this space.", problems: [] });
    expect(new Set(m.asked)).toEqual(new Set(["audits.run"]));
    expect(m.calls).toEqual([]);
  });

  it("let an Editor change the report, with the signed-in user as the actor", async () => {
    m.role = "editor";
    const results = await Promise.all(all());
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true, true, true]);
    expect(results[3]).toEqual({ ok: true, runId: "run-draft" });
    expect(results[4]).toEqual({ ok: true, runId: "run-finalize" });
    expect(m.calls.map((c) => c.fn)).toEqual(["build", "save", "hide", "draft", "finalize", "approve"]);
    expect(m.calls[1]!.input).toEqual({ spaceId: "space-1", auditId: AUDIT, sectionId: "summary", text: "New text" });
    expect(m.calls[3]!.input).toEqual({ spaceId: "space-1", auditId: AUDIT, sectionIds: ["summary"], replacePersonText: false });
    expect(m.calls[5]!.input).toEqual({ spaceId: "space-1", auditId: AUDIT, sectionId: "summary", text: "Model text" });
    expect(m.calls.every((c) => (c.actor as { email: string }).email === "editor@example.com")).toBe(true);
  });

  it("map service refusals to plain messages with the finalize problems", async () => {
    m.role = "editor";
    m.fail = new AuditReportError("1 finding is still proposed. Accept or reject each one first.", "not-ready", ["1 finding is still proposed. Accept or reject each one first.", "1 investigation is not reviewed or skipped yet: INCIDENT-2."]);
    expect(await actions.finalizeAuditAction("demo", AUDIT)).toEqual({ ok: false, message: m.fail.message, problems: (m.fail as InstanceType<typeof AuditReportError>).problems });
    m.fail = new AuditReportError("Audit not found.", "not-found");
    expect(await actions.buildReportAction("demo", AUDIT)).toMatchObject({ ok: false, message: "This audit doesn't exist in this space." });
  });

  it("reject bad input before calling the service", async () => {
    m.role = "editor";
    expect(await actions.buildReportAction("demo", "not-a-uuid")).toMatchObject({ ok: false, message: "This audit doesn't exist in this space." });
    expect(await actions.buildReportAction("elsewhere", AUDIT)).toMatchObject({ ok: false });
    expect(await actions.saveNarrativeAction("demo", AUDIT, "", "x")).toMatchObject({ ok: false, message: "Check what you entered and try again." });
    expect(m.calls).toEqual([]);
  });
});
