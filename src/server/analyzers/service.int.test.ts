import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { JournalBundle } from "@/lib/journal/types";
import { db } from "@/server/db/client";
import { agentSpaces, analyzerRuns, auditEvents, journalExecutions, journalRecords, journalTasks } from "@/server/db/schema";
import { testJobContext } from "@/server/jobs/registry";
import { getAppPolicy } from "@/server/policy";
import { JOURNAL_ONLY_ANALYZERS } from "./registry";
import { AnalyzerRequestError, runAnalyzersJob, startAnalyzerRun } from "./service";
import { latestRunsForTask, listInvestigations, loadJournalBundle } from "./store";
import { apiFixtureBundle, markdownBundle } from "./testing";

const IMPORTED = `# INCIDENT-9 — Full DevOps Agent Investigation Journal

_Execution: exe-int-9 · Retrieved from prod · 3 records across 1 pages_

## Record 1 — message (2026-10-19 07:00:00.000000+00:00)

**role: user**

TITLE: INCIDENT-9

## Record 2 — message (2026-10-19 07:01:00.000000+00:00)

**role: assistant**

Reading /aidevops/memory/tips/overview.md now.

## Record 3 — mitigation_summary_md (2026-10-19 07:02:00.000000+00:00)

kubectl delete pod api-1 in account 123456789012
`;

/** Writes a bundle the way the journals module stores it (that module owns these tables). */
async function storeBundle(spaceId: string, b: JournalBundle): Promise<void> {
  await db()
    .insert(journalTasks)
    .values({
      spaceId,
      taskId: b.task.taskId,
      incidentId: b.task.incidentId,
      title: b.task.title,
      taskType: b.task.taskType,
      status: b.task.status,
      priority: b.task.priority,
      reference: b.task.reference,
      createdAt: b.task.createdAt,
      updatedAt: b.task.updatedAt,
      source: b.task.source,
      raw: b.task.raw,
    });
  await db()
    .insert(journalExecutions)
    .values(b.executions.map((e) => ({ ...e, spaceId })));
  await db()
    .insert(journalRecords)
    .values(b.records.map((r) => ({ ...r, spaceId, content: r.content, sizeBytes: JSON.stringify(r.raw).length })));
}

