import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordAuditEvent } from "@/server/audit-log";
import { effectiveRole } from "@/server/auth/roles";
import { db } from "@/server/db/client";
import { agentSpaces, auditEvents, historyRepos, plans, roleBindings } from "@/server/db/schema";
import { enqueue } from "@/server/jobs/enqueue";
import { getAppPolicy } from "@/server/policy";
import { SYNC_SPACE_QUEUE } from "@/server/sync/contract";
import { truncateAll } from "../../../test/helpers/db";
import { auditExportStream, auditFilterSchema, listAuditActions, queryAuditEvents } from "./audit-log";
import { listBindings, removeBinding, saveBinding } from "./bindings";
import { SpaceServiceError } from "./errors";
import { isGeneratedExternalId } from "./external-id";
import { createHistoryRepo, updateHistoryRepo } from "./history-repos";
import { getSpaceByAlias } from "./queries";
import { registerSpace, requestConnectionTest, requestSpaceSync, updateSpace, updateSpaceSettings } from "./service";
import { parseSpaceSettings } from "./settings-schema";
import { bindingInputSchema, historyRepoFieldsSchema, registerSpaceSchema, updateSpaceSchema } from "./validators";

vi.mock("@/server/jobs/enqueue", () => ({ enqueue: vi.fn(async () => "11111111-1111-4111-8111-111111111111") }));

const admin = { email: "admin@example.com" };
const ROLE = "arn:aws:iam::111122223333:role/DamRead";

function registration(over: Record<string, unknown> = {}) {
  return registerSpaceSchema.parse({
    alias: "test-space",
    displayName: "Test space",
    region: "us-west-2",
    accountId: "111122223333",
    agentSpaceId: "00000000-0000-4000-8000-0000000000bb",
    readRoleArn: "",
    writeRoleArn: "",
    awsProfile: "dam-test",
    historyRepo: { mode: "new", repo: { name: "test-space-history" } },
    ...over,
  });
}

async function events(action?: string) {
  const rows = await db().select().from(auditEvents).orderBy(auditEvents.id);
  return action ? rows.filter((r) => r.action === action) : rows;
}

async function expectServiceError(p: Promise<unknown>, field?: string): Promise<SpaceServiceError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SpaceServiceError);
  if (field) expect((err as SpaceServiceError).fieldErrors[field]).toBeDefined();
  return err as SpaceServiceError;
}

beforeEach(async () => {
  await truncateAll();
  vi.mocked(enqueue).mockClear();
});

describe("registerSpace", () => {
  it("creates the space and its history repository and records both", async () => {
    const space = await registerSpace(registration(), admin);
    expect(space.alias).toBe("test-space");
    expect(space.externalId).toBeNull();
    expect(space.awsProfile).toBe("dam-test");
    expect(space.connectionStatus).toBe("unknown");

    const [repo] = await db().select().from(historyRepos);
    expect(repo).toMatchObject({ name: "test-space-history", pushEnabled: false, remoteUrl: null });
    expect(space.historyRepoId).toBe(repo!.id);

    const loaded = await getSpaceByAlias("test-space");
    expect(loaded?.parsedSettings).toEqual(parseSpaceSettings({}));

    expect((await events()).map((e) => e.action)).toEqual(["history-repo.create", "space.register"]);
    const [reg] = await events("space.register");
    expect(reg).toMatchObject({ actorEmail: admin.email, spaceId: space.id, result: "ok" });
    expect(reg!.details).toMatchObject({ alias: "test-space", historyRepoCreated: true, externalIdGenerated: false });
  });

  it("generates an external ID when role ARNs are given", async () => {
    const space = await registerSpace(registration({ readRoleArn: ROLE, awsProfile: "" }), admin);
    expect(space.externalId && isGeneratedExternalId(space.externalId)).toBe(true);
    expect(JSON.stringify((await events("space.register"))[0]!.details)).not.toContain(space.externalId!);
  });

  it("uses an existing history repository", async () => {
    const repo = await createHistoryRepo(historyRepoFieldsSchema.parse({ name: "shared-history" }), admin);
    const space = await registerSpace(registration({ historyRepo: { mode: "existing", id: repo.id } }), admin);
    expect(space.historyRepoId).toBe(repo.id);
    expect(await db().select().from(historyRepos)).toHaveLength(1);
  });

  it("rejects a missing repository, a taken alias, a registered space and a taken repository name", async () => {
    await expectServiceError(registerSpace(registration({ historyRepo: { mode: "existing", id: "22222222-2222-4222-8222-222222222222" } }), admin), "historyRepo.id");

    await registerSpace(registration(), admin);
    await expectServiceError(
      registerSpace(registration({ agentSpaceId: "other-space", historyRepo: { mode: "new", repo: { name: "h2" } } }), admin),
      "alias",
    );
    await expectServiceError(
      registerSpace(registration({ alias: "second", historyRepo: { mode: "new", repo: { name: "h3" } } }), admin),
      "agentSpaceId",
    );
    await expectServiceError(registerSpace(registration({ alias: "third", agentSpaceId: "third-space" }), admin), "historyRepo.repo.name");

    // Failed registrations leave nothing behind.
    expect(await db().select().from(agentSpaces)).toHaveLength(1);
    expect((await db().select().from(historyRepos)).map((r) => r.name)).toEqual(["test-space-history"]);
  });
});

