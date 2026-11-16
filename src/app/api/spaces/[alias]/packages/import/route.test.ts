import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAppPolicy } from "@/server/policy";
import type { ImportPackageRequest, ImportPackageResult } from "@/server/package-io";

const m = vi.hoisted(() => ({
  space: { id: "space-1", alias: "demo" } as { id: string; alias: string } | null,
  deny: null as null | 401 | 403,
  permissions: [] as string[],
  requests: [] as ImportPackageRequest[],
  result: null as ImportPackageResult | Error | null,
  refused: [] as unknown[],
  allowedOrigins: [] as string[],
}));

vi.mock("@/server/auth/dal", () => {
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
      if (m.deny === 401) throw new AuthError(401, "no");
      return { id: "u1", email: "editor@example.com", name: "Editor", groups: [], devBypass: false };
    }),
    requirePermission: vi.fn(async (permission: string) => {
      m.permissions.push(permission);
      if (m.deny) throw new AuthError(m.deny, "no");
      return { id: "u1", email: "editor@example.com", name: "Editor", groups: [], devBypass: false };
    }),
  };
});
vi.mock("@/server/assets/guard", () => ({ decodeParam: (s: string) => decodeURIComponent(s) }));
vi.mock("@/server/spaces/queries", () => ({ getSpaceByAlias: vi.fn(async (alias: string) => (m.space && alias === m.space.alias ? m.space : null)) }));
vi.mock("@/server/env", () => ({ env: () => ({ allowedOrigins: m.allowedOrigins }) }));
vi.mock("@/server/journals/policy", async () => {
  const { getAppPolicy } = await import("@/server/policy");
  return { policyForSpace: vi.fn(async () => getAppPolicy()) };
});
vi.mock("@/server/package-io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/package-io")>();
  return {
    ...actual,
    importPackage: vi.fn(async (_space: unknown, request: ImportPackageRequest) => {
      m.requests.push(request);
      if (m.result instanceof Error) throw m.result;
      return m.result;
    }),
    recordRefusedUpload: vi.fn(async (_space: unknown, _actor: unknown, details: unknown) => {
      m.refused.push(details);
    }),
  };
});

const { POST } = await import("./route");
const { PackageIoError } = await import("@/server/package-io");

const limits = getAppPolicy().policy.limits.packageRead;
const ctx = (alias = "demo") => ({ params: Promise.resolve({ alias }) });
const analyzed = (assets = 3): ImportPackageResult => ({
  importId: "11111111-1111-4111-8111-111111111111",
  status: "analyzed",
  summary: { ok: true, packageName: "pkg", assets, counts: { create: assets, update: 0, unchanged: 0, untouched: 0, errors: 0, warnings: 0 }, roles: { asset: assets, "build-artifact": 0, manifest: 0, "non-asset": 0, skipped: 0, unmapped: 0 } },
  problems: [],
});

function upload(form: FormData, headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3203/api/spaces/demo/packages/import", { method: "POST", body: form, headers: { host: "127.0.0.1:3203", ...headers } });
}

async function body(res: Response) {
  return (await res.json()) as { importId?: string; status?: string; error?: { title: string; body: string; field?: string } };
}

beforeEach(() => {
  m.space = { id: "space-1", alias: "demo" };
  m.deny = null;
  m.permissions = [];
  m.requests = [];
  m.result = analyzed();
  m.refused = [];
  m.allowedOrigins = [];
});

