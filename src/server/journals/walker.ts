import {
  GetBacklogTaskCommand,
  ListBacklogTasksCommand,
  ListExecutionsCommand,
  ListJournalRecordsCommand,
  type DevOpsAgentClient,
  type ListBacklogTasksRequest,
  type ListExecutionsRequest,
  type ListJournalRecordsRequest,
} from "@aws-sdk/client-devops-agent";
import type { StoredExecution, StoredRecord, StoredTask } from "@/lib/journal/types";
import { mapLimit, pages } from "@/server/aws/paginate";
import { extractIncidentIdLocal, type IncidentIdRule } from "./incident-id";
import { isRawObject, toStoredExecution, toStoredRecord, toStoredTask, type RawObject } from "./normalize";
import { planListCalls, type ExportSelection } from "./selection";

/**
 * Walks ListBacklogTasks, then ListExecutions per task, then
 * ListJournalRecords per execution in ascending order, following every
 * nextToken. Records are written to the store page by page; an execution is
 * marked complete after its last page, and a later walk skips it when it is
 * terminal and unchanged. Retries for throttling come from the SDK client
 * (adaptive retry, see src/server/aws/clients.ts).
 */

export type AgentClient = Pick<DevOpsAgentClient, "send">;

export interface ExecutionCacheState {
  recordsComplete: boolean;
  updatedAt: Date | null;
  status: string | null;
  recordCount: number | null;
}

export interface JournalStore {
  upsertTask(task: StoredTask): Promise<void>;
  getExecutionState(executionId: string): Promise<ExecutionCacheState | null>;
  upsertExecution(exec: StoredExecution): Promise<void>;
  upsertRecords(records: StoredRecord[]): Promise<void>;
  markExecutionComplete(executionId: string, recordCount: number): Promise<void>;
}

export interface WalkOptions {
  agentSpaceId: string;
  /** Page size for ListBacklogTasks and ListJournalRecords (1-100) */
  pageSize: number;
  executionConcurrency: number;
  terminalStatuses: readonly string[];
  cancelled?: () => Promise<boolean>;
}

export class CancelledError extends Error {
  constructor() {
    super("The export was cancelled");
    this.name = "CancelledError";
  }
}

export interface SelectedTasks {
  tasks: RawObject[];
  /** Task IDs that GetBacklogTask did not find */
  notFound: string[];
  /** Incident IDs that matched no task */
  unmatchedIncidentIds: string[];
  /** ListBacklogTasks walks made */
  listCalls: number;
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && (err.name === "ResourceNotFoundException" || (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404);
}

export class PaginationLoopError extends Error {
  constructor(operation: string) {
    super(`${operation} returned a nextToken it had already returned; stopping instead of looping`);
    this.name = "PaginationLoopError";
  }
}

/** pages(), refusing a nextToken that repeats, so a bad response can never loop forever. */
async function* checkedPages<Req extends { nextToken?: string }, Res extends { nextToken?: string }>(
  operation: string,
  call: (req: Req) => Promise<Res>,
  request: Req,
): AsyncGenerator<Res> {
  const seen = new Set<string>();
  for await (const page of pages(call, request)) {
    if (page.nextToken) {
      if (seen.has(page.nextToken)) throw new PaginationLoopError(operation);
      seen.add(page.nextToken);
    }
    yield page;
  }
}

async function listTasks(client: AgentClient, req: ListBacklogTasksRequest): Promise<RawObject[]> {
  const out: RawObject[] = [];
  for await (const page of checkedPages("ListBacklogTasks", (r: ListBacklogTasksRequest) => client.send(new ListBacklogTasksCommand(r)), req)) {
    for (const t of page.tasks ?? []) if (isRawObject(t)) out.push(t as RawObject);
  }
  return out;
}

/** Resolve a selection to the raw task objects to export, in createdAt order (oldest first). */
export async function selectTasks(
  client: AgentClient,
  selection: ExportSelection,
  opts: Pick<WalkOptions, "agentSpaceId" | "pageSize"> & { incidentRule: IncidentIdRule | null },
): Promise<SelectedTasks> {
  const byId = new Map<string, RawObject>();
  const result: SelectedTasks = { tasks: [], notFound: [], unmatchedIncidentIds: [], listCalls: 0 };

  if (selection.mode === "taskIds") {
    for (const taskId of selection.taskIds) {
      try {
        const res = await client.send(new GetBacklogTaskCommand({ agentSpaceId: opts.agentSpaceId, taskId }));
        if (isRawObject(res.task)) byId.set(taskId, res.task as RawObject);
        else result.notFound.push(taskId);
      } catch (err) {
        if (isNotFound(err)) result.notFound.push(taskId);
        else throw err;
      }
    }
  } else {
    if (selection.mode === "incidentIds" && !opts.incidentRule) {
      throw new Error("This space has no incident ID rule. An Admin can set one in the space settings, or export by task ID instead.");
    }
    const plan = planListCalls(selection);
    for (const filter of plan.filters) {
      result.listCalls++;
      const tasks = await listTasks(client, {
        agentSpaceId: opts.agentSpaceId,
        limit: opts.pageSize,
        // Task type, status and priority values are open strings here; the API validates them.
        ...(Object.keys(filter).length ? { filter: filter as ListBacklogTasksRequest["filter"] } : {}),
      });
      for (const t of tasks) {
        if (plan.clientPriorities && !plan.clientPriorities.has(String(t.priority))) continue;
        if (typeof t.taskId === "string") byId.set(t.taskId, t);
      }
    }
    if (selection.mode === "incidentIds") {
      const wanted = new Set(selection.incidentIds);
      const found = new Set<string>();
      for (const [id, t] of byId) {
        const incident = extractIncidentIdLocal(t, opts.incidentRule);
        if (incident && wanted.has(incident)) found.add(incident);
        else byId.delete(id);
      }
      result.unmatchedIncidentIds = selection.incidentIds.filter((i) => !found.has(i));
    }
  }

  // createdAt is a Date from the SDK and a string in captured fixtures.
  result.tasks = [...byId.values()].sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt) || String(a.taskId).localeCompare(String(b.taskId)));
  return result;
}

