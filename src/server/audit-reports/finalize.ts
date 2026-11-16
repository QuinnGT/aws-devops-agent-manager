import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { TRAILERS } from "@/lib/assets/types";
import { recordAuditEvent } from "@/server/audit-log";
import { db } from "@/server/db/client";
import { analyzerRuns, modelCalls, reviews } from "@/server/db/schema";
import { assertWorker, HistoryRepo } from "@/server/git/history-repo";
import { fillTemplate, safeSegment } from "@/server/history/layout";
import type { JobContext } from "@/server/jobs/registry";
import { getPolicyForRepo, type Policy } from "@/server/policy";
import { getHistoryRepoForSpace, getSpaceById, toHistoryRepoConfig, type SpaceRow } from "@/server/spaces/queries";
import { AuditReportError } from "./errors";
import { loadReportContext, type ReportContext } from "./loader";
import { buildAuditManifest, buildFindingsJson, toFileJson, type FindingsJsonFinding, type ManifestAnalyzerRun, type ManifestReview } from "./manifest";
import { getAuditInSpace } from "./queries";
import { renderReportMarkdown } from "./report-md";
import { markFinalized } from "./store";
import { acceptedFindings } from "./view";

/**
 * Finalize: commit audit.json, findings.json and
 * report.md under historyLayout.auditDir in one commit with an Audit-Id
 * trailer, push, then mark the audit finalized with the commit. Worker only.
 * Allowed when every item is reviewed or skipped and no finding is still
 * proposed. A retried job finds its own commit by the trailer and finishes
 * instead of committing twice.
 */

export const AUDIT_TRAILERS = { auditId: "Audit-Id", profile: "Audit-Profile" } as const;
export const AUDIT_FILES = { auditJson: "audit.json", findingsJson: "findings.json", reportMd: "report.md" } as const;

export const finalizeAuditInput = z.object({ spaceId: z.string().uuid(), auditId: z.string().uuid() });
export type FinalizeAuditInput = z.output<typeof finalizeAuditInput>;

export interface FinalizeAuditResult {
  auditId: string;
  commit: string;
  dir: string;
  pushed: boolean;
  pushError?: string;
  /** An earlier attempt had already committed (or finalized) the audit */
  resumed: boolean;
}

export function auditDirFor(layout: Policy["historyLayout"], spaceAlias: string, auditId: string): string {
  return fillTemplate(layout.auditDir, { spaceAlias: safeSegment(spaceAlias), auditId: safeSegment(auditId) });
}

/**
 * Check that the audit can be finalized now. The Server Action
 * checks `audits.run` for the space, calls this, then enqueues the job.
 */
export async function prepareFinalizeAudit(input: z.input<typeof finalizeAuditInput>): Promise<FinalizeAuditInput> {
  const parsed = finalizeAuditInput.parse(input);
  const space = await getSpaceById(parsed.spaceId);
  if (!space) throw new AuditReportError("Space not found.", "not-found");
  if (!space.historyRepoId) throw new AuditReportError("This space has no history repository. An Admin can set one in the space settings.", "no-repo");
  const rc = await loadReportContext(space, parsed.auditId);
  if (!rc) throw new AuditReportError("Audit not found.", "not-found");
  if (!rc.view.finalize.allowed) throw new AuditReportError(rc.view.finalize.problems[0]!, "not-ready", rc.view.finalize.problems);
  return parsed;
}

async function loadReviews(auditId: string): Promise<ManifestReview[]> {
  const rows = await db()
    .select({
      id: reviews.id,
      auditItemId: reviews.auditItemId,
      runner: reviews.runner,
      modelId: reviews.modelId,
      promptDigest: reviews.promptDigest,
      state: reviews.state,
      schemaValid: reviews.schemaValid,
      citationCheck: reviews.citationCheck,
      startedAt: reviews.startedAt,
    })
    .from(reviews)
    .where(eq(reviews.auditId, auditId));
  return rows.map((r) => ({ ...r, citationCheck: r.citationCheck ? { checked: r.citationCheck.checked, failed: r.citationCheck.failed, ok: r.citationCheck.ok } : null }));
}

async function loadAnalyzerRuns(spaceId: string, taskIds: string[], analyzerIds: string[]): Promise<ManifestAnalyzerRun[]> {
  if (!taskIds.length || !analyzerIds.length) return [];
  return db()
    .select({ taskId: analyzerRuns.taskId, analyzer: analyzerRuns.analyzer, version: analyzerRuns.analyzerVersion, createdAt: analyzerRuns.createdAt })
    .from(analyzerRuns)
    .where(and(eq(analyzerRuns.spaceId, spaceId), inArray(analyzerRuns.taskId, taskIds), inArray(analyzerRuns.analyzer, analyzerIds)));
}

async function narrativeModelIds(auditId: string): Promise<string[]> {
  const rows = await db()
    .selectDistinct({ modelId: modelCalls.modelId })
    .from(modelCalls)
    .where(and(eq(modelCalls.auditId, auditId), eq(modelCalls.purpose, "report-narrative")));
  return rows.map((r) => r.modelId);
}