describe("POST /api/spaces/[alias]/packages/import", () => {
  it("reads a zip upload, checks plans.create and returns the import ID", async () => {
    const form = new FormData();
    form.set("file", new File(["PK\u0003\u0004 zip bytes"], "pkg.zip"));
    form.set("layout", "instruction-folders");
    const res = await POST(upload(form), ctx());
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ importId: analyzed().importId, status: "analyzed" });
    expect(m.permissions).toEqual(["plans.create"]);
    expect(m.requests[0]).toMatchObject({ layout: "instruction-folders", upload: { kind: "zip", fileName: "pkg.zip" } });
  });

  it("reads a folder upload as files plus paths", async () => {
    const form = new FormData();
    form.append("files", new File(["# Global\n"], "global.md"));
    form.append("paths", "pkg/instructions/global.md");
    const res = await POST(upload(form), ctx());
    expect(res.status).toBe(200);
    const req = m.requests[0]!;
    expect(req.upload.kind).toBe("folder");
    if (req.upload.kind === "folder") expect(req.upload.files.map((f) => f.path)).toEqual(["pkg/instructions/global.md"]);
  });

  it("404s an unknown space before checking permissions", async () => {
    const res = await POST(upload(new FormData()), ctx("other"));
    expect(res.status).toBe(404);
    expect(m.permissions).toEqual([]);
  });

  it("answers a signed-out caller with 401 whether or not the space exists", async () => {
    m.deny = 401;
    expect((await POST(upload(new FormData()), ctx("other"))).status).toBe(401);
    expect((await POST(upload(new FormData()), ctx())).status).toBe(401);
  });

  it("maps auth errors to 401 and 403 without reading the body", async () => {
    m.deny = 403;
    const res = await POST(upload(new FormData()), ctx());
    expect(res.status).toBe(403);
    expect((await body(res)).error?.title).toMatch(/can't import/);
    m.deny = 401;
    expect((await POST(upload(new FormData()), ctx())).status).toBe(401);
    expect(m.requests).toEqual([]);
  });

  it("refuses a cross-site browser upload", async () => {
    const form = new FormData();
    form.set("file", new File(["PK"], "pkg.zip"));
    const res = await POST(upload(form, { origin: "https://evil.example" }), ctx());
    expect(res.status).toBe(403);
    expect(m.requests).toEqual([]);
    expect((await POST(upload(form, { origin: "http://127.0.0.1:3203" }), ctx())).status).toBe(200);
  });

  it("refuses an oversize body with 413 before parsing it, and audits the refusal", async () => {
    const declared = String(limits.maxTotalBytes * 2);
    const req = new Request("http://127.0.0.1:3203/api/spaces/demo/packages/import", {
      method: "POST",
      body: "x",
      headers: { host: "127.0.0.1:3203", "content-type": "multipart/form-data; boundary=b", "content-length": declared },
    });
    const res = await POST(req, ctx());
    expect(res.status).toBe(413);
    const b = await body(res);
    expect(b.error?.title).toBe("The package is too large");
    expect(b.error?.body).toBe("It is 128 MB; the limit is 32 MB for a zip and 64 MB of files for a folder.");
    expect(m.requests).toEqual([]);
    expect(m.refused).toEqual([expect.objectContaining({ reason: "too-large", sizeBytes: Number(declared) })]);
  });

  it("refuses a body shorter than its Content-Length (cut off upstream) with 413", async () => {
    const req = new Request("http://127.0.0.1:3203/api/spaces/demo/packages/import", {
      method: "POST",
      body: "--b--",
      headers: { host: "127.0.0.1:3203", "content-type": "multipart/form-data; boundary=b", "content-length": "5000" },
    });
    const res = await POST(req, ctx());
    expect(res.status).toBe(413);
    expect((await body(res)).error?.title).toBe("The upload was cut off");
    expect(m.refused).toEqual([expect.objectContaining({ reason: "truncated", sizeBytes: 5000 })]);
  });

  it("refuses a body that isn't a form and an empty form with 400", async () => {
    const res = await POST(new Request("http://127.0.0.1:3203/x", { method: "POST", body: "{}", headers: { host: "127.0.0.1:3203", "content-type": "application/json" } }), ctx());
    expect(res.status).toBe(400);
    expect((await body(res)).error?.body).toMatch(/form upload/);
    const empty = await POST(upload(new FormData()), ctx());
    expect(empty.status).toBe(400);
    expect((await body(empty)).error?.body).toBe("Choose a package zip or a package folder.");
  });

  it("maps an unknown layout to a 400 field error", async () => {
    m.result = new PackageIoError("unknown-layout", 'There is no package layout named "nope".');
    const form = new FormData();
    form.set("file", new File(["PK"], "pkg.zip"));
    const res = await POST(upload(form), ctx());
    expect(res.status).toBe(400);
    expect((await body(res)).error).toMatchObject({ field: "layout", body: 'There is no package layout named "nope".' });
  });

  it("shows a rejected upload on the upload page with the engine's results", async () => {
    m.result = {
      ...analyzed(0),
      status: "rejected",
      problems: [{ level: "error", code: "package.unsafe-path", message: 'File path "../x.md" uses a .. segment.', path: "../x.md" }],
    };
    const form = new FormData();
    form.set("file", new File(["PK"], "pkg.zip"));
    const res = await POST(upload(form), ctx());
    expect(res.status).toBe(422);
    const b = (await res.json()) as { importId: string; error: { title: string; body: string; results: { message: string }[] } };
    expect(b.importId).toBe(analyzed().importId);
    expect(b.error.title).toBe("The package was rejected");
    expect(b.error.body).toBe("Fix the package and upload it again.");
    expect(b.error.results[0]!.message).toBe('File path "../x.md" uses a .. segment.');
  });

  it("says when nothing in the package matches the layout", async () => {
    m.result = analyzed(0);
    const form = new FormData();
    form.set("file", new File(["PK"], "pkg.zip"));
    const res = await POST(upload(form), ctx());
    expect(res.status).toBe(422);
    expect((await body(res)).error?.title).toBe(`Nothing in this package matches ${getAppPolicy().policy.packageLayouts.layouts["instruction-folders"]!.label}`);
  });

  it("reports a zip over the zip cap in megabytes", async () => {
    m.result = { ...analyzed(0), status: "rejected", problems: [{ level: "error", code: "package.too-large", message: "The zip is 42991616 bytes; the limit is 33554432." }] };
    const form = new FormData();
    form.set("file", new File([new Uint8Array(41 * 1024 * 1024)], "big.zip"));
    const res = await POST(upload(form), ctx());
    expect(res.status).toBe(422);
    expect((await body(res)).error).toMatchObject({ title: "The package is too large", body: "It is 41 MB; the limit is 32 MB." });
  });
});
