import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportReport } from "@/server/audits/handoff-import";

/**
 * The review-files Route Handlers with the DAL answering from the shipped roles
 * policy: download needs audits.read and journals.export (a Viewer has both),
 * import needs audits.run (an Editor). The services are mocked; their own
 * tests cover the files and the checks.
 */

const m = vi.hoisted(() => ({
  role: "viewer" as string | null,
  signedIn: true,
  asked: [] as string[],
  exportCalls: [] as unknown[],
  importCalls: [] as { files: { fileName: string; bytes: Buffer }[]; opts: unknown }[],
  importResult: null as ImportReport | Error | null,
  exportError: null as Error | null,
  lacking: new Set<string>(),
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
    requireUser: vi.fn(async () => {
      if (!m.signedIn) throw new AuthError(401, "signed out");
    }),
    requirePermission: vi.fn(async (permission: string) => {
      m.asked.push(permission);
      if (!m.signedIn) throw new AuthError(401, "signed out");
      if (m.lacking.has(permission) || !m.role || !permissionsForRole(getAppPolicy().policy, m.role).has(permission as never)) throw new AuthError(403, "forbidden");
      return { id: "u1", email: `${m.role}@example.com`, name: m.role, groups: [], devBypass: false };
    }),
  };
});
vi.mock("@/server/assets/guard", () => ({ decodeParam: (s: string) => decodeURIComponent(s) }));
vi.mock("@/server/spaces/queries", () => ({ getSpaceByAlias: vi.fn(async (alias: string) => (alias === "demo" ? { id: "space-1", alias: "demo" } : null)) }));
vi.mock("@/server/audits/profiles", async () => {
  const { getAppPolicy } = await import("@/server/policy");
  return { loadedPolicyForSpace: vi.fn(async () => getAppPolicy()) };
});
vi.mock("@/server/audits/handoff", () => ({
  exportReviewFiles: vi.fn(async (actor: unknown, spaceId: string, auditId: string, opts: unknown) => {
    m.exportCalls.push({ actor, spaceId, auditId, opts });
    if (m.exportError) throw m.exportError;
    const zip = new JSZip();
    zip.file("INCIDENT-1/README.md", "hello");
    return { fileName: "Run-review-files.zip", zip, items: [], left: [] };
  }),
}));
vi.mock("@/server/audits/handoff-import", () => ({
  importReviews: vi.fn(async (_actor: unknown, _spaceId: string, _auditId: string, files: { fileName: string; bytes: Buffer }[], opts: unknown) => {
    m.importCalls.push({ files, opts });
    if (m.importResult instanceof Error) throw m.importResult;
    return m.importResult;
  }),
}));

const audit = "11111111-1111-4111-8111-111111111111";
const item = "22222222-2222-4222-8222-222222222222";
const { GET, POST } = await import("./route");
const itemRoute = await import("../items/[itemId]/review-files/route");
const { AuditRequestError } = await import("@/server/audits/errors");

const ctx = (alias = "demo", auditId = audit) => ({ params: Promise.resolve({ alias, auditId }) }) as never;
const itemCtx = (itemId = item) => ({ params: Promise.resolve({ alias: "demo", auditId: audit, itemId }) }) as never;

function upload(fields: { reviewer?: string; files?: { name: string; body: string }[] }, headers: Record<string, string> = {}): Request {
  const form = new FormData();
  if (fields.reviewer !== undefined) form.append("reviewer", fields.reviewer);
  for (const f of fields.files ?? []) form.append("files", new File([f.body], f.name));
  return new Request("http://localhost/api/spaces/demo/audits/x/review-files", { method: "POST", body: form, headers });
}

const report = (over: Partial<ImportReport> = {}): ImportReport => ({ results: [], withoutReview: 0, totals: { files: 0, imported: 0, refused: 0, replaced: 0 }, ...over });

beforeEach(() => {
  m.role = "editor";
  m.signedIn = true;
  m.asked = [];
  m.exportCalls = [];
  m.importCalls = [];
  m.importResult = report();
  m.exportError = null;
  m.lacking = new Set();
});

