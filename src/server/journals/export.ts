import { eq } from "drizzle-orm";
import { z } from "zod";
import { mapLimit } from "@/server/aws/paginate";
import { devOpsAgentClient, type Actor } from "@/server/aws/clients";
import { recordAuditEvent } from "@/server/audit-log";
import { db } from "@/server/db/client";
import { exportFiles, exportJobs } from "@/server/db/schema";
import { enqueue } from "@/server/jobs/enqueue";
import { defineJob, type JobContext } from "@/server/jobs/registry";
import { getSpaceById, toAwsConfig, type Space } from "@/server/spaces/queries";
import { buildExportZip, writeZipFile } from "./export-zip";
import { assertValidRule } from "./incident-id";
import { ensureAreaDir, resolveInArea, safeFileName } from "./paths";
import { policyForSpace } from "./policy";
import { describeSelection, exportSelectionSchema, type ExportSelection } from "./selection";
import { dbJournalStore, loadBundle } from "./store";
import { templateSetFor } from "./templates/load";
import { CancelledError, selectTasks, storedTaskFromApi, walkTask, type AgentClient, type WalkTaskResult } from "./walker";

/** Journal export: request (web), the `journals.export` job (worker), and its result. */

export class ExportRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportRequestError";
  }
}

export const exportJobInput = z.object({ exportJobId: z.string().uuid() });

export interface ExportDeps {
  /** Tests pass a client whose `send` is mocked */
  client?: AgentClient;
  now?: () => Date;
}

export interface ExportResult {
  exportJobId: string;
  status: "succeeded" | "cancelled" | "already-done";
  taskCount: number;
  recordCount: number;
  fileName?: string;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
}

export async function runExport(input: z.output<typeof exportJobInput>, ctx: JobContext, deps: ExportDeps = {}): Promise<ExportResult> {
  const now = deps.now ?? (() => new Date());
  const [job] = await db().select().from(exportJobs).where(eq(exportJobs.id, input.exportJobId));
  if (!job) throw new Error(`export job ${input.exportJobId} not found`);
  if (job.status === "succeeded") return { exportJobId: job.id, status: "already-done", taskCount: job.taskCount ?? 0, recordCount: job.recordCount ?? 0 };
  const space = await getSpaceById(job.spaceId);
  if (!space) throw new Error(`space ${job.spaceId} not found`);

  const audit = (result: "ok" | "error", details: Record<string, unknown>) =>
    recordAuditEvent({ actor: ctx.actor, action: "journal.export.completed", spaceId: space.id, targetType: "export_job", targetId: job.id, result, details });

  await db().update(exportJobs).set({ status: "running", error: null }).where(eq(exportJobs.id, job.id));
  try {
    const loaded = await policyForSpace(space);
    const pol = loaded.policy;
    const templates = templateSetFor(loaded);
    const selection: ExportSelection = exportSelectionSchema.parse(job.selection);
    const rule = space.parsedSettings.incidentIdRule;
    if (rule) assertValidRule(rule);
    const client = deps.client ?? devOpsAgentClient(toAwsConfig(space), "read", ctx.actor);

    await ctx.progress(0.02, "Finding investigations");
    const selected = await selectTasks(client, selection, { agentSpaceId: space.agentSpaceId, pageSize: pol.api.pageSize, incidentRule: rule });
    const store = dbJournalStore(space.id);
    const total = selected.tasks.length;
    const walked: WalkTaskResult[] = [];
    await ctx.progress(0.05, `Found ${total} investigation(s)`);

    await mapLimit(selected.tasks, pol.journals.exportConcurrency, async (raw) => {
      if (await ctx.cancelled()) throw new CancelledError();
      const task = storedTaskFromApi(raw, rule);
      await store.upsertTask(task);
      walked.push(
        await walkTask(client, task, store, {
          agentSpaceId: space.agentSpaceId,
          pageSize: pol.api.pageSize,
          executionConcurrency: pol.journals.executionConcurrency,
          terminalStatuses: pol.journals.terminalExecutionStatuses,
          cancelled: () => ctx.cancelled(),
        }),
      );
      await ctx.progress(0.05 + 0.85 * (walked.length / Math.max(1, total)), `Walked ${walked.length} of ${total} investigation(s)`);
    });

    await ctx.progress(0.92, "Writing the zip file");
    const bundles = [];
    for (const raw of selected.tasks) {
      const b = await loadBundle(space.id, String(raw.taskId));
      if (b) bundles.push(b);
    }
    const exportedAt = now();
    const { zip } = buildExportZip({ bundles, templates, spaceAlias: space.alias, agentSpaceId: space.agentSpaceId, exportedAt });
    ensureAreaDir("exports");
    const relPath = `${job.id}.zip`;
    const fileName = `${safeFileName(space.alias, "space")}-journals-${stamp(exportedAt)}.zip`;
    const { sizeBytes, sha256 } = await writeZipFile(zip, resolveInArea("exports", relPath));
    const recordCount = bundles.reduce((n, b) => n + b.records.length, 0);
    const expiresAt = new Date(exportedAt.getTime() + pol.journals.exportRetentionDays * 86_400_000);
    const summary = {
      selection: describeSelection(selection),
      listCalls: selected.listCalls,
      notFoundTaskIds: selected.notFound,
      unmatchedIncidentIds: selected.unmatchedIncidentIds,
      executions: walked.reduce((n, w) => n + w.executions, 0),
      fetchedExecutions: walked.reduce((n, w) => n + w.fetchedExecutions, 0),
      cachedExecutions: walked.reduce((n, w) => n + w.cachedExecutions, 0),
      recordsFetched: walked.reduce((n, w) => n + w.recordsFetched, 0),
    };

    await db().transaction(async (tx) => {
      await tx.insert(exportFiles).values({ exportJobId: job.id, path: relPath, fileName, sizeBytes, sha256 });
      await tx
        .update(exportJobs)
        .set({ status: "succeeded", taskCount: bundles.length, recordCount, expiresAt, summary, finishedAt: new Date() })
        .where(eq(exportJobs.id, job.id));
    });
    await audit("ok", { fileName, sha256, sizeBytes, taskCount: bundles.length, recordCount, ...summary });
    await ctx.progress(1, `Exported ${bundles.length} investigation(s)`);
    return { exportJobId: job.id, status: "succeeded", taskCount: bundles.length, recordCount, fileName };
  } catch (err) {
    if (err instanceof CancelledError) {
      await db().update(exportJobs).set({ status: "cancelled", finishedAt: new Date() }).where(eq(exportJobs.id, job.id));
      await audit("error", { cancelled: true });
      return { exportJobId: job.id, status: "cancelled", taskCount: 0, recordCount: 0 };
    }
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await db().update(exportJobs).set({ status: "failed", error: message.slice(0, 2000), finishedAt: new Date() }).where(eq(exportJobs.id, job.id));
    await audit("error", { error: message.slice(0, 500) });
    throw err;
  }
}

