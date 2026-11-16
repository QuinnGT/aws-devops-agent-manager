import { and, eq } from "drizzle-orm";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTempDataDir } from "@/server/assets/test-support/history-fixture";
import { can, type AppUser } from "@/server/auth/dal";
import { db } from "@/server/db/client";
import { agentSpaces, auditEvents, auditItems, audits, findings, historyRepos, jobRuns, reviews, roleBindings } from "@/server/db/schema";
import { HistoryRepo } from "@/server/git/history-repo";
import { testJobContext } from "@/server/jobs/registry";
import { getAppPolicy } from "@/server/policy";
import { getSpaceById, type Space } from "@/server/spaces/queries";
import { truncateAll } from "../../../test/helpers/db";
import { buildAuditReport, saveReportNarrative } from "./edit";
import { checkAuditReportExport, exportAuditReport } from "./export";
import { REPORT_PERMISSIONS } from "./index";
import { DRAFT_NARRATIVE_QUEUE, FINALIZE_QUEUE } from "./jobs";
import { draftNarrativeHandler } from "./narrative";
import { loadReportPage } from "./page";
import { EXPORT_ACTION } from "./queries";

/**
 * The Report tab's data and the export permission, against the database:
 * a Viewer bound in the space can read and export the report but not change
 * it; the page loader's model, repository, audience and draft information;
 * the check-only export. Synthetic data only.
 */

const loaded = getAppPolicy();
const profile = { ...loaded.policy.audits.profiles.benchmark!, review: { ...loaded.policy.audits.profiles.benchmark!.review, modelId: "test-model" } };
const owner = { email: "alex@example.com" };
const viewer: AppUser = { id: "u-viewer", email: "viewer@example.com", name: "Viewer", groups: [], devBypass: false };
const editor: AppUser = { id: "u-editor", email: "editor@example.com", name: "Editor", groups: [], devBypass: false };

let tmp: Awaited<ReturnType<typeof useTempDataDir>>;
let space: Space;
let auditId: string;

const usage = { inputTokens: { total: 900, noCache: 900, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 60, text: 60, reasoning: undefined } };
const model = (text: string | Error) =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      if (text instanceof Error) throw text;
      return { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
    },
  });

beforeAll(async () => {
  await truncateAll();
  tmp = await useTempDataDir();
  const [repoRow] = await db().insert(historyRepos).values({ name: "page-space-history" }).returning();
  await HistoryRepo.open({ id: repoRow!.id, name: repoRow!.name, remoteUrl: null, deployKeyFile: null, defaultBranch: "main", pushEnabled: false });
  const [s] = await db()
    .insert(agentSpaces)
    .values({ alias: "page-space", region: "us-west-2", accountId: "111122223333", agentSpaceId: "space-page", historyRepoId: repoRow!.id })
    .returning();
  space = (await getSpaceById(s!.id))!;
  await db()
    .insert(roleBindings)
    .values([
      { spaceId: space.id, subjectType: "user", subject: viewer.email, role: "viewer", createdBy: owner.email },
      { spaceId: space.id, subjectType: "user", subject: editor.email, role: "editor", createdBy: owner.email },
    ]);

  const [a] = await db()
    .insert(audits)
    .values({ spaceId: space.id, name: "Page audit", profileId: "benchmark", profileSnapshot: profile, policyDigest: loaded.digest, state: "reviewing", createdBy: owner.email })
    .returning();
  auditId = a!.id;
  for (const n of [1, 2]) {
    const [it] = await db()
      .insert(auditItems)
      .values({ auditId, spaceId: space.id, taskId: `task-${n}`, incidentId: `INCIDENT-${n}`, journalSha256: n === 1 ? "1".repeat(64) : null, state: "reviewed" })
      .returning();
    const [rev] = await db()
      .insert(reviews)
      .values({ auditId, auditItemId: it!.id, spaceId: space.id, runner: "ai-sdk", modelId: "test-model", promptDigest: "d".repeat(64), state: "succeeded", schemaValid: true, startedBy: owner.email })
      .returning();
    await db().update(auditItems).set({ currentReviewId: rev!.id }).where(eq(auditItems.id, it!.id));
    await db()
      .insert(findings)
      .values({
        auditId,
        auditItemId: it!.id,
        reviewId: rev!.id,
        spaceId: space.id,
        incidentId: `INCIDENT-${n}`,
        kind: "fix",
        ordinal: 0,
        title: "Check the cache tier first.",
        proposed: { owner: "instructions", fix: "Check the cache tier first." },
        // The second fix quotes a full account ID, so a shareable export is refused.
        current: { owner: "instructions", fix: n === 2 ? "Use arn:aws:iam::123456789012:role/reader to read the logs." : "Check the cache tier first." },
        citations: [],
        state: "accepted",
        reviewedBy: owner.email,
        reviewedAt: new Date(),
      });
  }
});