function timeOf(v: unknown): number {
  const t = v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

export interface WalkTaskResult {
  taskId: string;
  executions: number;
  fetchedExecutions: number;
  cachedExecutions: number;
  recordsFetched: number;
}

function sameTime(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

/** True when the cached copy of an execution is complete and the service reports no change since. */
export function canSkipExecution(cached: ExecutionCacheState | null, live: StoredExecution, terminal: readonly string[]): boolean {
  if (!cached?.recordsComplete) return false;
  if (!live.status || !terminal.includes(live.status)) return false;
  return cached.status === live.status && sameTime(cached.updatedAt, live.updatedAt);
}

/** Walk one task's executions and records into the store. The task row must already be stored. */
export async function walkTask(client: AgentClient, task: StoredTask, store: JournalStore, opts: WalkOptions): Promise<WalkTaskResult> {
  const rawExecs: RawObject[] = [];
  for await (const page of checkedPages("ListExecutions", (r: ListExecutionsRequest) => client.send(new ListExecutionsCommand(r)), {
    agentSpaceId: opts.agentSpaceId,
    taskId: task.taskId,
  })) {
    for (const e of page.executions ?? []) if (isRawObject(e)) rawExecs.push(e as RawObject);
  }
  const executions = rawExecs.map((e) => toStoredExecution(e, task.taskId));
  const result: WalkTaskResult = { taskId: task.taskId, executions: executions.length, fetchedExecutions: 0, cachedExecutions: 0, recordsFetched: 0 };

  await mapLimit(executions, opts.executionConcurrency, async (exec) => {
    if (opts.cancelled && (await opts.cancelled())) throw new CancelledError();
    const cached = await store.getExecutionState(exec.executionId);
    if (canSkipExecution(cached, exec, opts.terminalStatuses)) {
      // Refresh metadata only; the records are already complete.
      await store.upsertExecution(exec);
      result.cachedExecutions++;
      return;
    }
    await store.upsertExecution(exec);
    let seq = 0;
    for await (const page of checkedPages("ListJournalRecords", (r: ListJournalRecordsRequest) => client.send(new ListJournalRecordsCommand(r)), {
      agentSpaceId: opts.agentSpaceId,
      executionId: exec.executionId,
      order: "ASC",
      limit: opts.pageSize,
    })) {
      const records = (page.records ?? []).filter(isRawObject).map((r) => toStoredRecord(r as unknown as RawObject, task.taskId, ++seq, exec.executionId));
      if (records.length) await store.upsertRecords(records);
    }
    await store.markExecutionComplete(exec.executionId, seq);
    result.fetchedExecutions++;
    result.recordsFetched += seq;
  });
  return result;
}

/** Turn a raw task into a StoredTask with the space's incident ID rule applied. */
export function storedTaskFromApi(raw: RawObject, rule: IncidentIdRule | null): StoredTask {
  return toStoredTask(raw, extractIncidentIdLocal(raw, rule), "api");
}