/** The three files, as they are committed. */
export async function buildFinalizeFiles(space: SpaceRow, rc: ReportContext, actor: { email: string }, at: Date): Promise<{ auditJson: string; findingsJson: string; reportMd: string }> {
  const { audit, profile, data, view } = rc;
  const records = new Map(data.findings.map((f) => [f.id, f]));
  const accepted: FindingsJsonFinding[] = acceptedFindings(data.items, data.findings).map((f) => ({ ...f, proposed: records.get(f.id)?.proposed, reviewNote: records.get(f.id)?.reviewNote ?? null }));
  const manifest = buildAuditManifest({
    audit,
    spaceAlias: space.alias,
    profile,
    items: data.items,
    reviews: await loadReviews(audit.id),
    analyzerRuns: await loadAnalyzerRuns(space.id, [...new Set(data.items.map((i) => i.taskId))], profile.analyzers),
    counts: view.counts,
    draft: audit.report ?? null,
    stale: view.stale,
    narrativeModelIds: await narrativeModelIds(audit.id),
    finalizedBy: actor.email,
    finalizedAt: at,
    files: AUDIT_FILES,
  });
  return {
    auditJson: toFileJson(manifest),
    findingsJson: toFileJson(buildFindingsJson(audit.id, accepted)),
    reportMd: renderReportMarkdown(view, "internal", at),
  };
}

/** Worker handler for audit-reports.finalize. */
export async function finalizeAuditHandler(input: FinalizeAuditInput, ctx: JobContext): Promise<FinalizeAuditResult> {
  try {
    return await finalizeAudit(input, ctx);
  } catch (err) {
    if (err instanceof AuditReportError) {
      await recordAuditEvent({
        actor: ctx.actor,
        action: "audit.finalize",
        spaceId: input.spaceId,
        targetType: "audit",
        targetId: input.auditId,
        result: "error",
        details: { error: err.message, problems: err.problems },
      });
    }
    throw err;
  }
}

async function finalizeAudit(input: FinalizeAuditInput, ctx: JobContext): Promise<FinalizeAuditResult> {
  assertWorker("finalize an audit");
  const space = await getSpaceById(input.spaceId);
  if (!space) throw new AuditReportError("Space not found.", "not-found");
  const first = await getAuditInSpace(space.id, input.auditId);
  if (!first) throw new AuditReportError("Audit not found.", "not-found");
  const repoRow = await getHistoryRepoForSpace(space);
  if (!repoRow) throw new AuditReportError("This space has no history repository. An Admin can set one in the space settings.", "no-repo");
  const repo = await HistoryRepo.open(toHistoryRepoConfig(repoRow));
  const policy = getPolicyForRepo(repo.dir);
  const dir = auditDirFor(policy.policy.historyLayout, space.alias, first.id);

  if (first.state === "finalized" && first.finalizedCommit) {
    return { auditId: first.id, commit: first.finalizedCommit, dir, pushed: false, resumed: true };
  }
  await ctx.progress(0.05, "Checking the audit");
  const rc = await loadReportContext(space, first.id, policy);
  if (!rc) throw new AuditReportError("Audit not found.", "not-found");

  // A commit from an earlier attempt that failed before the audit row was updated
  const prior = (await repo.log({ path: dir, maxCount: 50 })).find((c) => c.trailers[AUDIT_TRAILERS.auditId] === first.id);
  let commit: string;
  let at: Date;
  let resumed = false;
  if (prior) {
    commit = prior.hash;
    at = new Date(prior.date);
    resumed = true;
  } else {
    if (!rc.view.finalize.allowed) throw new AuditReportError(rc.view.finalize.problems[0]!, "not-ready", rc.view.finalize.problems);
    at = new Date();
    await ctx.progress(0.3, "Writing audit.json, findings.json and report.md");
    const files = await buildFinalizeFiles(space, rc, ctx.actor, at);
    const { report } = rc.profile;
    await ctx.progress(0.6, "Committing");
    const made = await repo.writeAndCommit(
      [
        { path: path.posix.join(dir, AUDIT_FILES.auditJson), content: files.auditJson },
        { path: path.posix.join(dir, AUDIT_FILES.findingsJson), content: files.findingsJson },
        { path: path.posix.join(dir, AUDIT_FILES.reportMd), content: files.reportMd },
      ],
      {
        message: fillTemplate(report.commitMessage, { auditName: rc.audit.name.replace(/\s+/g, " ").trim(), spaceAlias: space.alias, auditId: rc.audit.id }),
        author: { name: ctx.actor.email, email: ctx.actor.email },
        committer: report.committer,
        date: at,
        trailers: { [AUDIT_TRAILERS.auditId]: rc.audit.id, [AUDIT_TRAILERS.profile]: rc.audit.profileId, [TRAILERS.spaceAlias]: space.alias },
        allowEmpty: true,
      },
    );
    if (!made) throw new Error("The audit commit was not created.");
    commit = made;
  }

  await ctx.progress(0.85, "Pushing");
  let pushed = false;
  let pushError: string | undefined;
  try {
    pushed = await repo.push();
  } catch (err) {
    // The audit is committed locally; the next push carries it.
    pushError = err instanceof Error ? err.message.slice(0, 300) : String(err);
    ctx.log("push failed after finalizing an audit", { error: pushError });
  }

  const marked = await markFinalized(rc.audit.id, commit, ctx.actor, at);
  if (!marked) {
    const now = await getAuditInSpace(space.id, rc.audit.id);
    if (now?.finalizedCommit && now.finalizedCommit !== commit) {
      return { auditId: rc.audit.id, commit: now.finalizedCommit, dir, pushed, ...(pushError ? { pushError } : {}), resumed: true };
    }
  }
  await recordAuditEvent({
    actor: ctx.actor,
    action: "audit.finalize",
    spaceId: space.id,
    targetType: "audit",
    targetId: rc.audit.id,
    details: { commit, dir, pushed, ...(pushError ? { pushError } : {}), resumed, counts: rc.view.counts.findings, stale: rc.view.stale },
  });
  await ctx.progress(1, "Audit finalized");
  return { auditId: rc.audit.id, commit, dir, pushed, ...(pushError ? { pushError } : {}), resumed };
}