afterAll(async () => {
  await tmp.cleanup();
});

describe("report permissions in a space", () => {
  it("let a Viewer read and export the report, but not change it", async () => {
    expect(await can(viewer, REPORT_PERMISSIONS.read, space.id)).toBe(true);
    expect(await can(viewer, REPORT_PERMISSIONS.export, space.id)).toBe(true);
    for (const p of [REPORT_PERMISSIONS.build, REPORT_PERMISSIONS.edit, REPORT_PERMISSIONS.draftNarrative, REPORT_PERMISSIONS.finalize]) expect(await can(viewer, p, space.id)).toBe(false);
    for (const p of Object.values(REPORT_PERMISSIONS)) expect(await can(editor, p, space.id)).toBe(true);
    // A role in one space says nothing about another.
    expect(await can(viewer, REPORT_PERMISSIONS.export, "00000000-0000-4000-8000-000000000999")).toBe(false);
  });
});

describe("export as a Viewer, and the check-only export", () => {
  it("checks without recording an export, then records the Viewer's refused and passing exports", async () => {
    const check = await checkAuditReportExport({ spaceId: space.id, auditId, audience: "shareable" });
    expect(check.ok).toBe(false);
    expect(check.excerptChars).toBe(loaded.policy.outputRules.excerptChars);
    expect(check.violations).toEqual([expect.objectContaining({ ruleId: "unmasked-account-id", sectionId: "fixes", location: "Row 2", incident: "INCIDENT-2" })]);
    expect(check.violations[0]!.excerpt).not.toContain("123456789012");
    const events = () => db().select().from(auditEvents).where(and(eq(auditEvents.action, EXPORT_ACTION), eq(auditEvents.targetId, auditId)));
    expect(await events()).toHaveLength(0);

    const refused = await exportAuditReport({ spaceId: space.id, auditId, audience: "shareable" }, viewer);
    expect(refused.ok).toBe(false);
    const page = (await loadReportPage(space, auditId))!;
    expect(page.view.lastExports.shareable).toMatchObject({ actor: viewer.email, result: "denied", errorCount: 1, warningCount: 0, ruleIds: ["unmasked-account-id"] });
    expect(await events()).toHaveLength(1);
  });

  it("passes once the finding no longer quotes the account ID", async () => {
    await db().update(findings).set({ current: { owner: "instructions", fix: "Use the reader role to read the logs." } }).where(eq(findings.incidentId, "INCIDENT-2"));
    expect((await checkAuditReportExport({ spaceId: space.id, auditId, audience: "shareable" })).ok).toBe(true);
    const ok = await exportAuditReport({ spaceId: space.id, auditId, audience: "internal" }, viewer);
    expect(ok.ok).toBe(true);
    expect((await loadReportPage(space, auditId))!.view.lastExports.internal).toMatchObject({ actor: viewer.email, result: "ok", errorCount: 0 });
  });
});

