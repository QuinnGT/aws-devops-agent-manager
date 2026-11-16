import { and, eq } from "drizzle-orm";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTempDataDir } from "@/server/assets/test-support/history-fixture";
import { db } from "@/server/db/client";
import { agentSpaces, auditEvents, auditItems, audits, findings, historyRepos, reviews } from "@/server/db/schema";
import { HistoryRepo, type HistoryRepoConfig } from "@/server/git/history-repo";
import { testJobContext } from "@/server/jobs/registry";
import { getAppPolicy } from "@/server/policy";
import type { SpaceRow } from "@/server/spaces/queries";
import { truncateAll } from "../../../test/helpers/db";
import { summaryFromView } from "./demo-summary";
import { approveReportNarrative, buildAuditReport, saveReportNarrative } from "./edit";
import { exportAuditReport } from "./export";
import { finalizeAuditHandler, prepareFinalizeAudit } from "./finalize";
import { loadAuditReport } from "./loader";
import { draftNarrativeHandler, draftNarrativeInput } from "./narrative";
import type { NarrativeContent, ReportView } from "./types";

/**
 * Model text must be checked before it is shared: a model-drafted shareable summary blocks finalize until a person
 * approves it, a later decision asks again, and the narrative prompt only ever
 * holds this audit's findings, never another audit's in the same space.
 * Against TEST_DATABASE_URL, with a local history repository. Synthetic data.
 */

const loaded = getAppPolicy();
const profile = { ...loaded.policy.audits.profiles.benchmark!, review: { ...loaded.policy.audits.profiles.benchmark!.review, modelId: "test-model" } };
const actor = { email: "alex@example.com" };
const reviewer = { email: "sam@example.com" };
const ALIAS = "approval-space";

let tmp: Awaited<ReturnType<typeof useTempDataDir>>;
let space: SpaceRow;
let auditA: string;
let auditB: string;
const proposedFix: Record<string, string> = {};

function cfg(): HistoryRepoConfig {
  return { id: "00000000-0000-4000-8000-0000000000b1", name: "approval-space-history", remoteUrl: null, deployKeyFile: null, defaultBranch: "main", pushEnabled: false };
}

const usage = { inputTokens: { total: 900, noCache: 900, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 60, text: 60, reasoning: undefined } };

/** A mock model that writes the summary from the audit's own report and keeps the prompts it was sent. */
function writer(prompts: string[], view: () => ReportView) {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return { content: [{ type: "text", text: summaryFromView(view()) }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
    },
  });
}

async function makeAudit(name: string, n: number, fixes: { owner: string; fix: string; state: "accepted" | "proposed" }[]): Promise<string> {
  const [a] = await db()
    .insert(audits)
    .values({ spaceId: space.id, name, profileId: "benchmark", profileSnapshot: profile, policyDigest: loaded.digest, state: "reviewing", createdBy: actor.email })
    .returning();
  const [it] = await db()
    .insert(auditItems)
    .values({ auditId: a!.id, spaceId: space.id, taskId: `task-${n}`, incidentId: `INCIDENT-${n}`, journalSha256: String(n).repeat(64).slice(0, 64), state: "reviewed" })
    .returning();
  const [rev] = await db()
    .insert(reviews)
    .values({ auditId: a!.id, auditItemId: it!.id, spaceId: space.id, runner: "ai-sdk", modelId: "test-model", promptDigest: "d".repeat(64), state: "succeeded", schemaValid: true, startedBy: actor.email, startedAt: new Date("2026-11-12T10:00:00.000Z") })
    .returning();
  await db().update(auditItems).set({ currentReviewId: rev!.id }).where(eq(auditItems.id, it!.id));
  const base = { auditId: a!.id, auditItemId: it!.id, reviewId: rev!.id, spaceId: space.id, incidentId: `INCIDENT-${n}`, citations: [] };
  const diag = { primary_failure_mode: "D_wrong_component", failure_modes: ["D_wrong_component"], reachability: "reachable", one_line: "Looked at the gateway.", score: "2/5" };
  await db().insert(findings).values({ ...base, kind: "diagnosis", ordinal: 0, title: `INCIDENT-${n}: Looked at the gateway.`, proposed: diag, current: diag, state: "accepted", reviewedBy: reviewer.email, reviewedAt: new Date() });
  for (const [i, f] of fixes.entries()) {
    const values = { owner: f.owner, fix: f.fix, evidence: [] };
    const [row] = await db()
      .insert(findings)
      .values({ ...base, kind: "fix", ordinal: i, title: f.fix, proposed: values, current: values, state: f.state, reviewedBy: f.state === "accepted" ? reviewer.email : null, reviewedAt: f.state === "accepted" ? new Date() : null })
      .returning();
    if (f.state === "proposed") proposedFix[a!.id] = row!.id;
  }
  return a!.id;
}

