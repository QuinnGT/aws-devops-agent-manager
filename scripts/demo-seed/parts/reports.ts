import { and, eq, inArray } from "drizzle-orm";
import { MockLanguageModelV4 } from "ai/test";
import { approveReportNarrative, buildAuditReport, saveReportNarrative, setReportSectionHidden } from "@/server/audit-reports/edit";
import { summaryFromView } from "@/server/audit-reports/demo-summary";
import { exportAuditReport } from "@/server/audit-reports/export";
import { finalizeAuditHandler } from "@/server/audit-reports/finalize";
import { loadAuditReport } from "@/server/audit-reports/loader";
import { draftNarrativeHandler } from "@/server/audit-reports/narrative";
import type { ReviewRunInput, ReviewRunResult } from "@/server/audits/contract";
import { reviewFinding } from "@/server/audits/finding-review";
import { runAuditJob, runReviewItemJob } from "@/server/audits/run";
import { createAudit, startAudit } from "@/server/audits/service";
import { benchmarkFixture, benchmarkReviews, reachableCatalog } from "@/server/audits/testing";
import { db } from "@/server/db/client";
import { audits, findings, jobRuns } from "@/server/db/schema";
import { testJobContext } from "@/server/jobs/registry";
import type { Space } from "@/server/spaces/queries";
import { importBenchmarkJournals, uploadBenchmarkGroundTruth } from "../lib/benchmark";
import { logger, REVIEW_MODEL, SAMPLE, type SeedPerson } from "../lib/common";
import { settle } from "../lib/jobs";

/**
 * The Report tab's part of the demo: five benchmark
 * audits run through the audit service and job handlers with a fake reviewer
 * that returns the sample reference reviews (sample-data/audit/reviews), and
 * report narratives from the AI SDK's mock model (no AWS or Bedrock calls).
 * The mock model writes each summary from that audit's own report
 * (summaryFromView: its counts and its accepted fixes), so no summary
 * describes another audit:
 *
 *   Late October low scores    reviewing: accepted, rejected and proposed findings,
 *                              a stale report, a model-drafted summary a person edited,
 *                              a hidden section, a fix with an unmasked account ID and
 *                              a refused shareable export
 *   Late October, all decided  reviewing: every finding decided, report built, the
 *                              model's summary not approved yet, so finalize asks for it
 *   Late October, finalized    summary approved, finalized into the space's history repository
 *   Late October, nothing accepted  report built, every finding still proposed
 *   Late October, report not built  reviewed, report never built
 *
 * Audits with these names are deleted and made again. Finalizing writes the
 * history repository, so the process must run as the worker (DAM_PROCESS=worker).
 */

export const REPORT_NAMES = {
  main: "Late October low scores",
  decided: "Late October, all decided",
  finalized: "Late October, finalized",
  nothing: "Late October, nothing accepted",
  unbuilt: "Late October, report not built",
} as const;
const MAIN = ["INCIDENT-20101", "INCIDENT-20102", "INCIDENT-20103", "INCIDENT-20104", "INCIDENT-20105", "INCIDENT-20106"];
const DECIDED = ["INCIDENT-20101", "INCIDENT-20102", "INCIDENT-20103"];
const FINALIZED = ["INCIDENT-20105", "INCIDENT-20106"];
const NOTHING = ["INCIDENT-20107"];
const UNBUILT = ["INCIDENT-20108"];
/** The incident whose first fix is left for after the report build, then accepted with an edit that quotes a full account ID. */
const ACCOUNT_ID_INCIDENT = "INCIDENT-20104";
export const REPORT_INCIDENTS = [...new Set([...MAIN, ...DECIDED, ...FINALIZED, ...NOTHING, ...UNBUILT])];

const log = logger("reports");

export interface ReportScreens {
  main: string;
  decided: string;
  finalized: string;
  nothing: string;
  unbuilt: string;
}

