import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { auditEvents, jobRuns } from "@/server/db/schema";
import { plainErrorText } from "@/server/jobs/error-text";
import { getHistoryRepoForSpace, type Space } from "@/server/spaces/queries";
import { exportSections } from "./content";
import { auditDirFor } from "./finalize";
import { DRAFT_NARRATIVE_QUEUE, FINALIZE_QUEUE } from "./jobs";
import { loadReportContext } from "./loader";
import { reportModelOf, type ReportModel } from "./model";
import { AUDIENCES, type Audience, type ReportSectionView, type ReportView } from "./types";

/**
 * The Report tab's data beyond the report view (pages/audit-report.md): the
 * report model and where it came from, what finalize commits and where, what
 * each export audience includes, and per narrative section the latest model
 * draft, a failed draft and a draft in progress. The page calls
 * loadReportPage after checking `audits.read` for the space.
 */

export const NARRATIVE_DRAFT_ACTION = "audit.report.narrative-draft";

/** One audit.report.narrative-draft event. */
export interface DraftEvent {
  /** When the event was stored (database clock) */
  at: Date;
  /**
   * When the handler finished, on the app's clock (details.finishedAt). Section
   * edit times (`updatedAt`) are on the app's clock too, so a failure is compared
   * with an edit on this one; the database clock can run ahead of the app's.
   */
  appAt?: Date | null;
  result: "ok" | "error" | "denied";
  drafted: string[];
  failed: { id: string; error: string }[];
  modelId: string | null;
}