const summaryOf = (v: ReportView) => v.sections.find((s) => s.id === "summary")!.content as NarrativeContent;
const refA = () => ({ spaceId: space.id, auditId: auditA });

beforeAll(async () => {
  await truncateAll();
  tmp = await useTempDataDir();
  const repo = await HistoryRepo.open(cfg());
  await repo.writeAndCommit([{ path: "README.md", content: "history\n" }], {
    message: "Start",
    author: { name: actor.email, email: actor.email },
    committer: { name: actor.email, email: actor.email },
    date: new Date("2026-11-01T00:00:00.000Z"),
  });
  const [repoRow] = await db().insert(historyRepos).values({ name: cfg().name }).returning();
  const [spaceRow] = await db().insert(agentSpaces).values({ alias: ALIAS, region: "us-west-2", accountId: "111122223333", agentSpaceId: "space-approval", historyRepoId: repoRow!.id }).returning();
  space = spaceRow!;
  auditA = await makeAudit("Late October, all decided", 1, [
    { owner: "instructions", fix: "Add a fast-fail 5xx rule to the incident RCA instructions.", state: "accepted" },
    { owner: "customer_memory", fix: "Record the cart-page memory.", state: "proposed" },
  ]);
  auditB = await makeAudit("Another audit", 2, [{ owner: "instructions", fix: "Check the caller identity before a 401 or 403 is dismissed.", state: "accepted" }]);
});

afterAll(async () => {
  await tmp.cleanup();
});

describe("the narrative prompt", () => {
  it("holds only this audit's accepted findings, never another audit's in the same space", async () => {
    const prompts: string[] = [];
    let view: ReportView | null = (await loadAuditReport(space, auditA))!;
    const res = await draftNarrativeHandler(draftNarrativeInput.parse({ ...refA(), sectionIds: ["summary"] }), testJobContext({ actor, spaceId: space.id }), { model: writer(prompts, () => view!) });
    expect(res.drafted).toEqual(["summary"]);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    expect(prompt).toContain("fast-fail 5xx");
    expect(prompt).toContain("Instruction and skill package");
    expect(prompt).toContain("Describe only what they show");
    // Audit B's fix and incident, and A's still-proposed fix, never reach A's prompt
    expect(prompt).not.toMatch(/caller identity|401|INCIDENT-2\b|cart-page/);

    view = (await loadAuditReport(space, auditA))!;
    const summary = summaryOf(view);
    expect(summary).toMatchObject({ source: "model", needsApproval: true, draftedBeforeDecisions: false, approved: null });
    expect(summary.text).toContain("fast-fail 5xx");
    expect(summary.text).not.toContain("caller identity");
  });
});

