import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckReportResult, ExportReportResult, ExportViolation } from "@/server/audit-reports";

/**
 * The export Route Handler with the DAL answering from the shipped roles
 * policy: a Viewer has audits.read, so a Viewer can export. The service is
 * mocked; its own tests cover the gate and the file.
 */

const m = vi.hoisted(() => ({
  role: "viewer" as string | null,
  signedIn: true,
  asked: [] as string[],
  exportCalls: [] as unknown[],
  checkCalls: [] as unknown[],
  result: null as ExportReportResult | Error | null,
  check: null as CheckReportResult | null,
}));

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
      if (!m.signedIn) throw new AuthError(401, "signed out");
      if (!m.role || !permissionsForRole(getAppPolicy().policy, m.role).has(permission as never)) throw new AuthError(403, "forbidden");
      return { id: "u1", email: `${m.role}@example.com`, name: m.role, groups: [], devBypass: false };
    }),
  };
});
vi.mock("@/server/assets/guard", () => ({ decodeParam: (s: string) => decodeURIComponent(s) }));
vi.mock("@/server/spaces/queries", () => ({ getSpaceByAlias: vi.fn(async (alias: string) => (alias === "demo" ? { id: "space-1", alias: "demo" } : null)) }));
vi.mock("@/server/audit-reports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/audit-reports")>();
  return {
    ...actual,
    exportAuditReport: vi.fn(async (input: unknown, actor: unknown) => {
      m.exportCalls.push({ input, actor });
      if (m.result instanceof Error) throw m.result;
      return m.result;
    }),
    checkAuditReportExport: vi.fn(async (input: unknown) => {
      m.checkCalls.push(input);
      return m.check;
    }),
  };
});

const { GET } = await import("./route");
const { AuditReportError } = await import("@/server/audit-reports");

const AUDIT = "dddddddd-0000-4000-8000-000000000001";
const ctx = (alias = "demo", auditId = AUDIT) => ({ params: Promise.resolve({ alias, auditId }) });
const get = (query: string, alias = "demo", auditId = AUDIT) => GET(new Request(`http://127.0.0.1:3102/api/spaces/${alias}/audits/${auditId}/report/export${query}`), ctx(alias, auditId));
const violation: ExportViolation = { ruleId: "unmasked-account-id", severity: "error", description: "A full 12-digit AWS account ID.", index: 4, excerpt: "…arn:aws:iam::xxxxxxxx9012:role…", sectionId: "fixes", sectionTitle: "Fixes", location: "Row 9", incident: "INCIDENT-32059" };

beforeEach(() => {
  m.role = "viewer";
  m.signedIn = true;
  m.asked = [];
  m.exportCalls = [];
  m.checkCalls = [];
  m.result = { ok: true, fileName: "demo-nov-shareable.html", contentType: "text/html; charset=utf-8", html: "<!doctype html><title>x</title>", bytes: 31, sha256: "a".repeat(64), sections: ["summary"], omitted: [], warnings: [], stale: false, unapproved: [{ id: "summary", title: "Summary" }] };
  m.check = { ok: false, violations: [violation], warnings: [], excerptChars: 80 };
});

describe("GET /api/spaces/[alias]/audits/[auditId]/report/export", () => {
  it("lets a Viewer export: it asks for audits.read and passes the signed-in user", async () => {
    const res = await get("?audience=shareable");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, fileName: "demo-nov-shareable.html", html: "<!doctype html><title>x</title>", warnings: [], unapproved: [{ id: "summary", title: "Summary" }] });
    expect(m.asked).toEqual(["audits.read"]);
    expect(m.exportCalls).toEqual([{ input: { spaceId: "space-1", auditId: AUDIT, audience: "shareable" }, actor: expect.objectContaining({ email: "viewer@example.com" }) }]);
  });

  it("answers 422 with what the output rules found when the export is refused", async () => {
    m.result = { ok: false, reason: "output-rules", violations: [violation], warnings: [] };
    const res = await get("?audience=internal");
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, violations: [violation], warnings: [] });
  });

  it("runs only the check with check=1, without exporting", async () => {
    const res = await get("?audience=shareable&check=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, violations: [violation], warnings: [] });
    expect(m.exportCalls).toEqual([]);
    expect(m.checkCalls).toHaveLength(1);
  });

  it("refuses someone with no role in the space, and a signed-out caller", async () => {
    m.role = null;
    expect((await get("?audience=shareable")).status).toBe(403);
    m.signedIn = false;
    expect((await get("?audience=shareable")).status).toBe(401);
    expect(m.exportCalls).toEqual([]);
  });

  it("checks the space, the audience and the audit ID", async () => {
    expect((await get("?audience=shareable", "elsewhere")).status).toBe(404);
    const bad = await get("?audience=everyone");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Choose the Shareable or Internal audience." });
    expect((await get("?audience=shareable", "demo", "not-a-uuid")).status).toBe(404);
    m.result = new AuditReportError("Audit not found.", "not-found");
    expect(await (await get("?audience=shareable")).json()).toEqual({ error: "This audit doesn't exist in this space." });
    expect(m.asked.every((p) => p === "audits.read")).toBe(true);
  });
});
