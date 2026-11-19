import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Add to revision…" as a Server Action, with the DAL answering from the
 * shipped roles policy: it needs revisions.build, and findings.review as well
 * when the findings are accepted first. The audits and revisions services are
 * mocked; the revisions contract is src/server/revisions/findings.ts.
 */

const m = vi.hoisted(() => ({
  role: "editor" as string,
  asked: [] as string[],
  calls: [] as { fn: string; input: unknown }[],
  reviewFails: null as unknown,
  addFails: null as Error | null,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
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
    permissionsIn: vi.fn(),
    requirePermission: vi.fn(async (permission: string) => {
      m.asked.push(permission);
      if (!permissionsForRole(getAppPolicy().policy, m.role).has(permission as never)) throw new AuthError(403, "forbidden");
      return { id: "u1", email: `${m.role}@example.com`, name: m.role, groups: [], devBypass: false };
    }),
  };
});
vi.mock("@/server/spaces/queries", () => ({ getSpaceByAlias: vi.fn(async (alias: string) => (alias === "demo" ? { id: "space-1", alias: "demo" } : null)) }));
vi.mock("@/server/audits/finding-review", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/audits/finding-review")>();
  return {
    ...actual,
    reviewFinding: vi.fn(async (_actor: unknown, _space: string, id: string, input: unknown) => {
      m.calls.push({ fn: "review", input: { id, input } });
      if (m.reviewFails) throw m.reviewFails;
      return { findingId: id, state: "accepted", edited: false, changed: [] };
    }),
  };
});
vi.mock("@/server/revisions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/revisions")>();
  return {
    ...actual,
    addFindingsToRevision: vi.fn(async (_space: unknown, input: { findingIds: string[] }) => {
      m.calls.push({ fn: "add", input });
      if (m.addFails) throw m.addFails;
      return { revisionId: "rev-1", added: input.findingIds.length - 1, alreadyThere: 1 };
    }),
    createRevisionForFindings: vi.fn(async (_space: unknown, input: unknown) => {
      m.calls.push({ fn: "create", input });
      if (m.addFails) throw m.addFails;
      return { revisionId: "rev-2", runId: "run-1", branch: "revision/demo/v2.4" };
    }),
  };
});

const actions = await import("./actions");
const { RevisionError } = await import("@/server/revisions");
const { AuditRequestError } = await import("@/server/audits/errors");

const F1 = "aaaaaaaa-0000-4000-8000-000000000001";
const F2 = "aaaaaaaa-0000-4000-8000-000000000002";
const REV = "bbbbbbbb-0000-4000-8000-000000000001";

beforeEach(() => {
  m.role = "editor";
  m.asked = [];
  m.calls = [];
  m.reviewFails = null;
  m.addFails = null;
});

describe("addToRevisionAction", () => {
  it("refuses a Viewer, asking for revisions.build first", async () => {
    m.role = "viewer";
    const r = await actions.addToRevisionAction("demo", { findingIds: [F1], target: { kind: "existing", revisionId: REV } });
    expect(r).toEqual({ ok: false, message: "You don't have permission to do this in this space.", fieldErrors: {} });
    expect(m.asked).toEqual(["revisions.build"]);
    expect(m.calls).toEqual([]);
  });

  it("adds accepted findings to an open revision and says how many were new", async () => {
    const r = await actions.addToRevisionAction("demo", { findingIds: [F1, F2], target: { kind: "existing", revisionId: REV } });
    expect(r).toEqual({ ok: true, revisionName: null, created: false, accepted: 0, added: 1, alreadyThere: 1 });
    expect(m.calls).toEqual([{ fn: "add", input: { revisionId: REV, findingIds: [F1, F2] } }]);
    expect(m.asked).toEqual(["revisions.build"]);
  });

  it("starts a revision with the findings, named by the person", async () => {
    const r = await actions.addToRevisionAction("demo", { findingIds: [F1], target: { kind: "new", name: "  v2.4 ", note: " lag fixes " } });
    expect(r).toMatchObject({ ok: true, created: true, revisionName: "v2.4", added: 1 });
    expect(m.calls).toEqual([{ fn: "create", input: { name: "v2.4", findingIds: [F1], note: "lag fixes" } }]);
  });

  it("accepts a proposed finding first, then adds it, asking for findings.review too", async () => {
    const r = await actions.addToRevisionAction("demo", { findingIds: [F1], acceptFirst: true, target: { kind: "existing", revisionId: REV } });
    expect(r).toMatchObject({ ok: true, accepted: 1 });
    expect(m.calls.map((c) => c.fn)).toEqual(["review", "add"]);
    expect(m.calls[0]!.input).toEqual({ id: F1, input: { action: "accept" } });
    expect(m.asked).toEqual(["revisions.build", "findings.review"]);
  });

  it("carries on when someone accepted the finding meanwhile", async () => {
    m.reviewFails = new AuditRequestError("state", "The finding is already accepted.");
    const r = await actions.addToRevisionAction("demo", { findingIds: [F1], acceptFirst: true, target: { kind: "existing", revisionId: REV } });
    expect(r).toMatchObject({ ok: true, accepted: 0 });
    expect(m.calls.map((c) => c.fn)).toEqual(["review", "add"]);
  });

  it("says the finding stays accepted when the revision then refuses it", async () => {
    m.addFails = new RevisionError("not-open", "The revision was abandoned.");
    const r = await actions.addToRevisionAction("demo", { findingIds: [F1], acceptFirst: true, target: { kind: "existing", revisionId: REV } });
    expect(r).toMatchObject({ ok: false, message: "Accepted the finding, but it wasn't added to a revision. The revision was abandoned.", code: "not-open", details: { accepted: 1 } });
  });

  it("shows a revision's refusal as a plain message, with the name error on the field", async () => {
    m.addFails = new RevisionError("name-invalid", "Use a name like v2.4.", { name: "Use a name like v2.4." });
    const r = await actions.addToRevisionAction("demo", { findingIds: [F1], target: { kind: "new", name: "x y" } });
    expect(r).toEqual({ ok: false, message: "Use a name like v2.4.", fieldErrors: { name: "Use a name like v2.4." }, code: "name-invalid" });
  });

  it("rejects bad input before calling anything", async () => {
    expect(await actions.addToRevisionAction("demo", { findingIds: [], target: { kind: "existing", revisionId: REV } })).toMatchObject({ ok: false, message: "Choose at least one finding." });
    expect(await actions.addToRevisionAction("demo", { findingIds: ["nope"], target: { kind: "existing", revisionId: REV } })).toMatchObject({ ok: false });
    expect(await actions.addToRevisionAction("demo", { findingIds: [F1], target: { kind: "new", name: "  " } })).toMatchObject({ ok: false, message: "Name the revision." });
    expect(await actions.addToRevisionAction("elsewhere", { findingIds: [F1], target: { kind: "existing", revisionId: REV } })).toMatchObject({ ok: false });
    expect(m.calls).toEqual([]);
  });
});