describe("updateSpace and settings", () => {
  it("updates connection fields, generates the external ID once and resets the connection status", async () => {
    const space = await registerSpace(registration(), admin);
    await db().update(agentSpaces).set({ connectionStatus: "ok" }).where(eq(agentSpaces.id, space.id));

    const updated = await updateSpace(
      space.id,
      updateSpaceSchema.parse({ displayName: "Demo", readRoleArn: ROLE, writeRoleArn: "", awsProfile: "" }),
      admin,
    );
    expect(updated.displayName).toBe("Demo");
    expect(updated.readRoleArn).toBe(ROLE);
    expect(updated.awsProfile).toBeNull();
    expect(updated.connectionStatus).toBe("unknown");
    const externalId = updated.externalId;
    expect(externalId && isGeneratedExternalId(externalId)).toBe(true);

    const again = await updateSpace(space.id, updateSpaceSchema.parse({ displayName: "Demo 2", readRoleArn: ROLE }), admin);
    expect(again.externalId).toBe(externalId);

    const [first] = await events("space.update");
    expect(first!.details).toMatchObject({
      changed: {
        displayName: { from: "Test space", to: "Demo" },
        readRoleArn: { from: null, to: ROLE },
        awsProfile: { from: "dam-test", to: null },
        externalId: { from: null, to: "generated" },
      },
    });
  });

  it("rejects a role in another account", async () => {
    const space = await registerSpace(registration(), admin);
    await expectServiceError(updateSpace(space.id, updateSpaceSchema.parse({ readRoleArn: "arn:aws:iam::444455556666:role/R" }), admin), "readRoleArn");
  });

  it("stores settings and records what changed", async () => {
    const space = await registerSpace(registration(), admin);
    const next = { ...parseSpaceSettings({}), approvalRequired: true, incidentIdRule: { regex: "\\[(INC-\\d+)\\]", field: "title" as const } };
    await updateSpaceSettings(space.id, next, admin);
    expect((await getSpaceByAlias("test-space"))?.parsedSettings).toEqual(next);
    const [e] = await events("space.settings-update");
    expect(Object.keys((e!.details as { changed: object }).changed).sort()).toEqual(["approvalRequired", "incidentIdRule"]);
  });
});

describe("jobs requested by the overview", () => {
  it("enqueues the connection test and records the request", async () => {
    const space = await registerSpace(registration(), admin);
    const runId = await requestConnectionTest(space.id, admin, "registration");
    expect(runId).toBe("11111111-1111-4111-8111-111111111111");
    const [job, input, opts] = vi.mocked(enqueue).mock.calls[0]!;
    expect(job.name).toBe("spaces.connection-test");
    expect(input).toEqual({ spaceId: space.id, reason: "registration" });
    expect(opts).toEqual({ actor: admin, spaceId: space.id });
    expect((await events("space.connection-test-request"))[0]?.details).toMatchObject({ reason: "registration", runId });
  });

  it("requests a sync through the sync contract and records it", async () => {
    const space = await registerSpace(registration(), admin);
    await requestSpaceSync(space.id, admin);
    const [job, input] = vi.mocked(enqueue).mock.calls[0]!;
    expect(job.name).toBe(SYNC_SPACE_QUEUE);
    expect(input).toEqual({ spaceId: space.id, reason: "manual" });
    expect(await events("sync.request")).toHaveLength(1);
  });
});

