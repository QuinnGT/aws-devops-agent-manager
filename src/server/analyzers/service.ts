import { z } from "zod";
import type { JournalBundle } from "@/lib/journal/types";
import type { Actor } from "@/server/aws/clients";
import { recordAuditEvent } from "@/server/audit-log";
import { HistoryRepo } from "@/server/git/history-repo";
import type { JobContext } from "@/server/jobs/registry";
import { getAppPolicy, getPolicyForRepo, type Policy } from "@/server/policy";
import { getHistoryRepoForSpace, getSpaceById } from "@/server/spaces/queries";
import { normalizeBundle } from "./normalize";
import { ANALYZER_IDS, JOURNAL_ONLY_ANALYZERS, bundleDigest, getAnalyzer, inputDigestFor } from "./registry";
import { existingTaskIds, hasRun, insertRun, loadJournalBundle } from "./store";
import type { AnalyzerContext } from "./types";

export const packageFileSchema = z.object({
  assetType: z.string().min(1).max(100),
  name: z.string().min(1).max(500),
  path: z.string().min(1).max(1000),
  body: z.string().max(2_000_000),
});

export const analyzersRunInput = z.object({
  spaceId: z.string().uuid(),
  taskIds: z.array(z.string().min(1).max(300)).min(1).max(2000),
  /** Defaults to every analyzer that needs only the journal */
  analyzers: z.array(z.enum(ANALYZER_IDS)).min(1).optional(),
  /** Package files for the deployed-vs-read analyzer */
  package: z.object({ label: z.string().max(200), files: z.array(packageFileSchema).max(5000) }).optional(),
});

export type AnalyzersRunInput = z.output<typeof analyzersRunInput>;

export interface AnalyzersRunResult {
  tasks: number;
  ran: number;
  skipped: number;
  failed: number;
  missingTasks: string[];
  /** Analyzers left out because an input they need (a package) was not given */
  notApplicable: string[];
  errors: { taskId: string; analyzer: string; message: string }[];
  cancelled: boolean;
}

/** Policy for a space: app defaults overlaid with its history repository's policy directory. */
export async function policyForSpace(spaceId: string): Promise<Policy> {
  const space = await getSpaceById(spaceId);
  if (!space) throw new Error("Space not found");
  const repo = await getHistoryRepoForSpace(space);
  return repo ? getPolicyForRepo(HistoryRepo.workingDirFor(repo)).policy : getAppPolicy().policy;
}

/** Result of running analyzers over one investigation's bundle. */
export interface BundleAnalysis {
  /** bundleDigest of the bundle (the audit records it as journal_sha256) */
  bundleSha256: string;
  ran: number;
  skipped: number;
  failed: number;
  errors: { analyzer: string; message: string }[];
}

/**
 * Run analyzers over one loaded bundle and store their output (skipping a
 * rerun with the same version and input digest). Used by `analyzers.run` and
 * by the audits module, which needs the bundle digest per investigation.
 */
export async function analyzeBundle(
  spaceId: string,
  bundle: JournalBundle,
  ids: readonly string[],
  actx: AnalyzerContext,
  opts: { jobRunId: string | null; log?: JobContext["log"] },
): Promise<BundleAnalysis> {
  const taskId = bundle.task.taskId;
  const norm = normalizeBundle(bundle);
  const sha = bundleDigest(norm, bundle);
  const out: BundleAnalysis = { bundleSha256: sha, ran: 0, skipped: 0, failed: 0, errors: [] };
  for (const id of ids) {
    const a = getAnalyzer(id);
    const digest = inputDigestFor(a, sha, actx);
    if (await hasRun(spaceId, taskId, a.id, a.version, digest)) {
      out.skipped++;
      continue;
    }
    const started = Date.now();
    try {
      const output = a.run(norm, actx);
      const inserted = await insertRun({
        spaceId,
        taskId,
        analyzer: a.id,
        analyzerVersion: a.version,
        inputDigest: digest,
        output,
        jobRunId: opts.jobRunId && /^[0-9a-f-]{36}$/i.test(opts.jobRunId) ? opts.jobRunId : null,
        recordCount: norm.records.length,
        durationMs: Date.now() - started,
      });
      if (inserted) out.ran++;
      else out.skipped++;
    } catch (err) {
      out.failed++;
      const message = err instanceof Error ? err.message : String(err);
      out.errors.push({ analyzer: a.id, message: message.slice(0, 500) });
      opts.log?.(`analyzer ${a.id} failed on ${taskId}`, { message });
    }
  }
  return out;
}