/** Seed the Report tab's audits in the space. */
export async function seedReportScreens(space: Space, people: { owner: SeedPerson; reviewer: SeedPerson }): Promise<ReportScreens> {
  const { owner, reviewer } = people;
  const spaceId = space.id;

  // ---------- journals and ground truth ----------
  const imported = await importBenchmarkJournals(space, owner, REPORT_INCIDENTS);
  if (imported.length) log("imported", imported.join(", "));
  await uploadBenchmarkGroundTruth(space, owner, REPORT_INCIDENTS);

  // ---------- the fake reviewer ----------
  const reviews = new Map(benchmarkReviews(SAMPLE.auditDir).map((r) => [String(r.raw.incident), r.raw]));
  const runReview = async (input: ReviewRunInput): Promise<ReviewRunResult> => {
    const raw = reviews.get(input.incidentId ?? "");
    if (!raw) throw new Error(`No sample review for ${input.incidentId}`);
    const fields = input.profile.findings.find((f) => f.kind === "diagnosis")!.fields;
    const fx = benchmarkFixture(raw, fields);
    const max = input.bundle.records.length;
    const citations = fx.citationCheck.citations.map((c) => (c.record <= max ? c : { ...c, ok: false, problem: "missing-record" as const }));
    const failed = citations.filter((c) => !c.ok).length;
    const modelId = input.profile.review.modelId ?? REVIEW_MODEL;
    return {
      state: "succeeded",
      runner: "seed",
      modelId,
      promptDigest: "f".repeat(64),
      output: fx.output,
      schemaValid: true,
      schemaErrors: [],
      citationCheck: { ok: failed === 0, checked: citations.length, failed, citations },
      steps: 12,
      inputTokens: 91_000,
      outputTokens: 2_400,
      durationMs: 1_000,
      error: null,
      modelCalls: [{ purpose: "review", runner: "seed", modelId, region: input.region, steps: 12, inputTokens: 91_000, outputTokens: 2_400, durationMs: 1_000, error: null }],
    };
  };

  /** Create, start and run an audit with every review done inline. */
  async function runAudit(name: string, incidents: string[], note: string): Promise<string> {
    const old = await db().select({ id: audits.id }).from(audits).where(and(eq(audits.spaceId, spaceId), eq(audits.name, name)));
    if (old.length) await db().delete(audits).where(inArray(audits.id, old.map((o) => o.id)));
    const { auditId } = await createAudit(owner, spaceId, { name, note, selections: [{ by: "incidents", incidentIds: incidents }] });
    const queue: { input: { auditId: string; itemId: string }; runId: string }[] = [];
    const deps = {
      runReview,
      enqueueReview: async (input: { auditId: string; itemId: string }, opts: { actor: { email: string }; spaceId: string }) => {
        const [row] = await db().insert(jobRuns).values({ queue: "audits.review-item", actorEmail: opts.actor.email, spaceId: opts.spaceId, input }).returning({ id: jobRuns.id });
        queue.push({ input, runId: row!.id });
        return row!.id;
      },
    };
    const { runId } = await startAudit(owner, spaceId, auditId, {}, { listCatalog: reachableCatalog(REVIEW_MODEL) });
    await runAuditJob({ auditId }, testJobContext({ actor: owner, spaceId, runId }), deps);
    await settle(runId);
    for (let guard = 0; queue.length && guard < 200; guard++) {
      const next = queue.shift()!;
      await runReviewItemJob(next.input, testJobContext({ actor: owner, spaceId, runId: next.runId }), deps);
      await settle(next.runId);
    }
    log(`ran ${name} (${auditId})`);
    return auditId;
  }

  const findingsOf = async (auditId: string) => db().select().from(findings).where(eq(findings.auditId, auditId)).orderBy(findings.incidentId, findings.kind, findings.ordinal);
  const decide = async (id: string, action: "accept" | "reject", note?: string) => reviewFinding(reviewer, spaceId, id, action === "accept" ? { action } : { action, note });
  const ref = (auditId: string) => ({ spaceId, auditId });
  const usage = { inputTokens: { total: 6400, noCache: 6400, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 320, text: 320, reasoning: undefined } };
  const mockModel = (text: string) =>
    new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: "text", text }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }) });
  /** Draft the summary with a mock model that writes it from this audit's own report (its counts and accepted fixes). Returns the text. */
  const draft = async (auditId: string): Promise<string> => {
    const view = await loadAuditReport(space, auditId);
    if (!view) throw new Error(`Audit ${auditId} is not in ${space.alias}`);
    const text = summaryFromView(view);
    await draftNarrativeHandler({ spaceId, auditId, sectionIds: ["summary"], replacePersonText: true }, testJobContext({ actor: owner, spaceId }), { model: mockModel(text) });
    return text;
  };

  // ---------- 1. Late October low scores: in review, stale, refused export ----------
  const main = await runAudit(REPORT_NAMES.main, MAIN, "Six incidents from Oct 26 to Oct 30 that scored 3/5 or lower against the confirmed root cause.");
  let fs = await findingsOf(main);
  const byIncident = new Map<string, typeof fs>();
  for (const f of fs) byIncident.set(f.incidentId ?? "", [...(byIncident.get(f.incidentId ?? "") ?? []), f]);
  // First pass: accept every diagnosis and the first fix of the first four incidents (the account ID incident's first fix waits); reject one fix.
  for (const inc of MAIN.slice(0, 4)) {
    const list = byIncident.get(inc) ?? [];
    for (const f of list.filter((x) => x.kind === "diagnosis")) await decide(f.id, "accept");
    const fixes = list.filter((x) => x.kind === "fix");
    if (fixes[0] && inc !== ACCOUNT_ID_INCIDENT) await decide(fixes[0].id, "accept");
    if (inc === "INCIDENT-20103" && fixes[1]) await decide(fixes[1].id, "reject", "Duplicates the consumer-lag-check skill in the first fix.");
  }
  const summary = await draft(main);
  await saveReportNarrative({ ...ref(main), sectionId: "summary", text: `${summary}\n\nThese counts cover the accepted findings only; the proposed ones are still under review.` }, owner);
  await setReportSectionHidden({ ...ref(main), sectionId: "scorecard-fairness", hidden: true }, owner);
  await buildAuditReport(ref(main), owner);
  // After the build: six more decisions, one of them accepting a fix edited to quote a full account ID, so the report is stale and the shareable export is refused.
  fs = await findingsOf(main);
  const arnFix = fs.find((f) => f.state === "proposed" && f.kind === "fix" && f.incidentId === ACCOUNT_ID_INCIDENT);
  if (arnFix) {
    const fixText = String((arnFix.current as Record<string, unknown>).fix ?? "");
    await reviewFinding(reviewer, spaceId, arnFix.id, { action: "accept", values: { fix: `${fixText} The role is arn:aws:iam::123456789012:role/devops-agent-access in the identity account.` } });
  }
  const later = fs.filter((f) => f.state === "proposed" && f.kind === "fix" && f.id !== arnFix?.id).slice(0, 4);
  for (const f of later) await decide(f.id, "accept");
  const lateDiagnosis = fs.find((f) => f.state === "proposed" && f.kind === "diagnosis" && f.incidentId === "INCIDENT-20106");
  if (lateDiagnosis) await decide(lateDiagnosis.id, "accept");
  const refused = await exportAuditReport({ ...ref(main), audience: "shareable" }, owner);
  log(`shareable export of ${REPORT_NAMES.main}: ${refused.ok ? "passed" : `refused, ${refused.violations.length} errors`}`);

  // ---------- 2. Every finding decided, ready to finalize ----------
  const decided = await runAudit(REPORT_NAMES.decided, DECIDED, "The first three incidents, every finding decided.");
  for (const f of await findingsOf(decided)) await decide(f.id, f.kind === "fix" && f.ordinal === 2 ? "reject" : "accept", f.kind === "fix" && f.ordinal === 2 ? "Duplicates the first fix." : undefined);
  await draft(decided);
  await buildAuditReport(ref(decided), owner);

  // ---------- 3. Finalized ----------
  const finalized = await runAudit(REPORT_NAMES.finalized, FINALIZED, "Two incidents, finalized into the history repository.");
  for (const f of await findingsOf(finalized)) await decide(f.id, "accept");
  // Finalize needs a person's approval of the model's summary, which is shared.
  const finalSummary = await draft(finalized);
  await approveReportNarrative({ ...ref(finalized), sectionId: "summary", text: finalSummary }, owner);
  await buildAuditReport(ref(finalized), owner);
  const done = await finalizeAuditHandler({ spaceId, auditId: finalized }, testJobContext({ actor: owner, spaceId }));
  log(`finalized ${REPORT_NAMES.finalized}: commit ${done.commit.slice(0, 7)} in ${done.dir}`);

  // ---------- 4 and 5. Built with nothing accepted yet, and never built ----------
  const nothing = await runAudit(REPORT_NAMES.nothing, NOTHING, "Reviewed, nothing accepted yet.");
  await buildAuditReport(ref(nothing), owner);
  const unbuilt = await runAudit(REPORT_NAMES.unbuilt, UNBUILT, "Reviewed, report not built yet.");

  return { main, decided, finalized, nothing, unbuilt };
}