describe("history repositories", () => {
  it("updates remote, key path and push flag, and refuses renaming a repository in use", async () => {
    const space = await registerSpace(registration(), admin);
    const updated = await updateHistoryRepo(
      space.historyRepoId!,
      historyRepoFieldsSchema.parse({
        name: "test-space-history",
        remoteUrl: "git@github.com:example-org/test-space-history.git",
        deployKeyFile: "/run/secrets/test_history_key",
        pushEnabled: "on",
      }),
      admin,
    );
    expect(updated).toMatchObject({ pushEnabled: true, deployKeyFile: "/run/secrets/test_history_key" });
    expect((await events("history-repo.update"))[0]?.details).toMatchObject({ changed: { pushEnabled: { from: false, to: true } } });

    await expectServiceError(updateHistoryRepo(space.historyRepoId!, historyRepoFieldsSchema.parse({ name: "renamed" }), admin), "name");

    const unused = await createHistoryRepo(historyRepoFieldsSchema.parse({ name: "unused" }), admin);
    expect((await updateHistoryRepo(unused.id, historyRepoFieldsSchema.parse({ name: "renamed" }), admin)).name).toBe("renamed");
    await expectServiceError(updateHistoryRepo(unused.id, historyRepoFieldsSchema.parse({ name: "test-space-history" }), admin), "name");
  });

  it("stores the branch, and changes it only while no space uses the repository", async () => {
    const space = await registerSpace(registration({ historyRepo: { mode: "new", repo: { name: "branchy", defaultBranch: "history/test" } } }), admin);
    const [repo] = await db().select().from(historyRepos).where(eq(historyRepos.id, space.historyRepoId!));
    expect(repo?.defaultBranch).toBe("history/test");
    expect((await events("history-repo.create"))[0]?.details).toMatchObject({ defaultBranch: "history/test" });

    await expectServiceError(updateHistoryRepo(repo!.id, historyRepoFieldsSchema.parse({ name: "branchy", defaultBranch: "main" }), admin), "defaultBranch");

    const unused = await createHistoryRepo(historyRepoFieldsSchema.parse({ name: "spare" }), admin);
    expect(unused.defaultBranch).toBe("main");
    const moved = await updateHistoryRepo(unused.id, historyRepoFieldsSchema.parse({ name: "spare", defaultBranch: "trunk" }), admin);
    expect(moved.defaultBranch).toBe("trunk");
    expect((await events("history-repo.update")).at(-1)?.details).toMatchObject({ changed: { defaultBranch: { from: "main", to: "trunk" } } });
  });
});