/** One audit-reports job of the audit (job_runs). */
export interface ReportJobRun {
  id: string;
  queue: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  /** Draft jobs: the sections asked for; empty means every narrative section */
  sectionIds: string[];
  /** Plain sentence */
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface SectionDraftInfo {
  /** The latest model draft that landed in the section */
  drafted: { at: string; modelId: string | null } | null;
  /** The latest draft attempt failed after the section's text last changed */
  failed: { at: string; error: string } | null;
  /** A draft job for the section is queued or running */
  runId: string | null;
}

const OPEN = new Set<ReportJobRun["status"]>(["queued", "running"]);
const targets = (job: ReportJobRun, sectionId: string) => job.queue === DRAFT_NARRATIVE_QUEUE && (job.sectionIds.length === 0 || job.sectionIds.includes(sectionId));
const later = (a: Date | null | undefined, b: Date | null | undefined) => (a ? !b || a.getTime() > b.getTime() : false);

/**
 * Per narrative section: the latest landed draft, a failure newer than the
 * section's text, and an open draft job. A job that failed before the handler
 * recorded its event (no model set, say) counts as a failure for every
 * section it targeted. Pure.
 */
export function sectionDraftInfo(sections: Pick<ReportSectionView, "id" | "kind" | "updatedAt">[], events: DraftEvent[], jobs: ReportJobRun[]): Record<string, SectionDraftInfo> {
  const byTime = <T extends { at: Date }>(xs: T[]) => [...xs].sort((a, b) => b.at.getTime() - a.at.getTime());
  const evs = byTime(events);
  const out: Record<string, SectionDraftInfo> = {};
  for (const s of sections) {
    if (s.kind !== "narrative") continue;
    const landed = evs.find((e) => e.drafted.includes(s.id)) ?? null;
    const failures: { at: Date; appAt: Date | null; error: string }[] = [];
    const ev = evs.find((e) => e.failed.some((f) => f.id === s.id));
    if (ev) failures.push({ at: ev.at, appAt: ev.appAt ?? null, error: ev.failed.find((f) => f.id === s.id)!.error });
    for (const j of jobs) {
      if (j.status !== "failed" || !targets(j, s.id)) continue;
      // The handler records an event once it has tried the model; before that only the job says why.
      if (events.some((e) => e.at.getTime() >= j.createdAt.getTime())) continue;
      failures.push({ at: j.finishedAt ?? j.createdAt, appAt: null, error: j.error ?? "The draft stopped without an error message." });
    }
    const failure = byTime(failures)[0] ?? null;
    const updatedAt = s.updatedAt ? new Date(s.updatedAt) : null;
    // A person's edit is on the app's clock; compare it with the failure on the same clock when the event has one.
    const showFailure = failure && later(failure.appAt ?? failure.at, updatedAt) && later(failure.at, landed?.at);
    const open = jobs.filter((j) => OPEN.has(j.status) && targets(j, s.id)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    out[s.id] = {
      drafted: landed ? { at: landed.at.toISOString(), modelId: landed.modelId } : null,
      failed: showFailure ? { at: failure.at.toISOString(), error: failure.error } : null,
      runId: open?.id ?? null,
    };
  }
  return out;
}

export interface AudienceSummary {
  /** Sections the export includes */
  sections: number;
  /** Internal sections a shareable export leaves out (not hidden ones) */
  internalLeftOut: string[];
  /** Narrative sections left out because they have no text yet */
  emptyLeftOut: string[];
}

/** What each export audience includes. Pure. */
export function audienceSummaries(view: Pick<ReportView, "sections">): Record<Audience, AudienceSummary> {
  const one = (a: Audience): AudienceSummary => {
    const { sections, omitted } = exportSections(view, a);
    const title = (id: string) => view.sections.find((s) => s.id === id)?.title ?? id;
    return {
      sections: sections.length,
      internalLeftOut: a === "shareable" ? view.sections.filter((s) => !s.hidden && s.audience === "internal").map((s) => s.title) : [],
      emptyLeftOut: omitted.map((o) => title(o.id)),
    };
  };
  return Object.fromEntries(AUDIENCES.map((a) => [a, one(a)])) as Record<Audience, AudienceSummary>;
}

export interface ReportPage {
  view: ReportView;
  model: ReportModel;
  /** The profile's finding kinds with their labels, in profile order */
  kinds: { kind: string; label: string; perInvestigation: boolean }[];
  narrativeMaxChars: number;
  /** policy outputRules.excerptChars, for the export dialog's note */
  excerptChars: number;
  /**
   * The history repository and the folder finalize commits to; null when the space has none.
   * `local` says why a commit stays on this machine: the repository has no remote, or pushing is off.
   */
  repository: { name: string; folder: string; local: "no-remote" | "push-off" | null } | null;
  /** Journal SHA-256s audit.json records */
  journalCount: number;
  audiences: Record<Audience, AudienceSummary>;
  drafts: Record<string, SectionDraftInfo>;
  /** A finalize job of this audit that is queued or running */
  finalizeRunId: string | null;
  /** The latest finalize job failed and the audit is not finalized */
  finalizeFailed: { at: string; error: string } | null;
}

async function loadDraftEvents(spaceId: string, auditId: string): Promise<DraftEvent[]> {
  const rows = await db()
    .select({ at: auditEvents.at, result: auditEvents.result, details: auditEvents.details })
    .from(auditEvents)
    .where(and(eq(auditEvents.spaceId, spaceId), eq(auditEvents.action, NARRATIVE_DRAFT_ACTION), eq(auditEvents.targetId, auditId)))
    .orderBy(desc(auditEvents.at))
    .limit(100);
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return rows.map((r) => {
    const d = (r.details ?? {}) as { drafted?: unknown; failed?: unknown; modelId?: unknown; finishedAt?: unknown };
    const appAt = typeof d.finishedAt === "string" && !Number.isNaN(Date.parse(d.finishedAt)) ? new Date(d.finishedAt) : null;
    const failed = Array.isArray(d.failed)
      ? d.failed.flatMap((f) => {
          const x = f as { id?: unknown; error?: unknown };
          return typeof x.id === "string" ? [{ id: x.id, error: plainErrorText(typeof x.error === "string" ? x.error : null) ?? "The model returned no text." }] : [];
        })
      : [];
    return { at: r.at, appAt, result: r.result, drafted: strings(d.drafted), failed, modelId: typeof d.modelId === "string" ? d.modelId : null };
  });
}

async function loadReportJobs(spaceId: string, auditId: string): Promise<ReportJobRun[]> {
  const rows = await db()
    .select({ id: jobRuns.id, queue: jobRuns.queue, status: jobRuns.status, input: jobRuns.input, error: jobRuns.error, createdAt: jobRuns.createdAt, finishedAt: jobRuns.finishedAt })
    .from(jobRuns)
    .where(and(eq(jobRuns.spaceId, spaceId), inArray(jobRuns.queue, [DRAFT_NARRATIVE_QUEUE, FINALIZE_QUEUE]), sql`${jobRuns.input}->>'auditId' = ${auditId}`))
    .orderBy(desc(jobRuns.createdAt))
    .limit(50);
  return rows.map((r) => {
    const input = (r.input ?? {}) as { sectionIds?: unknown };
    return {
      id: r.id,
      queue: r.queue,
      status: r.status,
      sectionIds: Array.isArray(input.sectionIds) ? input.sectionIds.filter((x): x is string => typeof x === "string") : [],
      error: plainErrorText(r.error),
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
    };
  });
}

/** The Report tab's data, or null when the audit is not in the space. */
export async function loadReportPage(space: Space, auditId: string): Promise<ReportPage | null> {
  const rc = await loadReportContext(space, auditId);
  if (!rc) return null;
  const { view, profile, policy, audit, data } = rc;
  const [repoRow, events, jobs] = await Promise.all([getHistoryRepoForSpace(space), loadDraftEvents(space.id, audit.id), loadReportJobs(space.id, audit.id)]);
  const finalizeJobs = jobs.filter((j) => j.queue === FINALIZE_QUEUE);
  const lastFinalize = finalizeJobs[0];
  return {
    view,
    model: reportModelOf(profile, space.parsedSettings, policy.policy.audits.profiles[audit.profileId] ?? null),
    kinds: profile.findings.map((f) => ({ kind: f.kind, label: f.label, perInvestigation: f.from === "$" })),
    narrativeMaxChars: profile.report.narrativeMaxChars,
    excerptChars: policy.policy.outputRules.excerptChars,
    repository: repoRow
      ? {
          name: repoRow.name,
          folder: `${auditDirFor(policy.policy.historyLayout, space.alias, audit.id)}/`,
          local: !repoRow.remoteUrl ? "no-remote" : !repoRow.pushEnabled ? "push-off" : null,
        }
      : null,
    journalCount: data.items.filter((i) => i.journalSha256).length,
    audiences: audienceSummaries(view),
    drafts: sectionDraftInfo(view.sections, events, jobs),
    finalizeRunId: finalizeJobs.find((j) => OPEN.has(j.status))?.id ?? null,
    finalizeFailed:
      lastFinalize?.status === "failed" && view.audit.state !== "finalized"
        ? { at: (lastFinalize.finishedAt ?? lastFinalize.createdAt).toISOString(), error: lastFinalize.error ?? "Finalizing stopped without an error message." }
        : null,
  };
}