export const exportJob = defineJob({
  name: "journals.export",
  input: exportJobInput,
  options: { retryLimit: 2, retryDelay: 60, expireInSeconds: 6 * 60 * 60, localConcurrency: 2 },
  handler: (input, ctx) => runExport(input, ctx),
});

/** Called by the Server Action after the DAL check for `journals.export` on this space. */
export async function requestExport(space: Space, selectionInput: unknown, actor: Actor): Promise<{ exportJobId: string; runId: string }> {
  const parsed = exportSelectionSchema.safeParse(selectionInput);
  if (!parsed.success) throw new ExportRequestError(parsed.error.issues.map((i) => i.message).join("; "));
  const selection = parsed.data;
  const pol = (await policyForSpace(space)).policy;
  const max = pol.journals.selection.maxIds;
  if (selection.taskIds.length > max || selection.incidentIds.length > max) throw new ExportRequestError(`Enter at most ${max} IDs in one export.`);
  if (selection.mode === "incidentIds" && !space.parsedSettings.incidentIdRule) {
    throw new ExportRequestError("This space has no incident ID rule. An Admin can set one in the space settings, or export by task ID instead.");
  }
  const [row] = await db().insert(exportJobs).values({ spaceId: space.id, selection, status: "queued", createdBy: actor.email }).returning({ id: exportJobs.id });
  const exportJobId = row!.id;
  const runId = await enqueue(exportJob, { exportJobId }, { actor, spaceId: space.id });
  await db().update(exportJobs).set({ jobRunId: runId }).where(eq(exportJobs.id, exportJobId));
  await recordAuditEvent({
    actor,
    action: "journal.export.requested",
    spaceId: space.id,
    targetType: "export_job",
    targetId: exportJobId,
    details: { selection, runId },
  });
  return { exportJobId, runId };
}