/**
 * Job handler for `analyzers.run`. Reads each investigation from the journal
 * cache, runs the requested analyzers and stores their output. A rerun with
 * the same analyzer version and input digest is skipped.
 */
export async function runAnalyzersJob(
  input: AnalyzersRunInput,
  ctx: JobContext,
  deps: { policy?: AnalyzerContext["policy"] } = {},
): Promise<AnalyzersRunResult> {
  if (ctx.spaceId && ctx.spaceId !== input.spaceId) throw new Error("The job's space does not match its input");
  const policy = deps.policy ?? (await policyForSpace(input.spaceId));
  const actx: AnalyzerContext = { policy, packageFiles: input.package?.files ?? null };
  const requested = input.analyzers ?? JOURNAL_ONLY_ANALYZERS;
  const notApplicable = requested.filter((id) => getAnalyzer(id).requires.includes("package") && !input.package);
  const ids = requested.filter((id) => !notApplicable.includes(id));
  const result: AnalyzersRunResult = { tasks: input.taskIds.length, ran: 0, skipped: 0, failed: 0, missingTasks: [], notApplicable, errors: [], cancelled: false };

  const total = input.taskIds.length;
  for (const [i, taskId] of input.taskIds.entries()) {
    if (await ctx.cancelled()) {
      result.cancelled = true;
      break;
    }
    await ctx.progress(i / total, `Investigation ${i + 1} of ${total}`);
    const bundle = await loadJournalBundle(input.spaceId, taskId);
    if (!bundle) {
      result.missingTasks.push(taskId);
      continue;
    }
    const r = await analyzeBundle(input.spaceId, bundle, ids, actx, { jobRunId: ctx.runId, log: ctx.log });
    result.ran += r.ran;
    result.skipped += r.skipped;
    result.failed += r.failed;
    result.errors.push(...r.errors.map((e) => ({ taskId, ...e })));
  }
  await ctx.progress(1, `Ran ${result.ran}, skipped ${result.skipped} unchanged, ${result.failed} failed`);
  return result;
}

export class AnalyzerRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalyzerRequestError";
  }
}

/**
 * Starts an `analyzers.run` job. The caller has checked `audits.run` for this
 * space. Task IDs are checked against the space so a client cannot name
 * investigations from another space.
 */
export async function startAnalyzerRun(
  actor: Actor,
  spaceId: string,
  request: { taskIds: string[]; analyzers?: AnalyzersRunInput["analyzers"] },
  deps: { enqueue: (input: AnalyzersRunInput, opts: { actor: Actor; spaceId: string }) => Promise<string> },
): Promise<{ runId: string }> {
  const taskIds = [...new Set(request.taskIds)];
  const parsed = analyzersRunInput.safeParse({ spaceId, taskIds, analyzers: request.analyzers });
  if (!parsed.success) throw new AnalyzerRequestError("Choose between 1 and 2000 investigations and known analyzers");
  const known = await existingTaskIds(spaceId, taskIds);
  const unknown = taskIds.filter((t) => !known.has(t));
  if (unknown.length) throw new AnalyzerRequestError(`${unknown.length} investigation(s) are not in this space`);
  const runId = await deps.enqueue(parsed.data, { actor, spaceId });
  await recordAuditEvent({
    actor,
    action: "analyzers.run",
    spaceId,
    targetType: "job_run",
    targetId: runId,
    details: { tasks: taskIds.length, analyzers: parsed.data.analyzers ?? JOURNAL_ONLY_ANALYZERS },
  });
  return { runId };
}
