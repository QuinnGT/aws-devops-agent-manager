import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { markdownBundle } from "@/server/analyzers/testing";
import { db } from "@/server/db/client";
import { agentSpaces, auditItems, audits, journalExecutions, journalRecords, journalTasks, reviews } from "@/server/db/schema";
import { executionValues, recordValues, taskValues } from "@/server/journals/store";
import { getAppPolicy } from "@/server/policy";
import { compareAudit } from "./compare-audit";

const JOURNAL = `# INCIDENT-9 — Full DevOps Agent Investigation Journal

_Execution: exe-review-9 · Retrieved from prod · 3 records across 1 pages_

## Record 1 — message (2026-10-19 07:00:00.000000+00:00)

**role: user**

TITLE: INCIDENT-9 orders delayed

## Record 2 — message (2026-10-19 07:01:00.000000+00:00)

**role: assistant**

Checking consumer lag for the shipment consumer.

## Record 3 — investigation_summary_md (2026-10-19 07:02:00.000000+00:00)

Root cause: a timing race.
`;

describe("compareAudit against Postgres", () => {
  let auditId = "";
  const refDir = mkdtempSync(path.join(tmpdir(), "review-ref-"));

  beforeAll(async () => {
    const policy = getAppPolicy();
    const bundle = markdownBundle(JOURNAL, policy.policy, createHash("sha256").update(JOURNAL).digest("hex"));
    const [space] = await db()
      .insert(agentSpaces)
      .values({ alias: `review-int-${Date.now()}`, region: "us-west-2", accountId: "111122223333", agentSpaceId: randomUUID() })
      .returning({ id: agentSpaces.id });
    const spaceId = space!.id;
    await db().insert(journalTasks).values(taskValues(spaceId, bundle.task));
    await db().insert(journalExecutions).values(bundle.executions.map((e) => executionValues(spaceId, e)));
    await db().insert(journalRecords).values(bundle.records.map((r) => recordValues(spaceId, r)));

    const base = policy.policy.audits.profiles.benchmark!;
    const profile = { ...base, review: { ...base.review, modelId: "test-model" } };
    const [audit] = await db()
      .insert(audits)
      .values({ spaceId, name: "Review comparison test", profileId: "benchmark", profileSnapshot: profile, policyDigest: policy.digest, state: "reviewing", createdBy: "t@example.com" })
      .returning({ id: audits.id });
    auditId = audit!.id;
    const [item] = await db()
      .insert(auditItems)
      .values({ auditId, spaceId, taskId: bundle.task.taskId, incidentId: "INCIDENT-9", state: "reviewed" })
      .returning({ id: auditItems.id });
    await db().insert(auditItems).values({ auditId, spaceId, taskId: "task-not-reviewed", incidentId: "INCIDENT-10", state: "pending" });
    const [review] = await db()
      .insert(reviews)
      .values({
        auditId,
        auditItemId: item!.id,
        spaceId,
        runner: "ai-sdk",
        modelId: profile.review.modelId,
        promptDigest: "0".repeat(64),
        state: "succeeded",
        output: { primary_failure_mode: "D_wrong_component", failure_modes: ["D_wrong_component"], reachability: "reachable", scorecard_fair: "yes", fixes: [{ owner: "instructions" }] },
        schemaValid: true,
        citationCheck: { ok: true, checked: 2, failed: 0, citations: [] },
        startedBy: "t@example.com",
      })
      .returning({ id: reviews.id });
    await db().update(auditItems).set({ currentReviewId: review!.id }).where(eq(auditItems.id, item!.id));

    writeFileSync(
      path.join(refDir, "INCIDENT-9.json"),
      JSON.stringify({
        incident: "INCIDENT-9",
        primary_failure_mode: "D_wrong_component",
        failure_modes: ["D_wrong_component", "F_premature_ruleout"],
        reachability: "partially_reachable",
        scorecard_fair: "yes",
        near_miss: "It checked consumer lag (R2) but not the right group; R7 does not exist.",
        fixes: [{ owner: "instructions", fix: "x" }, { owner: "customer_memory", fix: "y (R3)" }],
      }),
    );
  });

  it("compares the current review of each item with its reference file", async () => {
    const r = await compareAudit(auditId, refDir);
    expect(r.auditName).toBe("Review comparison test");
    expect(r.notReviewed).toEqual(["INCIDENT-10"]);
    expect(r.missingReference).toEqual([]);
    expect(r.comparisons).toHaveLength(1);
    const c = r.comparisons[0]!;
    expect(c.incident).toBe("INCIDENT-9");
    expect(c.primaryFailureMode.equal).toBe(true);
    expect(c.reachability).toEqual({ app: "reachable", reference: "partially_reachable", equal: false });
    expect(c.failureModes.jaccard).toBe(0.5);
    expect(c.fixOwners.jaccard).toBe(0.5);
    expect(c.citations.app).toEqual({ checked: 2, failed: 0, ok: true });
    // The reference's citations are checked against the stored journal: R2 and R3 exist, R7 does not
    expect(c.citations.reference).toEqual({ checked: 3, failed: 1, ok: false });
  });

  it("rejects an unknown audit", async () => {
    await expect(compareAudit(randomUUID(), refDir)).rejects.toThrow("No audit with ID");
  });
});
