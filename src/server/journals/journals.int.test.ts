import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DevOpsAgentClient, ListBacklogTasksCommand, ListExecutionsCommand, ListJournalRecordsCommand, type ListJournalRecordsRequest } from "@aws-sdk/client-devops-agent";
import { mockClient } from "aws-sdk-client-mock";
import { and, asc, eq } from "drizzle-orm";
import JSZip from "jszip";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db/client";
import { agentSpaces, auditEvents, exportFiles, exportJobs, journalExecutions, journalImports, journalRecords, journalTasks } from "@/server/db/schema";
import { testJobContext } from "@/server/jobs/registry";
import { getSpaceById, type Space } from "@/server/spaces/queries";
import { apiFixture } from "../../../test/helpers/fixtures";
import { truncateAll } from "../../../test/helpers/db";
import { openExportDownload } from "./download";
import { runExpireExports } from "./expire";
import { requestExport, runExport } from "./export";
import { runImport, saveUpload, type ImportReport, type ParseMarkdown } from "./import";
import { resolveInArea } from "./paths";
import { journalCounts, listInvestigations } from "./queries";

// Jobs are run directly in these tests; nothing is sent to pg-boss.
vi.mock("@/server/jobs/enqueue", () => ({ enqueue: vi.fn(async () => crypto.randomUUID()) }));

/* eslint-disable @typescript-eslint/no-explicit-any */
const tasksFx = apiFixture<any>("ListBacklogTasks").response;
const execsFx = apiFixture<any>("ListExecutions").response;
const page0 = apiFixture<any>("ListJournalRecords.exec0.page0").response;
const page1 = apiFixture<any>("ListJournalRecords.exec0.page1").response;
const TASK_ID = apiFixture<any>("GetBacklogTask").response.task.taskId as string;
const EXEC_ID = execsFx.executions[0].executionId as string;
const AGENT_SPACE_ID = "00000000-0000-4000-8000-0000000000bb";
const actor = { email: "tester@example.com" };

const mock = mockClient(DevOpsAgentClient);
const client = new DevOpsAgentClient({ region: "us-west-2", credentials: { accessKeyId: "test", secretAccessKey: "test" } });

function mockSpace() {
  mock.reset();
  // The captured page has a redacted nextToken; serve it as the only page.
  mock.on(ListBacklogTasksCommand).resolves({ ...tasksFx, nextToken: undefined });
  mock.on(ListExecutionsCommand).resolves({ executions: [] });
  mock.on(ListExecutionsCommand, { taskId: TASK_ID }).resolves(execsFx);
  mock.on(ListJournalRecordsCommand).callsFake((input: ListJournalRecordsRequest) => {
    if (input.executionId !== EXEC_ID) return { records: [] };
    return input.nextToken === page0.nextToken ? page1 : page0;
  });
}

async function createSpace(alias: string, settings: Record<string, unknown> = {}): Promise<Space> {
  // Spaces are unique per (region, agentSpaceId); the mocked client answers for any ID.
  const agentSpaceId = alias === "export-e2e" ? AGENT_SPACE_ID : crypto.randomUUID();
  const [row] = await db()
    .insert(agentSpaces)
    .values({ alias, region: "us-west-2", accountId: "111122223333", agentSpaceId, settings })
    .returning({ id: agentSpaces.id });
  return (await getSpaceById(row!.id))!;
}

async function exportAll(space: Space) {
  const { exportJobId } = await requestExport(space, { mode: "filter", taskTypes: ["SYSTEM_LEARNING"] }, actor);
  const result = await runExport({ exportJobId }, testJobContext({ actor, spaceId: space.id }), { client });
  return { exportJobId, result };
}

async function exportZipBytes(exportJobId: string): Promise<Buffer> {
  const [file] = await db().select().from(exportFiles).where(eq(exportFiles.exportJobId, exportJobId));
  return readFile(resolveInArea("exports", file!.path));
}