describe("loadReportPage", () => {
  it("names the report model, the repository folder and what each audience includes", async () => {
    await buildAuditReport({ spaceId: space.id, auditId }, owner);
    const page = (await loadReportPage(space, auditId))!;
    expect(page.model).toEqual({ id: "test-model", source: "review-model", sourceLabel: "Same as the review model" });
    expect(page.kinds.map((k) => [k.kind, k.perInvestigation])).toEqual([
      ["diagnosis", true],
      ["fix", false],
    ]);
    // The repository has no remote, so the finalize dialog says the record stays on this machine
    expect(page.repository).toEqual({ name: "page-space-history", folder: `audits/page-space/${auditId}/`, local: "no-remote" });
    expect(page.journalCount).toBe(1);
    expect(page.narrativeMaxChars).toBe(profile.report.narrativeMaxChars);
    expect(page.audiences.shareable.internalLeftOut).toEqual(["Run metrics", "Scorecard fairness"]);
    expect(page.audiences.shareable.emptyLeftOut).toEqual(["Summary"]);
    expect(page.drafts).toEqual({ summary: { drafted: null, failed: null, runId: null } });
    expect(page.finalizeRunId).toBeNull();
    expect(await loadReportPage({ ...space, id: "00000000-0000-4000-8000-000000000999" }, auditId)).toBeNull();
  });

  it("shows a landed draft, then a failed one, and an open draft or finalize job", async () => {
    const ctx = testJobContext({ actor: owner, spaceId: space.id });
    await draftNarrativeHandler({ spaceId: space.id, auditId, sectionIds: ["summary"], replacePersonText: false }, ctx, { model: model("Most misses were fixable.") });
    let page = (await loadReportPage(space, auditId))!;
    expect(page.drafts.summary).toMatchObject({ drafted: { modelId: "test-model" }, failed: null, runId: null });
    const summary = page.view.sections.find((s) => s.id === "summary")!;
    expect(summary.content).toMatchObject({ type: "narrative", text: "Most misses were fixable.", source: "model" });

    await expect(draftNarrativeHandler({ spaceId: space.id, auditId, sectionIds: ["summary"], replacePersonText: true }, ctx, { model: model(new Error("Bedrock throttled the request.")) })).rejects.toThrow();
    page = (await loadReportPage(space, auditId))!;
    expect(page.drafts.summary!.failed?.error).toContain("throttled");
    // A person's edit afterwards clears the failure.
    await saveReportNarrative({ spaceId: space.id, auditId, sectionId: "summary", text: "Written by a person." }, owner);
    page = (await loadReportPage(space, auditId))!;
    expect(page.drafts.summary!.failed).toBeNull();
    expect(page.view.sections.find((s) => s.id === "summary")!.content).toMatchObject({ source: "person" });

    const [draftRun] = await db().insert(jobRuns).values({ queue: DRAFT_NARRATIVE_QUEUE, actorEmail: owner.email, spaceId: space.id, input: { spaceId: space.id, auditId, sectionIds: [], replacePersonText: false }, status: "running" }).returning();
    const [finalizeRun] = await db().insert(jobRuns).values({ queue: FINALIZE_QUEUE, actorEmail: owner.email, spaceId: space.id, input: { spaceId: space.id, auditId }, status: "queued" }).returning();
    // Another audit's job is not this audit's.
    await db().insert(jobRuns).values({ queue: FINALIZE_QUEUE, actorEmail: owner.email, spaceId: space.id, input: { spaceId: space.id, auditId: "00000000-0000-4000-8000-000000000123" }, status: "running" });
    page = (await loadReportPage(space, auditId))!;
    expect(page.drafts.summary!.runId).toBe(draftRun!.id);
    expect(page.finalizeRunId).toBe(finalizeRun!.id);

    await db().update(jobRuns).set({ status: "failed", error: "AuditReportError: 1 finding is still proposed. Accept or reject each one first.", finishedAt: new Date() }).where(eq(jobRuns.id, finalizeRun!.id));
    page = (await loadReportPage(space, auditId))!;
    expect(page.finalizeRunId).toBeNull();
    expect(page.finalizeFailed?.error).toContain("still proposed");
  });
});
