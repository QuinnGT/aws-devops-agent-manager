import {
  DevOpsAgentClient,
  GetBacklogTaskCommand,
  ListBacklogTasksCommand,
  ListExecutionsCommand,
  ListJournalRecordsCommand,
  ResourceNotFoundException,
  type ListJournalRecordsRequest,
} from "@aws-sdk/client-devops-agent";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { apiFixture } from "../../../test/helpers/fixtures";
import { exportSelectionSchema } from "./selection";
import { memoryJournalStore } from "./test-support";
import { canSkipExecution, PaginationLoopError, selectTasks, storedTaskFromApi, walkTask, type WalkOptions } from "./walker";

/* eslint-disable @typescript-eslint/no-explicit-any */
const tasksFx = apiFixture<any>("ListBacklogTasks").response;
const getTaskFx = apiFixture<any>("GetBacklogTask").response;
const execsFx = apiFixture<any>("ListExecutions").response;
const page0 = apiFixture<any>("ListJournalRecords.exec0.page0").response;
const page1 = apiFixture<any>("ListJournalRecords.exec0.page1").response;
const TASK_ID = getTaskFx.task.taskId as string;
const EXEC_ID = execsFx.executions[0].executionId as string;
const SPACE = "00000000-0000-4000-8000-0000000000bb";

/** A ListBacklogTasks response built from partial tasks (the walker reads only a few fields). */
const tasksPage = (tasks: Record<string, unknown>[], nextToken?: string): any => ({ tasks, ...(nextToken ? { nextToken } : {}) });