describe("role bindings", () => {
  const binding = (over: Record<string, unknown>) => bindingInputSchema.parse({ spaceId: "", subjectType: "user", subject: "alice@example.com", role: "viewer", ...over });

  it("creates, replaces and removes bindings, globally and per space", async () => {
    const space = await registerSpace(registration(), admin);
    await saveBinding(binding({ subject: "admin@example.com", role: "admin" }), admin, "admin");
    const g = await saveBinding(binding({}), admin, "admin");
    const again = await saveBinding(binding({ role: "editor" }), admin, "admin");
    expect(again.id).toBe(g.id);
    expect(again.role).toBe("editor");
    await saveBinding(binding({ spaceId: space.id, subjectType: "group", subject: "DevOps-Publishers", role: "publisher" }), admin, "admin");

    const all = await listBindings();
    expect(all).toHaveLength(3);
    expect(all.find((b) => b.subject === "DevOps-Publishers")?.spaceAlias).toBe("test-space");

    const policy = getAppPolicy().policy;
    expect(effectiveRole(policy, all, { email: "Alice@example.com", groups: [] }, null)).toBe("editor");
    expect(effectiveRole(policy, all, { email: "bob@example.com", groups: ["DevOps-Publishers"] }, space.id)).toBe("publisher");
    expect(effectiveRole(policy, all, { email: "bob@example.com", groups: ["DevOps-Publishers"] }, null)).toBeNull();

    await removeBinding(g.id, admin, "admin");
    expect(await listBindings()).toHaveLength(2);
    expect((await events()).filter((e) => e.action.startsWith("binding.")).map((e) => e.action)).toEqual([
      "binding.create",
      "binding.create",
      "binding.update",
      "binding.create",
      "binding.delete",
    ]);
  });

  it("refuses to grant or remove a role above the grantor's own", async () => {
    await expectServiceError(saveBinding(binding({ role: "admin" }), { email: "ed@example.com" }, "editor"), "role");
    await expectServiceError(saveBinding(binding({ role: "owner" }), admin, "admin"), "role");
    const b = await saveBinding(binding({ role: "publisher" }), admin, "admin");
    await saveBinding(binding({ subject: "admin@example.com", role: "admin" }), admin, "admin");
    await expectServiceError(removeBinding(b.id, { email: "ed@example.com" }, "editor"));
  });

  it("keeps the last global binding that can manage bindings", async () => {
    const only = await saveBinding(binding({ subject: "admin@example.com", role: "admin" }), admin, "admin");
    await expectServiceError(removeBinding(only.id, admin, "admin"));
    const second = await saveBinding(binding({ subjectType: "group", subject: "Admins", role: "admin" }), admin, "admin");
    await removeBinding(only.id, admin, "admin");
    await expectServiceError(removeBinding(second.id, admin, "admin"));
    expect(await db().select().from(roleBindings)).toHaveLength(1);
  });
});