describe("analyzers.run against Postgres", () => {
  let spaceId = "";
  const api = apiFixtureBundle();
  const imported = markdownBundle(IMPORTED, getAppPolicy().policy, createHash("sha256").update(IMPORTED).digest("hex"));
  const ctx = () => testJobContext({ spaceId });

  beforeAll(async () => {
    const [s] = await db()
      .insert(agentSpaces)
      .values({ alias: `analyzers-int-${Date.now()}`, region: "us-west-2", accountId: "111122223333", agentSpaceId: randomUUID() })
      .returning({ id: agentSpaces.id });
    spaceId = s!.id;
    await storeBundle(spaceId, { ...api, spaceId });
    await storeBundle(spaceId, { ...imported, spaceId });
  });

  it("loads a bundle from the journal cache in record order", async () => {
    const b = await loadJournalBundle(spaceId, api.task.taskId);
    expect(b?.records).toHaveLength(113);
    expect(b?.records.map((r) => r.recordId)).toEqual(api.records.map((r) => r.recordId));
    expect(await loadJournalBundle(spaceId, "nope")).toBeNull();
  });

  it("runs the journal-only analyzers, stores their output and skips an unchanged rerun", async () => {
    const input = { spaceId, taskIds: [api.task.taskId, imported.task.taskId] };
    const c = ctx();
    const first = await runAnalyzersJob(input, c);
    expect(first).toMatchObject({ tasks: 2, ran: 8, skipped: 0, failed: 0, missingTasks: [], notApplicable: [] });
    expect(c.progressCalls.at(-1)?.[0]).toBe(1);

    const rows = await db().select().from(analyzerRuns).where(eq(analyzerRuns.spaceId, spaceId));
    expect(rows).toHaveLength(8);
    const metrics = rows.find((r) => r.taskId === imported.task.taskId && r.analyzer === "run-metrics")!;
    expect(metrics).toMatchObject({ analyzerVersion: "1.0.0", recordCount: 3, jobRunId: "00000000-0000-0000-0000-000000000000" });
    expect(metrics.output).toMatchObject({ incident: "INCIDENT-9", execution: "exe-int-9", records_parsed: 3, span_min: 2 });
    const rules = rows.find((r) => r.taskId === imported.task.taskId && r.analyzer === "output-rules")!;
    expect((rules.output as { counts: Record<string, number> }).counts).toEqual({ "unmasked-account-id": 1, "destructive-label": 1 });

    const again = await runAnalyzersJob(input, ctx());
    expect(again).toMatchObject({ ran: 0, skipped: 8 });
    expect(await db().select().from(analyzerRuns).where(eq(analyzerRuns.spaceId, spaceId))).toHaveLength(8);
  });

  it("reruns only the investigation whose records changed", async () => {
    await db()
      .update(journalRecords)
      .set({ content: { kind: "markdown", text: "Reading nothing.", role: "assistant" } })
      .where(and(eq(journalRecords.spaceId, spaceId), eq(journalRecords.taskId, imported.task.taskId), eq(journalRecords.seq, 2)));
    const res = await runAnalyzersJob({ spaceId, taskIds: [api.task.taskId, imported.task.taskId] }, ctx());
    expect(res).toMatchObject({ ran: 4, skipped: 4 });
    const latest = await latestRunsForTask(spaceId, imported.task.taskId);
    expect(latest.map((r) => r.analyzer).sort()).toEqual([...JOURNAL_ONLY_ANALYZERS].sort());
  });

  it("reports missing tasks and analyzers that need a package", async () => {
    const res = await runAnalyzersJob({ spaceId, taskIds: ["missing-task"], analyzers: ["deployed-vs-read", "run-metrics"] }, ctx());
    expect(res).toMatchObject({ ran: 0, missingTasks: ["missing-task"], notApplicable: ["deployed-vs-read"] });

    const pkg = { label: "v2", files: [{ assetType: "memory", name: "tips", path: "overview.md", body: "# Tips overview, first long line here\nSecond line that is long enough to count." }] };
    const withPkg = await runAnalyzersJob({ spaceId, taskIds: [imported.task.taskId], analyzers: ["deployed-vs-read"], package: pkg }, ctx());
    expect(withPkg).toMatchObject({ ran: 1, notApplicable: [] });
    const [row] = await latestRunsForTask(spaceId, imported.task.taskId).then((r) => r.filter((x) => x.analyzer === "deployed-vs-read"));
    expect((row!.output as { files: { verdict: string }[] }).files.map((f) => f.verdict)).toEqual(["not-read"]);
  });

  it("refuses a job whose context names another space", async () => {
    await expect(runAnalyzersJob({ spaceId, taskIds: [api.task.taskId] }, testJobContext({ spaceId: randomUUID() }))).rejects.toThrow(/space/);
  });

  it("lists investigations with their latest metrics", async () => {
    const { rows, total } = await listInvestigations(spaceId, { limit: 10, offset: 0 });
    expect(total).toBe(2);
    const imp = rows.find((r) => r.taskId === imported.task.taskId)!;
    expect(imp).toMatchObject({ incidentId: "INCIDENT-9", source: "import", records: 3, metricsVersion: "1.0.0" });
    expect(imp.metrics).toMatchObject({ records_parsed: 3 });
    expect(rows.find((r) => r.taskId === api.task.taskId)?.records).toBe(113);

    const imports = await listInvestigations(spaceId, { limit: 10, offset: 0, sources: ["import"] });
    expect(imports.rows.map((r) => r.taskId)).toEqual([imported.task.taskId]);
    expect(imports.total).toBe(1);
    expect((await listInvestigations(spaceId, { limit: 10, offset: 0, q: "incident-9" })).rows.map((r) => r.taskId)).toEqual([imported.task.taskId]);
    // LIKE wildcards in the text filter are literal.
    expect((await listInvestigations(spaceId, { limit: 10, offset: 0, q: "%" })).total).toBe(0);
  });

  it("starts a run only for investigations in the space, and records it in the audit log", async () => {
    const sent: unknown[] = [];
    const enqueue = async (input: unknown) => {
      sent.push(input);
      return randomUUID();
    };
    const actor = { email: "analyst@example.com" };
    await expect(startAnalyzerRun(actor, spaceId, { taskIds: ["other-space-task"] }, { enqueue })).rejects.toBeInstanceOf(AnalyzerRequestError);
    await expect(startAnalyzerRun(actor, spaceId, { taskIds: [] }, { enqueue })).rejects.toBeInstanceOf(AnalyzerRequestError);
    expect(sent).toHaveLength(0);

    const { runId } = await startAnalyzerRun(actor, spaceId, { taskIds: [api.task.taskId, api.task.taskId] }, { enqueue });
    expect(sent).toEqual([{ spaceId, taskIds: [api.task.taskId] }]);
    const events = await db().select().from(auditEvents).where(and(eq(auditEvents.spaceId, spaceId), eq(auditEvents.action, "analyzers.run")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorEmail: actor.email, targetId: runId, result: "ok" });
  });
});