describe("finalize and model text", () => {
  it("refuses while the shared summary is model text drafted before the latest decision, with the audit event", async () => {
    await db().update(findings).set({ state: "accepted", reviewedBy: reviewer.email, reviewedAt: new Date() }).where(eq(findings.id, proposedFix[auditA]!));
    const v = (await loadAuditReport(space, auditA))!;
    // The decision came after the draft
    expect(summaryOf(v)).toMatchObject({ needsApproval: true, draftedBeforeDecisions: true });
    expect(v.finalize.issues.map((i) => i.code)).toEqual(["unapproved-narrative"]);
    await expect(prepareFinalizeAudit(refA())).rejects.toMatchObject({ code: "not-ready", problems: [expect.stringContaining("Summary is the model's text")] });
    await expect(finalizeAuditHandler(refA(), testJobContext({ actor, spaceId: space.id }))).rejects.toMatchObject({ code: "not-ready" });
    const [refused] = await db()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "audit.finalize"), eq(auditEvents.result, "error"), eq(auditEvents.targetId, auditA)));
    expect(refused!.details).toMatchObject({ problems: [expect.stringContaining("nobody has approved it")] });
  });

  it("warns in the shareable export's record, but still exports", async () => {
    const res = await exportAuditReport({ ...refA(), audience: "shareable" }, actor);
    expect(res.ok && res.unapproved).toEqual([{ id: "summary", title: "Summary" }]);
    const internal = await exportAuditReport({ ...refA(), audience: "internal" }, actor);
    expect(internal.ok && internal.unapproved).toEqual([]);
    const events = await db().select().from(auditEvents).where(and(eq(auditEvents.action, "audit.report.export"), eq(auditEvents.targetId, auditA)));
    expect(events.map((e) => (e.details as { unapprovedNarratives?: string[] }).unapprovedNarratives ?? null)).toEqual([["summary"], null]);
    const v = (await loadAuditReport(space, auditA))!;
    expect(v.lastSuccessfulExports.shareable).toMatchObject({ result: "ok", fileName: "approval-space-late-october-all-decided-shareable.html" });
  });

  it("won't approve text the person didn't see", async () => {
    await expect(approveReportNarrative({ ...refA(), sectionId: "summary", text: "Some older draft." }, actor)).rejects.toMatchObject({ code: "conflict" });
    await expect(approveReportNarrative({ ...refA(), sectionId: "fixes", text: "x" }, actor)).rejects.toThrow(/computed from the findings/);
  });

  it("records who approved and when, then finalizes, with the approval in audit.json", async () => {
    const text = summaryOf((await loadAuditReport(space, auditA))!).text!;
    const approved = await approveReportNarrative({ ...refA(), sectionId: "summary", text }, actor);
    expect(summaryOf(approved)).toMatchObject({ needsApproval: false, draftedBeforeDecisions: false, approved: { by: actor.email } });
    expect(approved.finalize).toMatchObject({ allowed: true, issues: [] });
    const [event] = await db().select().from(auditEvents).where(eq(auditEvents.action, "audit.report.narrative-approve"));
    expect(event).toMatchObject({ actorEmail: actor.email, targetId: auditA, result: "ok", details: expect.objectContaining({ sectionId: "summary" }) });

    // Rebuilding the report keeps the approval: no finding changed
    await buildAuditReport(refA(), actor);
    const input = await prepareFinalizeAudit(refA());
    const res = await finalizeAuditHandler(input, testJobContext({ actor, spaceId: space.id }));
    const repo = await HistoryRepo.open(cfg());
    const manifest = JSON.parse((await repo.show(res.commit, `${res.dir}/audit.json`))!);
    expect(manifest.report.sections[0]).toMatchObject({ id: "summary", narrativeSource: "model", approvedBy: actor.email, approvedAt: summaryOf(approved).approved!.at });
    const [ok] = await db()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "audit.finalize"), eq(auditEvents.result, "ok")));
    expect(ok).toMatchObject({ targetId: auditA, details: expect.objectContaining({ commit: res.commit }) });
  });

  it("asks again after a later decision, and needs nothing for a person's text", async () => {
    const prompts: string[] = [];
    let view: ReportView = (await loadAuditReport(space, auditB))!;
    await draftNarrativeHandler(draftNarrativeInput.parse({ spaceId: space.id, auditId: auditB }), testJobContext({ actor, spaceId: space.id }), { model: writer(prompts, () => view) });
    view = (await loadAuditReport(space, auditB))!;
    expect(prompts[0]).not.toMatch(/fast-fail|cart-page/);
    await approveReportNarrative({ spaceId: space.id, auditId: auditB, sectionId: "summary", text: summaryOf(view).text! }, actor);
    expect((await loadAuditReport(space, auditB))!.finalize.allowed).toBe(true);

    await new Promise((r) => setTimeout(r, 150));
    await db().update(findings).set({ reviewNote: "Checked again." }).where(and(eq(findings.auditId, auditB), eq(findings.kind, "fix")));
    const after = (await loadAuditReport(space, auditB))!;
    expect(summaryOf(after)).toMatchObject({ needsApproval: true, draftedBeforeDecisions: true, approved: null });
    expect(after.finalize.allowed).toBe(false);

    await saveReportNarrative({ spaceId: space.id, auditId: auditB, sectionId: "summary", text: "Written by Alex from the tables." }, actor);
    const person = (await loadAuditReport(space, auditB))!;
    expect(summaryOf(person)).toMatchObject({ source: "person", needsApproval: false, approved: null });
    expect(person.finalize.allowed).toBe(true);
  });
});