describe("download", () => {
  it("lets a Viewer download a zip, and asks for audits.read and journals.export", async () => {
    m.role = "viewer";
    const res = await GET(new Request("http://localhost/x"), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="Run-review-files.zip"');
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(m.asked).toEqual(["audits.read", "journals.export"]);
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    expect(await zip.file("INCIDENT-1/README.md")!.async("string")).toBe("hello");
    expect(m.exportCalls).toEqual([{ actor: expect.objectContaining({ email: "viewer@example.com" }), spaceId: "space-1", auditId: audit, opts: { itemId: undefined } }]);
  });

  it("downloads one investigation from the investigation's route", async () => {
    const res = await itemRoute.GET(new Request("http://localhost/x"), itemCtx());
    expect(res.status).toBe(200);
    expect(m.exportCalls[0]).toMatchObject({ auditId: audit, opts: { itemId: item } });
  });

  it("refuses a role without journals.export, a signed-out caller and an unknown space or ID", async () => {
    m.lacking.add("journals.export");
    expect((await GET(new Request("http://localhost/x"), ctx())).status).toBe(403);
    expect(m.exportCalls).toEqual([]);
    m.lacking.clear();
    m.signedIn = false;
    expect((await GET(new Request("http://localhost/x"), ctx())).status).toBe(401);
    m.signedIn = true;
    expect((await GET(new Request("http://localhost/x"), ctx("nowhere"))).status).toBe(404);
    expect((await GET(new Request("http://localhost/x"), ctx("demo", "not-a-uuid"))).status).toBe(404);
    expect((await itemRoute.GET(new Request("http://localhost/x"), itemCtx("nope"))).status).toBe(404);
    expect(m.exportCalls).toEqual([]);
  });

  it("answers with the service's reason when there is nothing to download", async () => {
    m.exportError = new AuditRequestError("state", "The audit is finalized; review files are for an audit that is running or in review.");
    const res = await GET(new Request("http://localhost/x"), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { title: "There are no review files to download", body: "The audit is finalized; review files are for an audit that is running or in review." } });
  });
});

describe("import", () => {
  it("needs audits.run: a Viewer is refused before the body is read", async () => {
    m.role = "viewer";
    const res = await POST(upload({ reviewer: "Kiro CLI", files: [{ name: "review.json", body: "{}" }] }), ctx());
    expect(res.status).toBe(403);
    expect(m.asked).toEqual(["audits.run"]);
    expect(m.importCalls).toEqual([]);
  });

  it("passes the files and the reviewer label to the service", async () => {
    m.importResult = report({ totals: { files: 1, imported: 1, refused: 0, replaced: 0 } });
    const res = await POST(upload({ reviewer: "Claude Code, Opus 5.5", files: [{ name: "reviews.zip", body: "PK" }] }), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).report.totals.imported).toBe(1);
    expect(m.importCalls).toHaveLength(1);
    expect(m.importCalls[0]!.files.map((f) => [f.fileName, f.bytes.toString()])).toEqual([["reviews.zip", "PK"]]);
    expect(m.importCalls[0]!.opts).toEqual({ reviewer: "Claude Code, Opus 5.5", itemId: undefined });
  });

  it("limits an upload from the investigation's route to that investigation", async () => {
    await itemRoute.POST(upload({ reviewer: "x", files: [{ name: "review.json", body: "{}" }] }), itemCtx());
    expect(m.importCalls[0]!.opts).toEqual({ reviewer: "x", itemId: item });
  });

  it("refuses a request from another site", async () => {
    const res = await POST(upload({ reviewer: "x", files: [{ name: "review.json", body: "{}" }] }, { origin: "https://evil.example", host: "localhost", "sec-fetch-site": "cross-site" }), ctx());
    expect(res.status).toBe(403);
    expect(m.importCalls).toEqual([]);
  });

  it("refuses a body that is not a form, and one over the policy's limit", async () => {
    const notForm = new Request("http://localhost/x", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect((await POST(notForm, ctx())).status).toBe(400);
    const big = new Request("http://localhost/x", { method: "POST", body: "x", headers: { "content-type": "multipart/form-data; boundary=a", "content-length": String(999 * 1024 * 1024) } });
    const res = await POST(big, ctx());
    expect(res.status).toBe(413);
    expect((await res.json()).error.title).toMatch(/larger than 25 MB/);
    expect(m.importCalls).toEqual([]);
  });

  it("answers a refused reviewer label with the field it belongs to", async () => {
    m.importResult = new AuditRequestError("invalid", "Enter who or what wrote the reviews, for example Claude Code, Opus 5.5.", { field: "reviewer" });
    const res = await POST(upload({ reviewer: " ", files: [{ name: "review.json", body: "{}" }] }), ctx());
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { title: "The reviews were not imported", body: "Enter who or what wrote the reviews, for example Claude Code, Opus 5.5.", field: "reviewer" } });
  });

  it("answers a wrong audit state with 409 and a missing audit with 404", async () => {
    m.importResult = new AuditRequestError("state", "The audit is finalized.");
    expect((await POST(upload({ reviewer: "x", files: [{ name: "review.json", body: "{}" }] }), ctx())).status).toBe(409);
    m.importResult = new AuditRequestError("not-found", "The audit is not in this space.");
    expect((await POST(upload({ reviewer: "x", files: [{ name: "review.json", body: "{}" }] }), ctx())).status).toBe(404);
  });
});
