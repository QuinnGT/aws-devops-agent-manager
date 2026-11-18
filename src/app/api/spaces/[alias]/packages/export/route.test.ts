import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportPackageRequest, ExportPackageResult, ExportPreview } from "@/server/package-io";

const m = vi.hoisted(() => ({
  space: { id: "space-1", alias: "demo" } as { id: string; alias: string } | null,
  deny: null as null | 401 | 403,
  permissions: [] as string[],
  requests: [] as ExportPackageRequest[],
  result: null as ExportPackageResult | Error | null,
  preview: null as ExportPreview | Error | null,
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
    requirePermission: vi.fn(async (permission: string) => {
      m.permissions.push(permission);
      if (m.deny) throw new AuthError(m.deny, "no");
      return { id: "u1", email: "viewer@example.com", name: "Viewer", groups: [], devBypass: false };
    }),
  };
});
vi.mock("@/server/assets/guard", () => ({ decodeParam: (s: string) => decodeURIComponent(s) }));
vi.mock("@/server/spaces/queries", () => ({ getSpaceByAlias: vi.fn(async (alias: string) => (m.space && alias === m.space.alias ? m.space : null)) }));
vi.mock("@/server/package-io", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/package-io")>();
  return {
    ...actual,
    exportPackage: vi.fn(async (_space: unknown, request: ExportPackageRequest) => {
      m.requests.push(request);
      if (m.result instanceof Error) throw m.result;
      return m.result;
    }),
    previewExport: vi.fn(async (_space: unknown, request: ExportPackageRequest) => {
      m.requests.push(request);
      if (m.preview instanceof Error) throw m.preview;
      return m.preview;
    }),
  };
});

const { GET } = await import("./route");
const { GET: PREVIEW } = await import("./preview/route");
const { PackageIoError } = await import("@/server/package-io");

const ctx = (alias = "demo") => ({ params: Promise.resolve({ alias }) });
const get = (query: string) => new Request(`http://127.0.0.1:3203/api/spaces/demo/packages/export${query}`);
const zip = Buffer.from("PK\u0003\u0004 fake zip");
const exported: ExportPackageResult = {
  zip,
  fileName: "demo-v1.2.zip",
  warnings: [],
  results: [],
  ok: true,
  ref: { kind: "release", ref: "demo/v1.2", label: "v1.2", commit: "a".repeat(40), date: null, subject: null },
  layout: "instruction-folders-shared",
  assets: 3,
  sha256: "b".repeat(64),
};

beforeEach(() => {
  m.space = { id: "space-1", alias: "demo" };
  m.deny = null;
  m.permissions = [];
  m.requests = [];
  m.result = exported;
  m.preview = null;
});

describe("GET /api/spaces/[alias]/packages/export", () => {
  it("checks history.read, parses the query and returns the zip as an attachment", async () => {
    const res = await GET(get("?ref=demo%2Fv1.2&layout=instruction-folders-shared&name=demo-v1.2"), ctx());
    expect(res.status).toBe(200);
    expect(m.permissions).toEqual(["history.read"]);
    expect(m.requests).toEqual([{ ref: "demo/v1.2", layout: "instruction-folders-shared", name: "demo-v1.2" }]);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="demo-v1.2.zip"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer()).equals(zip)).toBe(true);
  });

  it("returns a refused download as plain text with the errors", async () => {
    m.result = new PackageIoError("checks-failed", "The package doesn't pass its checks: 2 errors.", [
      { level: "error", code: "package.missing-file", message: "instructions/learning.md is missing." },
      { level: "error", code: "package.missing-file", message: "README.md is missing." },
    ]);
    const res = await GET(get(""), ctx());
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("The package doesn't pass its checks: 2 errors.\ninstructions/learning.md is missing.\nREADME.md is missing.");
  });

  it("maps refused refs, a missing history repository and bad queries", async () => {
    m.result = new PackageIoError("unknown-ref", '"nope" is not a commit or a release of this space.');
    expect((await GET(get("?ref=nope"), ctx())).status).toBe(400);
    m.result = new PackageIoError("no-history", "This space has no history repository.");
    const noRepo = await GET(get(""), ctx());
    expect(noRepo.status).toBe(409);
    expect(await noRepo.text()).toBe("This space has no history repository.");
    const bad = await GET(get(`?ref=${"a".repeat(300)}`), ctx());
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/not valid/);
  });

  it("404s an unknown space and maps auth errors to plain text", async () => {
    expect((await GET(get(""), ctx("other"))).status).toBe(404);
    expect(m.permissions).toEqual([]);
    m.deny = 403;
    const res = await GET(get(""), ctx());
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/can't read this space's history/);
    expect(m.requests).toEqual([]);
  });
});

describe("GET /api/spaces/[alias]/packages/export/preview", () => {
  const preview: ExportPreview = {
    ok: false,
    blockedReason: "The package doesn't pass its checks: 1 error.",
    ref: exported.ref,
    layout: "instruction-folders-shared",
    layoutLabel: "Instruction folders with a shared section",
    packageName: "demo-v1.2",
    fileName: "demo-v1.2.zip",
    included: [{ assetType: "skill", count: 2, noun: "skills" }],
    leftOut: [{ assetType: "custom_agent", count: 1, noun: "custom agent" }],
    manifest: "reference/ASSET-METADATA.json",
    notesFile: "reference/EXPORT-NOTES.md",
    errors: [{ level: "error", code: "package.missing-file", message: "README.md is missing." }],
    warnings: [],
  };

  it("returns the facts as JSON with the same permission", async () => {
    m.preview = preview;
    const res = await PREVIEW(get("?ref=HEAD"), ctx());
    expect(res.status).toBe(200);
    expect(m.permissions).toEqual(["history.read"]);
    expect(await res.json()).toEqual({ preview });
  });

  it("names the field for an unknown commit or layout", async () => {
    m.preview = new PackageIoError("unknown-ref", '"abc1234" is not a commit or a release of this space.');
    const res = await PREVIEW(get("?ref=abc1234"), ctx());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No commit abc1234 in the history repository.", field: "ref" });
    m.preview = new PackageIoError("unknown-layout", 'There is no package layout named "x".');
    expect(await (await PREVIEW(get("?layout=x"), ctx())).json()).toEqual({ error: 'There is no package layout named "x".', field: "layout" });
  });

  it("refuses without history.read", async () => {
    m.deny = 403;
    expect((await PREVIEW(get(""), ctx())).status).toBe(403);
  });
});