/** Cached rows for a space, without the columns that say where and when they were cached. */
async function cachedRows(spaceId: string) {
  const tasks = await db().select().from(journalTasks).where(eq(journalTasks.spaceId, spaceId)).orderBy(asc(journalTasks.taskId));
  const execs = await db().select().from(journalExecutions).where(eq(journalExecutions.spaceId, spaceId)).orderBy(asc(journalExecutions.executionId));
  const records = await db().select().from(journalRecords).where(eq(journalRecords.spaceId, spaceId)).orderBy(asc(journalRecords.recordId));
  return {
    tasks: tasks.map(({ spaceId: _s, source: _src, importId: _i, importPath: _p, fetchedAt: _f, ...rest }) => rest),
    execs: execs.map(({ spaceId: _s, recordsFetchedAt: _f, ...rest }) => rest),
    records: records.map(({ spaceId: _s, ...rest }) => rest),
  };
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function importBytes(space: Space, fileName: string, bytes: Buffer, parseMarkdown?: ParseMarkdown) {
  const { importId } = await saveUpload(space, { fileName, bytes }, actor);
  const report = await runImport({ importId }, testJobContext({ actor, spaceId: space.id }), parseMarkdown ? { parseMarkdown } : {});
  const [row] = await db().select().from(journalImports).where(eq(journalImports.id, importId));
  return { importId, report, row: row! };
}

describe("journal export and import (database)", () => {
  beforeAll(async () => {
    await truncateAll();
  });
  beforeEach(() => {
    mockSpace();
  });

  it("exports end to end: walks the API, caches rows, writes the zip and records the file", async () => {
    const space = await createSpace("export-e2e");
    const { exportJobId, result } = await exportAll(space);
    expect(result).toMatchObject({ status: "succeeded", taskCount: tasksFx.tasks.length, recordCount: 113 });

    // One ListBacklogTasks call (one task type), one ListExecutions per task, two record pages.
    expect(mock.commandCalls(ListBacklogTasksCommand)).toHaveLength(1);
    expect(mock.commandCalls(ListBacklogTasksCommand)[0]?.args[0].input).toMatchObject({ agentSpaceId: AGENT_SPACE_ID, limit: 100, filter: { taskType: ["SYSTEM_LEARNING"] } });
    expect(mock.commandCalls(ListExecutionsCommand)).toHaveLength(tasksFx.tasks.length);
    expect(mock.commandCalls(ListJournalRecordsCommand)).toHaveLength(2);

    const rows = await cachedRows(space.id);
    expect(rows.tasks).toHaveLength(tasksFx.tasks.length);
    expect(rows.execs).toHaveLength(1);
    expect(rows.execs[0]).toMatchObject({ executionId: EXEC_ID, status: "STOPPED", recordsComplete: true, recordCount: 113, agentType: "systemLearning" });
    expect(rows.records).toHaveLength(113);
    const first = rows.records.find((r) => r.recordId === page0.records[0].recordId);
    expect(first?.raw).toEqual(page0.records[0]);
    expect(first?.seq).toBe(1);

    const [job] = await db().select().from(exportJobs).where(eq(exportJobs.id, exportJobId));
    expect(job).toMatchObject({ status: "succeeded", taskCount: tasksFx.tasks.length, recordCount: 113 });
    expect(job!.expiresAt!.getTime() - job!.createdAt.getTime()).toBeGreaterThan(13 * 86_400_000);

    const [file] = await db().select().from(exportFiles).where(eq(exportFiles.exportJobId, exportJobId));
    const bytes = await exportZipBytes(exportJobId);
    expect(file!.sha256).toBe(sha256(bytes));
    expect(file!.sizeBytes).toBe((await stat(resolveInArea("exports", file!.path))).size);

    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir);
    expect(names).toContain("manifest.csv");
    expect(names.filter((n) => n.startsWith("raw/"))).toHaveLength(tasksFx.tasks.length);
    expect(names.filter((n) => n.startsWith("markdown/"))).toHaveLength(tasksFx.tasks.length);
    const manifest = (await zip.file("manifest.csv")!.async("string")).trim().split("\r\n");
    expect(manifest[0]).toBe("task_id,incident_id,status,created_at,executions,record_count");
    expect(manifest).toContain(`${TASK_ID},,COMPLETED,2026-10-23T18:28:25.982Z,1,113`);
    const md = await zip.file(`markdown/${TASK_ID}-journal.md`)!.async("string");
    expect(md.startsWith(`# Journal Log: ${TASK_ID}\n\n\n---\n## Record: message\n**Created:** 2026-10-23 18:39:13.087000+00:00\n`)).toBe(true);

    const events = await db().select().from(auditEvents).where(and(eq(auditEvents.targetId, exportJobId)));
    expect(events.map((e) => e.action).sort()).toEqual(["journal.export.completed", "journal.export.requested"]);
  });

  it("resumes: a second export reuses fully cached executions", async () => {
    const space = await createSpace("export-resume");
    await exportAll(space);
    mock.resetHistory();
    const { result } = await exportAll(space);
    expect(result.status).toBe("succeeded");
    expect(mock.commandCalls(ListJournalRecordsCommand)).toHaveLength(0);
    const [job] = await db().select().from(exportJobs).where(eq(exportJobs.id, result.exportJobId));
    expect(job!.summary).toMatchObject({ cachedExecutions: 1, fetchedExecutions: 0, recordsFetched: 0 });
  });

  it("records each download in the audit log and refuses expired files", async () => {
    const space = await createSpace("export-download");
    const other = await createSpace("export-download-other");
    const { exportJobId } = await exportAll(space);
    const d = await openExportDownload(space, exportJobId, actor);
    expect(d.ok).toBe(true);
    // Another space's ID never reaches this export.
    expect(await openExportDownload(other, exportJobId, actor)).toMatchObject({ ok: false, status: 404 });
    const later = new Date(Date.now() + 30 * 86_400_000);
    expect(await openExportDownload(space, exportJobId, actor, later)).toMatchObject({ ok: false, status: 410 });
    const events = await db().select().from(auditEvents).where(and(eq(auditEvents.action, "journal.export.downloaded"), eq(auditEvents.targetId, exportJobId)));
    expect(events.map((e) => e.result).sort()).toEqual(["error", "error", "ok"]);
  });

  it("deletes expired export files", async () => {
    const space = await createSpace("export-expire");
    const { exportJobId } = await exportAll(space);
    const [file] = await db().select().from(exportFiles).where(eq(exportFiles.exportJobId, exportJobId));
    const r = await runExpireExports({}, testJobContext({ actor: { email: "system:journals.expire-exports" } }), new Date(Date.now() + 30 * 86_400_000));
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    await expect(stat(resolveInArea("exports", file!.path))).rejects.toThrow();
    const [after] = await db().select().from(exportFiles).where(eq(exportFiles.id, file!.id));
    expect(after!.deletedAt).not.toBeNull();
    const [job] = await db().select().from(exportJobs).where(eq(exportJobs.id, exportJobId));
    expect(job!.status).toBe("expired");
  });

  it("imports an export zip back to identical rows, and skips a duplicate upload", async () => {
    const source = await createSpace("import-source");
    const { exportJobId } = await exportAll(source);
    const bytes = await exportZipBytes(exportJobId);

    const target = await createSpace("import-target");
    const parseMarkdown = vi.fn<ParseMarkdown>(() => {
      throw new Error("an export zip is imported from its raw JSON, not its markdown");
    });
    const first = await importBytes(target, "test-journals.zip", bytes, parseMarkdown);
    expect(first.row.status).toBe("succeeded");
    expect(first.report.format).toBe("export-zip");
    expect(first.report.totals).toMatchObject({ imported: tasksFx.tasks.length, failed: 0, records: 113 });
    expect(parseMarkdown).not.toHaveBeenCalled();

    expect(await cachedRows(target.id)).toEqual(await cachedRows(source.id));
    const imported = await db().select().from(journalTasks).where(eq(journalTasks.spaceId, target.id));
    expect(imported.every((t) => t.source === "import" && t.importId === first.importId && t.importPath?.startsWith("raw/"))).toBe(true);

    const second = await importBytes(target, "copy-of-test-journals.zip", bytes);
    expect(second.row.status).toBe("duplicate");
    expect(second.report.duplicateOf).toBe(first.importId);
    const tasksAfter = await db().select().from(journalTasks).where(eq(journalTasks.spaceId, target.id));
    expect(tasksAfter).toHaveLength(tasksFx.tasks.length);
    expect(tasksAfter.every((t) => t.importId === first.importId)).toBe(true);

    const actions = (await db().select().from(auditEvents).where(eq(auditEvents.spaceId, target.id))).map((e) => e.action);
    expect(actions.filter((a) => a === "journal.import.requested")).toHaveLength(2);
    expect(actions.filter((a) => a === "journal.import.completed")).toHaveLength(2);
  });

  it("imports markdown journals from a folder zip and lists ground truth files without importing them", async () => {
    const space = await createSpace("import-folder", { incidentIdRule: { regex: "(INCIDENT-\\d+)", field: "title" } });
    const dir = "benchmark_incidents/INCIDENT-31744";
    const z = new JSZip();
    z.file(`${dir}/INCIDENT-31744_full_journal.md`, "# Journal Log: INCIDENT-31744\n\n\n---\n## Record: message\n**Created:** 2026-10-19 01:02:03+00:00\n\n\nHello\n");
    z.file(`${dir}/31744_actual_rca.md`, "# RCA");
    z.file(`${dir}/INCIDENT-31744_scorecard.md`, "# Scorecard");
    z.file(`${dir}/INCIDENT-31744_devops_journal.md`, "# other");
    const bytes = await z.generateAsync({ type: "nodebuffer" });

    const parseMarkdown = vi.fn<ParseMarkdown>((_text, _policy, opts) => ({
      format: "record-heading",
      task: {
        taskId: `import-${opts.sourceSha256.slice(0, 12)}`,
        incidentId: opts.incidentIdHint ?? null,
        title: "INCIDENT-31744",
        taskType: null,
        status: null,
        priority: null,
        reference: null,
        createdAt: null,
        updatedAt: null,
        raw: null,
      },
      executions: [],
      records: [
        {
          recordId: `rec-${opts.sourceSha256.slice(0, 12)}-1`,
          executionId: "imported",
          taskId: `import-${opts.sourceSha256.slice(0, 12)}`,
          seq: 1,
          recordType: "message",
          createdAt: new Date("2026-10-19T01:02:03Z"),
          content: { kind: "markdown", text: "Hello" },
          raw: { block: "Hello" },
        },
      ],
      warnings: [],
    }));

    const { importId, report, row } = await importBytes(space, "nov.zip", bytes, parseMarkdown);
    expect(row.status).toBe("succeeded");
    expect(parseMarkdown).toHaveBeenCalledTimes(1);
    expect(parseMarkdown.mock.calls[0]?.[2]).toMatchObject({ fileName: `${dir}/INCIDENT-31744_full_journal.md`, incidentIdHint: "INCIDENT-31744" });
    const byPath = new Map(report.files.map((f) => [f.path, f.outcome]));
    expect(byPath.get(`${dir}/INCIDENT-31744_full_journal.md`)).toBe("imported");
    expect(byPath.get(`${dir}/31744_actual_rca.md`)).toBe("ground-truth");
    expect(byPath.get(`${dir}/INCIDENT-31744_scorecard.md`)).toBe("ground-truth");
    expect(byPath.get(`${dir}/INCIDENT-31744_devops_journal.md`)).toBe("ignored");
    expect(report.totals).toMatchObject({ imported: 1, groundTruth: 2, ignored: 1, failed: 0, records: 1 });

    const [task] = await db().select().from(journalTasks).where(eq(journalTasks.spaceId, space.id));
    expect(task).toMatchObject({ source: "import", importId, incidentId: "INCIDENT-31744", importPath: `${dir}/INCIDENT-31744_full_journal.md` });
    const records = await db().select().from(journalRecords).where(eq(journalRecords.spaceId, space.id));
    expect(records).toHaveLength(1);
  });

  it("imports a single markdown file", async () => {
    const space = await createSpace("import-markdown");
    const parseMarkdown = vi.fn<ParseMarkdown>((_text, _policy, opts) => ({
      format: "record-heading",
      task: { taskId: "md-task", incidentId: opts.incidentIdHint ?? null, title: null, taskType: null, status: null, priority: null, reference: null, createdAt: null, updatedAt: null, raw: null },
      executions: [],
      records: [],
      warnings: ["no records found"],
    }));
    const { report, row } = await importBytes(space, "INCIDENT-31494-journal.md", Buffer.from("# Journal Log: INCIDENT-31494\n\n"), parseMarkdown);
    expect(row).toMatchObject({ status: "succeeded", format: "markdown" });
    expect(report.files[0]).toMatchObject({ outcome: "imported", taskId: "md-task", incidentId: "INCIDENT-31494", warnings: ["no records found"] });
  });

  it("rejects a zip with a '..' entry before reading anything", async () => {
    const space = await createSpace("import-zip-slip");
    const z = new JSZip();
    z.file("xx/evil_full_journal.md", "x", { createFolders: false });
    const safe = await z.generateAsync({ type: "nodebuffer" });
    // JSZip refuses to write ".." names, so write a same-length safe name and patch the bytes.
    const bytes = Buffer.from(safe.toString("latin1").replaceAll("xx/evil", "../evil"), "latin1");
    const parseMarkdown = vi.fn<ParseMarkdown>();
    const { report, row } = await importBytes(space, "evil.zip", bytes, parseMarkdown);
    expect(row.status).toBe("failed");
    expect((report as ImportReport).error).toMatch(/".." segment/);
    expect(parseMarkdown).not.toHaveBeenCalled();
    expect(await db().select().from(journalTasks).where(eq(journalTasks.spaceId, space.id))).toHaveLength(0);
  });

  it("lists investigations with their own execution and record counts, and multi-value filters", async () => {
    const space = await createSpace("list-filters");
    await exportAll(space);
    // Other spaces in this database hold executions and records too; none of them may leak into the counts.
    const all = await listInvestigations(space.id, { page: 1 }, 50);
    expect(all.total).toBe(tasksFx.tasks.length);
    expect(all.rows.find((r) => r.taskId === TASK_ID)).toMatchObject({ executionCount: 1, recordCount: 113 });
    expect(all.rows.filter((r) => r.taskId !== TASK_ID).every((r) => r.executionCount === 0 && r.recordCount === 0)).toBe(true);

    expect((await listInvestigations(space.id, { page: 1, statuses: ["COMPLETED", "FAILED"] }, 50)).total).toBe(tasksFx.tasks.length);
    expect((await listInvestigations(space.id, { page: 1, statuses: ["FAILED"] }, 50)).total).toBe(0);
    expect((await listInvestigations(space.id, { page: 1, taskTypes: ["SYSTEM_LEARNING"], sources: ["api"] }, 50)).total).toBe(tasksFx.tasks.length);
    expect((await listInvestigations(space.id, { page: 1, sources: ["import"] }, 50)).total).toBe(0);
    const created = new Date("2026-10-23T18:28:25.982Z");
    const one = await listInvestigations(space.id, { page: 1, createdFrom: created, createdBefore: new Date(created.getTime() + 1) }, 50);
    expect(one.rows.map((r) => r.taskId)).toEqual([TASK_ID]);
    expect(await journalCounts(space.id)).toEqual({ investigations: tasksFx.tasks.length, exports: 1, imports: 0 });
  });
});