describe("audit log export", () => {
  async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
    return new Response(stream).text();
  }

  async function seed() {
    const space = await registerSpace(registration(), admin);
    await recordAuditEvent({ actor: { email: "=cmd@example.com" }, action: "journal.export", spaceId: space.id, details: { note: "+SUM(A1)" } });
    await recordAuditEvent({ actor: { email: "bob@example.com", name: "Bob, \"B\"" }, action: "auth.sign-in" });
    return space;
  }

  it("exports CSV with a header, quoting and formula neutralization", async () => {
    await seed();
    const csv = await readAll(auditExportStream("csv", auditFilterSchema.parse({}), { all: true }));
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe('"id","at","actor_email","actor_name","action","space_id","space_alias","target_type","target_id","result","details"');
    expect(lines).toHaveLength(1 + (await events()).length);
    expect(lines[1]).toContain('"Bob, ""B"""');
    const exportLine = lines.find((l) => l.includes("journal.export"))!;
    expect(exportLine).toContain(`"'=cmd@example.com"`);
    expect(exportLine).toContain('"test-space"');
    expect(exportLine).not.toMatch(/(^|,)"[=+\-@]/);
  });

  it("exports JSON that parses, newest first, and honors filters and scope", async () => {
    const space = await seed();
    const all = JSON.parse(await readAll(auditExportStream("json", auditFilterSchema.parse({}), { all: true }))) as { id: number; action: string }[];
    expect(all.map((e) => e.action)).toEqual(["auth.sign-in", "journal.export", "space.register", "history-repo.create"]);
    expect(all[0]!.id).toBeGreaterThan(all[1]!.id);

    const scoped = JSON.parse(await readAll(auditExportStream("json", auditFilterSchema.parse({}), { all: false, spaceIds: [space.id] }))) as {
      action: string;
    }[];
    expect(scoped.map((e) => e.action)).toEqual(["journal.export", "space.register"]);

    const byActor = await queryAuditEvents(auditFilterSchema.parse({ actor: "BOB" }), { all: true }, 50);
    expect(byActor.map((e) => e.action)).toEqual(["auth.sign-in"]);
    const byAction = await queryAuditEvents(auditFilterSchema.parse({ action: "space.register", space: space.id }), { all: true }, 50);
    expect(byAction).toHaveLength(1);
    const wildcard = await queryAuditEvents(auditFilterSchema.parse({ actor: "%" }), { all: true }, 50);
    expect(wildcard).toHaveLength(0);

    const today = new Date().toISOString().slice(0, 10);
    expect(await queryAuditEvents(auditFilterSchema.parse({ from: today, to: today }), { all: true }, 50)).toHaveLength(4);
    expect(await queryAuditEvents(auditFilterSchema.parse({ to: "2000-01-01" }), { all: true }, 50)).toHaveLength(0);

    const empty = JSON.parse(await readAll(auditExportStream("json", auditFilterSchema.parse({ action: "none" }), { all: true })));
    expect(empty).toEqual([]);

    expect(await listAuditActions({ all: false, spaceIds: [space.id] })).toEqual(["journal.export", "space.register"]);
  });

  it("filters by target, result and several actions, and reads days in the viewer's time zone", async () => {
    const space = await seed();
    await recordAuditEvent({ actor: admin, action: "binding.create", spaceId: space.id, targetType: "role_binding", targetId: "b-1", details: { subject: "carol@example.com" } });
    await recordAuditEvent({ actor: admin, action: "plan.apply", spaceId: space.id, targetType: "plan", targetId: "p-1", result: "error", details: { title: "Shorter guidance" } });
    await recordAuditEvent({ actor: { email: "dave@example.com" }, action: "plan.approve", result: "denied" });

    const q = (f: Record<string, string>) => queryAuditEvents(auditFilterSchema.parse(f), { all: true }, 50);
    expect((await q({ target: "CAROL" })).map((e) => e.action)).toEqual(["binding.create"]);
    expect((await q({ target: "shorter" })).map((e) => e.action)).toEqual(["plan.apply"]);
    // The space alias matches events that target the space, not every event in it ("test-space-history" is the repository's name).
    expect((await q({ target: "test-space" })).map((e) => e.action)).toEqual(["space.register", "history-repo.create"]);
    expect((await q({ target: "role_binding" })).map((e) => e.action)).toEqual(["binding.create"]);
    expect((await q({ result: "error,denied" })).map((e) => e.action)).toEqual(["plan.approve", "plan.apply"]);
    expect((await q({ action: "plan.apply,auth.sign-in" })).map((e) => e.action)).toEqual(["plan.apply", "auth.sign-in"]);
    expect((await q({ actor: "Bob, " })).map((e) => e.action)).toEqual(["auth.sign-in"]);

    // A day far ahead of UTC (Kiritimati is UTC+14) still contains "now" when it is that day there.
    const now = new Date();
    const kiritimatiDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Kiritimati" }).format(now);
    const inZone = await queryAuditEvents(auditFilterSchema.parse({ from: kiritimatiDay, to: kiritimatiDay }), { all: true }, 50, { timeZone: "Pacific/Kiritimati" });
    expect(inZone).toHaveLength((await events()).length);
  });

  it("names a plan target by the plan's title when the event's details don't", async () => {
    const space = await seed();
    const [plan] = await db()
      .insert(plans)
      .values({ spaceId: space.id, title: "Global instructions", origin: { kind: "drafts", draftIds: [] } as never, originKind: "drafts", createdBy: admin.email })
      .returning();
    await recordAuditEvent({ actor: admin, action: "plan.check", spaceId: space.id, targetType: "plan", targetId: plan!.id, result: "error", details: { summary: null } });
    // The same ID in an event without the plan's space gets no title.
    await recordAuditEvent({ actor: admin, action: "plan.check", targetType: "plan", targetId: plan!.id });

    const q = (f: Record<string, string>) => queryAuditEvents(auditFilterSchema.parse(f), { all: true }, 50);
    const checks = await q({ action: "plan.check" });
    expect(checks.map((e) => e.planTitle)).toEqual([null, "Global instructions"]);
    expect((await q({ target: "global instr" })).map((e) => e.action)).toEqual(["plan.check"]);
  });

  it("pages through more events than one batch", async () => {
    for (let i = 0; i < 25; i++) await recordAuditEvent({ actor: admin, action: "test.bulk", details: { i } });
    const page = await queryAuditEvents(auditFilterSchema.parse({ before: "20" }), { all: true }, 5);
    expect(page.map((e) => e.id)).toEqual([19, 18, 17, 16, 15]);
    const json = JSON.parse(await new Response(auditExportStream("json", auditFilterSchema.parse({}), { all: true })).text());
    expect(json).toHaveLength(25);
  });
});