const mock = mockClient(DevOpsAgentClient);
const client = new DevOpsAgentClient({ region: "us-west-2", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
const opts: WalkOptions = { agentSpaceId: SPACE, pageSize: 100, executionConcurrency: 2, terminalStatuses: ["STOPPED", "FAILED"] };

function mockJournal() {
  mock.on(ListExecutionsCommand).resolves({ executions: [] });
  mock.on(ListExecutionsCommand, { taskId: TASK_ID }).resolves(execsFx);
  mock.on(ListJournalRecordsCommand).callsFake((input: ListJournalRecordsRequest) => {
    if (input.executionId !== EXEC_ID) return { records: [] };
    return input.nextToken === page0.nextToken ? page1 : page0;
  });
}

beforeEach(() => {
  mock.reset();
});

describe("journal walker", () => {
  it("walks executions and every journal page in ascending order", async () => {
    mockJournal();
    const { store, records, executions } = memoryJournalStore();
    const task = storedTaskFromApi(getTaskFx.task, null);
    const r = await walkTask(client, task, store, opts);

    expect(r).toMatchObject({ executions: 1, fetchedExecutions: 1, cachedExecutions: 0, recordsFetched: page0.records.length + page1.records.length });
    const calls = mock.commandCalls(ListJournalRecordsCommand).map((c) => c.args[0].input);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ agentSpaceId: SPACE, executionId: EXEC_ID, order: "ASC", limit: 100 });
    expect(calls[0]?.nextToken).toBeUndefined();
    expect(calls[1]?.nextToken).toBe(page0.nextToken);

    const stored = [...records.values()].sort((a, b) => a.seq - b.seq);
    expect(stored).toHaveLength(113);
    expect(stored.map((x) => x.seq)).toEqual(Array.from({ length: 113 }, (_, i) => i + 1));
    expect(stored[0]?.recordId).toBe(page0.records[0].recordId);
    expect(stored[100]?.recordId).toBe(page1.records[0].recordId);
    // raw is exactly what the API returned; content is parsed.
    expect(stored[0]?.raw).toEqual(page0.records[0]);
    expect(stored[0]?.content.kind).toBe("json");
    const exec = executions.get(EXEC_ID);
    expect(exec?.complete).toBe(true);
    expect(exec?.exec).toMatchObject({ agentType: "systemLearning", agentSubTask: "systemLearning", status: "STOPPED", parentExecutionId: null });
  });

  it("skips an execution that is already fully cached and unchanged", async () => {
    mockJournal();
    const mem = memoryJournalStore();
    const task = storedTaskFromApi(getTaskFx.task, null);
    await walkTask(client, task, mem.store, opts);
    mock.resetHistory();
    const again = await walkTask(client, task, mem.store, opts);
    expect(again).toMatchObject({ fetchedExecutions: 0, cachedExecutions: 1, recordsFetched: 0 });
    expect(mock.commandCalls(ListJournalRecordsCommand)).toHaveLength(0);
  });

  it("fetches again when the execution changed or is still running", () => {
    const live = { executionId: "e", taskId: "t", parentExecutionId: null, agentType: null, agentSubTask: null, status: "STOPPED", createdAt: null, updatedAt: new Date(2), raw: {} };
    const cached = { recordsComplete: true, status: "STOPPED", updatedAt: new Date(2), recordCount: 3 };
    expect(canSkipExecution(cached, live, ["STOPPED"])).toBe(true);
    expect(canSkipExecution({ ...cached, updatedAt: new Date(1) }, live, ["STOPPED"])).toBe(false);
    expect(canSkipExecution({ ...cached, recordsComplete: false }, live, ["STOPPED"])).toBe(false);
    expect(canSkipExecution(cached, { ...live, status: "RUNNING" }, ["STOPPED"])).toBe(false);
    expect(canSkipExecution(null, live, ["STOPPED"])).toBe(false);
  });

  it("resumes after a failure part way through, refetching only the incomplete execution", async () => {
    mockJournal();
    let failed = false;
    mock.on(ListJournalRecordsCommand).callsFake((input: ListJournalRecordsRequest) => {
      if (input.nextToken && !failed) {
        failed = true;
        throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
      }
      return input.nextToken === page0.nextToken ? page1 : page0;
    });
    const mem = memoryJournalStore();
    const task = storedTaskFromApi(getTaskFx.task, null);
    await expect(walkTask(client, task, mem.store, opts)).rejects.toThrow("throttled");
    expect(mem.executions.get(EXEC_ID)?.complete).toBe(false);
    expect(mem.records.size).toBe(100);
    const r = await walkTask(client, task, mem.store, opts);
    expect(r.fetchedExecutions).toBe(1);
    expect(mem.records.size).toBe(113);
  });

  it("lists tasks with one call per filter value", async () => {
    // The captured page has a (redacted) nextToken; serve it as the last page.
    mock.on(ListBacklogTasksCommand).resolves({ ...tasksFx, nextToken: undefined });
    const sel = exportSelectionSchema.parse({ mode: "filter", from: "2026-08-01", to: "2026-10-31", statuses: ["COMPLETED", "FAILED"], taskTypes: ["SYSTEM_LEARNING"] });
    const r = await selectTasks(client, sel, { agentSpaceId: SPACE, pageSize: 100, incidentRule: null });
    const inputs = mock.commandCalls(ListBacklogTasksCommand).map((c) => c.args[0].input);
    expect(inputs).toHaveLength(2);
    expect(inputs.map((i) => i.filter?.status)).toEqual([["COMPLETED"], ["FAILED"]]);
    expect(inputs[0]?.filter).toMatchObject({ taskType: ["SYSTEM_LEARNING"], createdAfter: new Date("2026-08-01T00:00:00Z"), createdBefore: new Date("2026-11-01T00:00:00Z") });
    // Same tasks from both calls are kept once, oldest first.
    expect(r.tasks).toHaveLength(tasksFx.tasks.length);
    const times = r.tasks.map((t) => Date.parse(String(t.createdAt)));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("filters priority locally when status is set without a task type", async () => {
    mock.on(ListBacklogTasksCommand).resolves(tasksPage([{ taskId: "a", priority: "HIGH" }, { taskId: "b", priority: "LOW" }]));
    const sel = exportSelectionSchema.parse({ statuses: ["COMPLETED"], priorities: ["HIGH"] });
    const r = await selectTasks(client, sel, { agentSpaceId: SPACE, pageSize: 100, incidentRule: null });
    const input = mock.commandCalls(ListBacklogTasksCommand)[0]?.args[0].input;
    expect(input?.filter).toEqual({ status: ["COMPLETED"] });
    expect(r.tasks.map((t) => t.taskId)).toEqual(["a"]);
  });

  it("follows nextToken when listing tasks", async () => {
    mock
      .on(ListBacklogTasksCommand)
      .resolvesOnce(tasksPage([{ taskId: "a", createdAt: "2026-01-01T00:00:00Z" }], "n1"))
      .resolvesOnce(tasksPage([{ taskId: "b", createdAt: "2026-01-02T00:00:00Z" }]));
    const r = await selectTasks(client, exportSelectionSchema.parse({}), { agentSpaceId: SPACE, pageSize: 100, incidentRule: null });
    expect(r.tasks.map((t) => t.taskId)).toEqual(["a", "b"]);
    expect(mock.commandCalls(ListBacklogTasksCommand)[1]?.args[0].input.nextToken).toBe("n1");
  });

  it("stops when the service repeats a nextToken", async () => {
    mock.on(ListBacklogTasksCommand).resolves(tasksPage([{ taskId: "a" }], "same"));
    await expect(selectTasks(client, exportSelectionSchema.parse({}), { agentSpaceId: SPACE, pageSize: 100, incidentRule: null })).rejects.toThrow(PaginationLoopError);
    expect(mock.commandCalls(ListBacklogTasksCommand)).toHaveLength(2);
  });

  it("gets tasks by ID and reports IDs that are not found", async () => {
    mock.on(GetBacklogTaskCommand, { taskId: TASK_ID }).resolves(getTaskFx);
    mock.on(GetBacklogTaskCommand, { taskId: "missing" }).rejects(new ResourceNotFoundException({ message: "no", $metadata: {} }));
    const r = await selectTasks(client, exportSelectionSchema.parse({ mode: "taskIds", taskIds: [TASK_ID, "missing"] }), { agentSpaceId: SPACE, pageSize: 100, incidentRule: null });
    expect(r.tasks.map((t) => t.taskId)).toEqual([TASK_ID]);
    expect(r.notFound).toEqual(["missing"]);
  });

  it("resolves incident IDs through the space's rule", async () => {
    mock.on(ListBacklogTasksCommand).resolves(
      tasksPage([
        { taskId: "t1", title: "INCIDENT-31744: orders", createdAt: "2026-10-19T00:00:00Z" },
        { taskId: "t2", title: "INCIDENT-31801: other", createdAt: "2026-10-20T00:00:00Z" },
        { taskId: "t3", title: "no incident", createdAt: "2026-10-21T00:00:00Z" },
      ]),
    );
    const sel = exportSelectionSchema.parse({ mode: "incidentIds", incidentIds: ["INCIDENT-31744", "INCIDENT-99999"] });
    const r = await selectTasks(client, sel, { agentSpaceId: SPACE, pageSize: 100, incidentRule: { regex: "(INCIDENT-\\d+)", field: "title" } });
    expect(r.tasks.map((t) => t.taskId)).toEqual(["t1"]);
    expect(r.unmatchedIncidentIds).toEqual(["INCIDENT-99999"]);
    await expect(selectTasks(client, sel, { agentSpaceId: SPACE, pageSize: 100, incidentRule: null })).rejects.toThrow(/no incident ID rule/);
  });
});
