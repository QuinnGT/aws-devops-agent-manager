import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JournalBundle } from "@/lib/journal/types";
import { attributeChanges, attributionKey, type Attribution } from "@/server/attribution";
import { useTempDataDir } from "@/server/assets/test-support/history-fixture";
import { db } from "@/server/db/client";
import { agentSpaces, analyzerRuns, applyRuns, auditEvents, historyRepos, journalExecutions, journalRecords, journalTasks, planItems, plans, releases, syncState, verificationRuns } from "@/server/db/schema";
import { testJobContext } from "@/server/jobs/registry";
import { getAppPolicy, type Policy } from "@/server/policy";
import { createReleaseHandler, prepareCreateRelease } from "@/server/releases/create";
import { getReleaseByName, type ReleaseRow } from "@/server/releases/queries";
import { syncSpace } from "@/server/sync/engine";
import { FakeSpace } from "@/server/sync/testing/fake-space";
import { getSpaceById, type Space } from "@/server/spaces/queries";
import { truncateAll } from "../../../test/helpers/db";
import { queueReadsAfterJournals } from "./auto";
import { loadReleaseVerification } from "./loaders";
import { runVerifyLive } from "./live-job";
import { applyReadBack, getVerification } from "./queries";
import { runVerifyReads } from "./reads-job";
import { requestVerification, VerifyRequestError } from "./service";
import { memoryText, syntheticBundle } from "./test-support";
import type { LiveCheckResult, ReadsCheckResult } from "./types";

// Sync attribution reads CloudTrail; here every change comes from the console.
vi.mock("@/server/attribution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/attribution")>();
  return { ...actual, attributeChanges: vi.fn(actual.attributeChanges) };
});

const policy = getAppPolicy().policy;
const actor = { email: "alex@example.com" };
const ALIAS = "verify-space";
const AGENT_SPACE_ID = "11111111-2222-4333-8444-555555555555";
const id = (n: number) => `ki-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ID = { store: id(1), failover: id(2), backup: id(3), triage: id(4), generic: id(5), added: id(6) };

const failover = [1, 2, 3].map((v) =>
  memoryText("db/failover", [
    v < 3 ? "Fail over the primary database by promoting the replica in the console." : "Fail over the primary database with the runbook automation, not by hand.",
    v < 2 ? "Retention of the failover log is about 30 days in every region." : "Retention of the failover log is deployment-dependent; check the stack.",
    "Page the database on-call before promoting any replica by hand.",
  ]),
);
const backup = memoryText("db/backup", ["Backups run nightly at 02:00 UTC and keep fourteen copies.", "Restore drills happen every quarter on the replica cluster."]);
const triage = (n: number) =>
  `---\nname: triage\ndescription: Triage skill\n---\n# Triage skill used by the verification tests\nStart from the alarm and the deployment timeline${n > 1 ? ", and the last change" : ""}.\nAlways name the evidence record for each claim in the summary.\n`;

const at = (day: number, hour = 0) => new Date(Date.UTC(2026, 9, day, hour)).toISOString();
const v = (version: number, updatedAt: string, metadata: Record<string, unknown>, files: { path: string; text: string }[]) => ({ version, createdAt: at(1), updatedAt, metadata, files });

function fakeSpace(): FakeSpace {
  const fake = new FakeSpace(AGENT_SPACE_ID);
  const store = { name: "runbooks", description: "Runbooks. Read when paged.", agent_types: ["GENERIC"], status: "ACTIVE" };
  fake.add({ assetId: ID.store, assetType: "memory_store", versions: [v(1, at(1), store, [{ path: "README.md", text: "Runbooks.\n" }])] });
  const fo = { name: "db/failover", description: "Failover", memory_store_id: ID.store, status: "ACTIVE" };
  fake.add({ assetId: ID.failover, assetType: "memory", versions: failover.map((text, i) => v(i + 1, at(2 + i), fo, [{ path: "failover.md", text }])) });
  fake.add({ assetId: ID.backup, assetType: "memory", versions: [v(1, at(2), { name: "db/backup", description: "Backups", memory_store_id: ID.store, status: "ACTIVE" }, [{ path: "backup.md", text: backup }])] });
  fake.add({ assetId: ID.triage, assetType: "skill", versions: [v(1, at(3), { name: "triage", description: "Triage skill", agent_types: ["GENERIC"], status: "ACTIVE", skill_type: "USER" }, [{ path: "SKILL.md", text: triage(1) }])] });
  fake.add({ assetId: ID.generic, assetType: "agents_md", versions: [v(1, at(3), { agent_type: "GENERIC", status: "ACTIVE" }, [{ path: "AGENTS.md", text: "# Rules\n" }])] });
  return fake;
}

/** Writes a bundle the way the journals module stores it (that module owns these tables). */
async function storeBundle(spaceId: string, b: JournalBundle): Promise<void> {
  await db().insert(journalTasks).values({ spaceId, taskId: b.task.taskId, incidentId: b.task.incidentId, title: b.task.title, taskType: b.task.taskType, status: b.task.status, priority: b.task.priority, reference: b.task.reference, createdAt: b.task.createdAt, updatedAt: b.task.updatedAt, source: b.task.source, raw: b.task.raw });
  await db().insert(journalExecutions).values(b.executions.map((e) => ({ ...e, spaceId })));
  await db().insert(journalRecords).values(b.records.map((r) => ({ ...r, spaceId, content: r.content, sizeBytes: JSON.stringify(r.raw).length })));
}

async function dropBundle(spaceId: string, taskId: string): Promise<void> {
  await db().delete(journalRecords).where(and(eq(journalRecords.spaceId, spaceId), eq(journalRecords.taskId, taskId)));
  await db().delete(journalExecutions).where(and(eq(journalExecutions.spaceId, spaceId), eq(journalExecutions.taskId, taskId)));
  await db().delete(journalTasks).where(and(eq(journalTasks.spaceId, spaceId), eq(journalTasks.taskId, taskId)));
}

let tmp: Awaited<ReturnType<typeof useTempDataDir>>;
let fake: FakeSpace;
let space: Space;
let v3: ReleaseRow;
const enqueued: { kind: string; input: { verificationId: string } }[] = [];
const enqueue = async (kind: string, input: { verificationId: string }) => {
  enqueued.push({ kind, input });
  return randomUUID();
};
const ctx = () => testJobContext({ actor, spaceId: space.id });

async function release(name: string, createdAt: string): Promise<ReleaseRow> {
  const input = await prepareCreateRelease({ spaceId: space.id, name });
  await createReleaseHandler(input, testJobContext({ actor, spaceId: space.id }));
  // Pin the creation time so the journal windows are deterministic.
  await db().update(releases).set({ createdAt: new Date(createdAt) }).where(eq(releases.id, input.releaseId));
  return (await getReleaseByName(space.id, name))!;
}

async function start(kind: "live" | "reads", releaseId = v3.id): Promise<string> {
  const r = await requestVerification({ spaceId: space.id, releaseId, kind }, actor, { enqueue });
  return r.verificationId;
}

beforeAll(async () => {
  await truncateAll();
  tmp = await useTempDataDir();
  vi.mocked(attributeChanges).mockImplementation(async (changes) => {
    const out = new Map<string, Attribution>();
    for (const c of changes) out.set(attributionKey(c), { source: "console", label: "Operator Web App", principal: "alex", cloudTrailEventId: null, planId: null, matchedBy: "exact" });
    return out;
  });
  fake = fakeSpace();
  fake.install();
  const [repo] = await db().insert(historyRepos).values({ name: "verify-history" }).returning();
  const [row] = await db().insert(agentSpaces).values({ alias: ALIAS, region: "us-west-2", accountId: "111122223333", agentSpaceId: AGENT_SPACE_ID, historyRepoId: repo!.id }).returning();
  space = (await getSpaceById(row!.id))!;
  const baseline = await syncSpace(space.id, { actor: { email: "system:test" } });
  expect(baseline).toMatchObject({ mode: "baseline", status: "succeeded" });
  v3 = await release("v3", "2026-11-05T00:00:00.000Z");
});

afterAll(async () => {
  fake.restore();
  await tmp.cleanup();
});

describe("starting a check", () => {
  it("queues it for a release of the space and records who started it", async () => {
    const before = enqueued.length;
    const r = await requestVerification({ spaceId: space.id, releaseId: v3.id, kind: "live" }, actor, { enqueue });
    expect(r.alreadyOpen).toBe(false);
    expect(enqueued.slice(before)).toEqual([{ kind: "live", input: { verificationId: r.verificationId } }]);
    expect(await getVerification(r.verificationId)).toMatchObject({ state: "queued", trigger: "manual", requestedBy: actor.email, jobRunId: r.runId, kind: "live" });
    const [audit] = await db().select().from(auditEvents).where(and(eq(auditEvents.action, "release.verify"), eq(auditEvents.targetId, v3.id)));
    expect(audit).toMatchObject({ actorEmail: actor.email, spaceId: space.id, targetType: "release", result: "ok", details: { kind: "live", release: "v3", verificationId: r.verificationId, runId: r.runId } });

    // The same check again while it is queued returns the open one
    const again = await requestVerification({ spaceId: space.id, releaseId: v3.id, kind: "live" }, actor, { enqueue });
    expect(again).toEqual({ verificationId: r.verificationId, runId: r.runId, alreadyOpen: true });
    await runVerifyLive({ verificationId: r.verificationId }, ctx());
  });

  it("refuses a release of another space", async () => {
    await expect(requestVerification({ spaceId: randomUUID(), releaseId: v3.id, kind: "reads" }, actor, { enqueue })).rejects.toBeInstanceOf(VerifyRequestError);
    await expect(requestVerification({ spaceId: space.id, releaseId: v3.id, kind: "nope" as "live" }, actor, { enqueue })).rejects.toBeInstanceOf(VerifyRequestError);
  });
});

describe("check 1: live state (verify.live)", () => {
  it("says the live space matches the release right after it", async () => {
    const vid = await start("live");
    const c = ctx();
    const res = await runVerifyLive({ verificationId: vid }, c);
    expect(res).toMatchObject({ state: "succeeded", summary: { allMatch: true, matches: 5 } });
    const row = (await getVerification(vid))!;
    const result = row.result as LiveCheckResult;
    expect(row).toMatchObject({ state: "succeeded", investigationCount: 0 });
    expect(row.startedAt).not.toBeNull();
    expect(row.finishedAt).not.toBeNull();
    expect(result).toMatchObject({ matches: true, counts: { matches: 5, changed: 0, missing: 0, added: 0 }, release: { id: v3.id, name: "v3" }, sync: { mode: "reconcile", status: "succeeded" } });
    expect(c.progressCalls.map(([, m]) => m)).toContain("Syncing the space");
    expect(c.progressCalls.at(-1)).toEqual([1, "The live space matches the release"]);
    // A retried job returns the finished run
    expect(await runVerifyLive({ verificationId: vid }, ctx())).toEqual({ verificationId: vid, state: "succeeded" });
  });

  it("syncs, then reports what changed since the release, what is missing and what was added", async () => {
    fake.addVersion(ID.triage, { updatedAt: "2026-11-06T01:00:00.000Z", files: [{ path: "SKILL.md", text: triage(2), mimeType: "text/markdown" }] });
    fake.updateInPlace(ID.backup, { status: "INACTIVE" }, "2026-11-06T02:00:00.000Z");
    fake.remove(ID.generic);
    fake.add({ assetId: ID.added, assetType: "skill", versions: [v(1, "2026-11-06T03:00:00.000Z", { name: "added", description: "Added skill", agent_types: ["GENERIC"], status: "ACTIVE", skill_type: "USER" }, [{ path: "SKILL.md", text: "---\nname: added\ndescription: Added skill\n---\nAdded\n" }])] });

    const vid = await start("live");
    const res = await runVerifyLive({ verificationId: vid }, ctx());
    expect(res.state).toBe("succeeded");
    const result = (await getVerification(vid))!.result as LiveCheckResult;
    expect(result.counts).toEqual({ changed: 2, missing: 1, added: 1, matches: 2 });
    const by = Object.fromEntries(result.rows.map((r) => [r.name, r]));
    expect(by.triage).toMatchObject({ outcome: "changed", changes: ["content"], newerVersion: true, release: { version: 1 }, live: { version: 2 } });
    expect(by.triage!.lastChange).toMatchObject({ source: "console", principal: "alex" });
    expect(by["db/backup"]).toMatchObject({ outcome: "changed", changes: ["status"], release: { status: "ACTIVE" }, live: { status: "INACTIVE" }, parentName: "runbooks" });
    expect(result.rows.find((r) => r.assetType === "agents_md")).toMatchObject({ outcome: "missing", live: null });
    expect(by.added).toMatchObject({ outcome: "added", release: null });
    expect(result.rows.slice(0, 4).map((r) => r.outcome)).toEqual(["changed", "changed", "missing", "added"]);
  });

  it("can't run when the space is unreachable or another sync holds the lock", async () => {
    const unreachable = Object.assign(new Error("The security token included in the request is invalid."), { name: "UnrecognizedClientException", $metadata: { httpStatusCode: 403 } });
    let vid = await start("live");
    expect(await runVerifyLive({ verificationId: vid }, ctx(), { sync: async () => Promise.reject(unreachable) })).toMatchObject({ state: "blocked", blockedReason: "space-unreachable" });
    expect(await getVerification(vid)).toMatchObject({ state: "blocked", blockedReason: "space-unreachable" });
    expect((await getVerification(vid))!.message).toMatch(/^The app can't reach the space\. /);

    vid = await start("live");
    const skipped = async (spaceId: string) => ({ spaceId, mode: "reconcile" as const, status: "skipped" as const, listed: 0, changedAssets: 0, changes: 0, commits: 0, deferred: 0, deleted: 0, attributionFailed: false, pushed: false });
    expect(await runVerifyLive({ verificationId: vid }, ctx(), { sync: skipped })).toMatchObject({ state: "blocked", blockedReason: "sync-busy" });

    vid = await start("live");
    expect(await runVerifyLive({ verificationId: vid }, ctx(), { sync: async () => Promise.reject(new Error("git index.lock exists")) })).toMatchObject({ state: "blocked", blockedReason: "sync-failed" });
  });
});

describe("check 2: what the agent read (verify.reads)", () => {
  const FAILOVER = "/aidevops/memory/runbooks/db/failover.md";
  const BACKUP = "/aidevops/memory/runbooks/db/backup.md";
  const TRIAGE = "/aidevops/skills/user/triage/SKILL.md";

  beforeAll(async () => {
    const t = (iso: string) => new Date(iso);
    // Before the release: not part of the check
    await storeBundle(space.id, syntheticBundle({ spaceId: space.id, taskId: "t-before", incidentId: "INC-0", createdAt: t("2026-11-04T00:00:00Z"), reads: [{ path: FAILOVER, body: failover[0]! }] }));
    // October 12 shape: v3 released, the agent requested the memory and got the v1 body
    await storeBundle(space.id, syntheticBundle({ spaceId: space.id, taskId: "t-a", incidentId: "INC-1", createdAt: t("2026-11-05T10:00:00Z"), reads: [{ path: FAILOVER, body: failover[0]! }, { path: BACKUP, body: null }, { path: TRIAGE, body: triage(1) }] }));
    await storeBundle(space.id, syntheticBundle({ spaceId: space.id, taskId: "t-b", incidentId: "INC-2", createdAt: t("2026-11-05T11:00:00Z"), reads: [{ path: FAILOVER, body: failover[2]! }] }));
    // After the skill changed live: the agent read the newer skill body
    await storeBundle(space.id, syntheticBundle({ spaceId: space.id, taskId: "t-c", incidentId: "INC-3", createdAt: t("2026-11-06T12:00:00Z"), reads: [{ path: TRIAGE, body: triage(2) }] }));
  });

  it("names the files read with an older body first, with the version and links to the records", async () => {
    const vid = await start("reads");
    const c = ctx();
    const res = await runVerifyReads({ verificationId: vid }, c);
    expect(res).toMatchObject({ state: "succeeded", summary: { verdict: "failed", investigations: 3 } });
    const row = (await getVerification(vid))!;
    expect(row).toMatchObject({ state: "succeeded", investigationCount: 3, investigations: ["t-c", "t-b", "t-a"] });
    const r = row.result as ReadsCheckResult;
    expect(r).toMatchObject({ verdict: "failed", investigationsInWindow: 3, investigations: 3, missing: [], errors: [], window: { mode: "release-created", from: "2026-11-05T00:00:00.000Z", to: null } });
    expect(r.files.map((f) => [f.deployedPath, f.verdict])).toEqual([
      [FAILOVER, "older-body"],
      [TRIAGE, "newer-body"],
      [BACKUP, "requested-no-body"],
    ]);
    const fo = r.files[0]!;
    expect(fo).toMatchObject({ assetId: ID.failover, releaseVersion: 3, store: "runbooks", assetName: "db/failover", requested: 2, counts: { "older-body": 1, "release-body": 1, "not-requested": 1 } });
    expect(fo.matchedVersions).toEqual([expect.objectContaining({ version: 1, relation: "older" })]);
    expect(fo.examples["older-body"]).toEqual([{ taskId: "t-a", incidentId: "INC-1", n: 3, recordId: "t-a-rec-3", version: 1 }]);
    const tr = r.files[1]!;
    expect(tr.counts).toMatchObject({ "newer-body": 1, "release-body": 1 });
    expect(tr.matchedVersions).toEqual([expect.objectContaining({ version: 2, relation: "newer" })]);
    expect(r.skipped.map((s) => [s.assetType, s.reason]).sort()).toEqual([
      ["agents_md", "not-compared"],
      ["memory_store", "not-compared"],
    ]);
    expect(r.stores).toEqual([{ store: "runbooks", referencedIn: 2 }]);
    expect(c.progressCalls.at(-1)).toEqual([1, "Bodies that aren't the release's in 3 investigation(s)"]);

    // The analyzer's output is stored per investigation, and an unchanged rerun reuses it
    const stored = await db().select().from(analyzerRuns).where(and(eq(analyzerRuns.spaceId, space.id), eq(analyzerRuns.analyzer, "deployed-vs-read")));
    expect(stored.map((s) => s.taskId).sort()).toEqual(["t-a", "t-b", "t-c"]);
    const again = await start("reads");
    await runVerifyReads({ verificationId: again }, ctx());
    expect((await db().select().from(analyzerRuns).where(eq(analyzerRuns.spaceId, space.id))).length).toBe(3);
    expect(((await getVerification(again))!.result as ReadsCheckResult).files).toEqual(r.files);
  });

  it("reads only the investigations up to the next release, and says when there are none", async () => {
    const v4 = await release("v4", "2026-11-06T00:00:00.000Z");
    const vid = await start("reads");
    await runVerifyReads({ verificationId: vid }, ctx());
    const r = (await getVerification(vid))!.result as ReadsCheckResult;
    expect(r.window).toMatchObject({ to: "2026-11-06T00:00:00.000Z", nextRelease: "v4" });
    expect(r.investigations).toBe(2);

    // v4 itself: t-c ran after it
    const v4run = await start("reads", v4.id);
    await runVerifyReads({ verificationId: v4run }, ctx());
    expect(((await getVerification(v4run))!.result as ReadsCheckResult).investigations).toBe(1);

    await dropBundle(space.id, "t-c");
    const none = await start("reads", v4.id);
    expect(await runVerifyReads({ verificationId: none }, ctx())).toMatchObject({ state: "blocked", blockedReason: "no-journals" });
    expect((await getVerification(none))!.message).toBe("No investigations in the journal cache started after this release. Export or import journals first.");
    await storeBundle(space.id, syntheticBundle({ spaceId: space.id, taskId: "t-c", incidentId: "INC-3", createdAt: new Date("2026-11-06T12:00:00Z"), reads: [{ path: TRIAGE, body: triage(2) }] }));
  });
});

describe("running by itself after new journals", () => {
  const on = (release: "latest" | "latest-applied" = "latest"): Pick<Policy, "verify"> => ({ verify: { ...policy.verify, reads: { ...policy.verify.reads, auto: { enabled: true, release } } } });

  it("queues the check for the newest release when policy turns it on, once at a time", async () => {
    const sent: unknown[] = [];
    const send = async (input: unknown) => {
      sent.push(input);
      return randomUUID();
    };
    expect(await queueReadsAfterJournals(space.id, { runId: randomUUID() }, { enqueue: send })).toEqual({ queued: false, reason: "off" });
    expect(await queueReadsAfterJournals(space.id, { runId: randomUUID() }, { policy: on("latest-applied"), enqueue: send })).toEqual({ queued: false, reason: "no-release" });

    const v4 = (await getReleaseByName(space.id, "v4"))!;
    const audits = async () => (await db().select().from(auditEvents).where(and(eq(auditEvents.action, "release.verify"), eq(auditEvents.targetId, v4.id)))).length;
    const auditsBefore = await audits();
    const trigger = randomUUID();
    const first = await queueReadsAfterJournals(space.id, { runId: trigger }, { policy: on(), enqueue: send });
    expect(first).toMatchObject({ queued: true });
    if (!first.queued) throw new Error("not queued");
    const row = (await getVerification(first.verificationId))!;
    expect(row).toMatchObject({ releaseId: v4.id, kind: "reads", trigger: "journals", requestedBy: "system:verify.reads", triggeredByRunId: trigger, state: "queued", jobRunId: first.runId });
    expect(sent).toEqual([{ verificationId: first.verificationId }]);
    expect(await queueReadsAfterJournals(space.id, { runId: randomUUID() }, { policy: on(), enqueue: send })).toEqual({ queued: false, reason: "already-open" });
    // Not a person's action: no audit event
    expect(await audits()).toBe(auditsBefore);
    await runVerifyReads({ verificationId: first.verificationId }, ctx());
  });
});

describe("the Verification section of the release page", () => {
  it("shows the latest result of each check, when it ran and on how many investigations", async () => {
    const view = (await loadReleaseVerification(space, "v3"))!;
    expect(view.release).toMatchObject({ id: v3.id, name: "v3" });
    expect(view.window).toMatchObject({ mode: "release-created", from: "2026-11-05T00:00:00.000Z", to: "2026-11-06T00:00:00.000Z", nextRelease: "v4", investigations: 2, cap: 50 });
    expect(view).toMatchObject({ syncFirst: true, auto: { enabled: false, release: "latest" } });
    expect(view.live.latest).toMatchObject({ state: "blocked", blockedReason: "sync-failed" });
    expect(view.live.lastResult?.result.counts).toEqual({ changed: 2, missing: 1, added: 1, matches: 2 });
    expect(view.live.cannotRun).toBeNull();
    expect(view.live.open).toBeNull();
    expect(view.reads.lastResult?.run).toMatchObject({ state: "succeeded", investigationCount: 2, trigger: "manual", requestedBy: actor.email });
    expect(view.reads.lastResult!.run.durationMs).toBeGreaterThanOrEqual(0);
    const fo = view.reads.lastResult!.result.files[0]!;
    expect(fo.examples["older-body"]![0]!.href).toBe(`/spaces/${ALIAS}/journals/investigations/t-a#rec-t-a-rec-3`);
    expect(view.reads.cannotRun).toBeNull();
    expect(view.reads.history.length).toBeGreaterThanOrEqual(3);
    expect(await loadReleaseVerification(space, "nope")).toBeNull();
  });

  it("says why a check can't run: no journals since the release, space unreachable", async () => {
    await dropBundle(space.id, "t-c");
    let view = (await loadReleaseVerification(space, "v4"))!;
    expect(view.reads.cannotRun).toEqual({ reason: "no-journals", message: "No investigations in the journal cache started after this release. Export or import journals first." });
    expect(view.reads.lastResult?.result.investigations).toBe(1);

    await db()
      .update(agentSpaces)
      .set({ connectionStatus: "failed", connectionCheckedAt: new Date(), connectionDetail: { error: { name: "CredentialsProviderError", message: "Could not load credentials from any providers" } } })
      .where(eq(agentSpaces.id, space.id));
    view = (await loadReleaseVerification((await getSpaceById(space.id))!, "v4"))!;
    expect(view.live.cannotRun?.reason).toBe("space-unreachable");
    expect(view.live.cannotRun?.message).toMatch(/^The app can't reach the space\. ./);
    // A queued check shows as open
    const open = await start("live", view.release.id);
    view = (await loadReleaseVerification(space, "v4"))!;
    expect(view.live.open).toMatchObject({ id: open, state: "queued" });
    expect(await db().select().from(verificationRuns).where(eq(verificationRuns.id, open))).toHaveLength(1);
  });
});

describe("the Verification tab's extra facts", () => {
  it("names what each release changed against the one before it, every asset for the first", async () => {
    const s = (await getSpaceById(space.id))!;
    const first = (await loadReleaseVerification(s, "v3"))!;
    expect(first.changes).toMatchObject({ previous: null, removed: 0 });
    expect(first.changes!.assetIds.sort()).toEqual([ID.store, ID.failover, ID.backup, ID.triage, ID.generic].sort());
    // v4 came after the triage skill changed, db/backup was switched off, the instructions were deleted and a skill was added
    const next = (await loadReleaseVerification(s, "v4"))!;
    expect(next.changes).toMatchObject({ previous: "v3", removed: 1 });
    expect(next.changes!.assetIds.sort()).toEqual([ID.backup, ID.triage, ID.added].sort());
  });

  it("titles record links, carries each file's status in the release, and records when the live check's sync ran", async () => {
    // t-c was dropped above; the v3 window still holds t-a and t-b
    const view = (await loadReleaseVerification((await getSpaceById(space.id))!, "v3"))!;
    const fo = view.reads.lastResult!.result.files[0]!;
    expect(fo.examples["older-body"]![0]).toMatchObject({ taskId: "t-a", title: "INC-1" });
    expect(fo.releaseStatus).toBe("ACTIVE");
    expect(view.release.planId).toBeNull();
    expect(view.applied).toBeNull();
    const sync = view.live.lastResult!.result.sync!;
    expect(Date.parse(sync.at!)).toBeGreaterThan(0);
  });

  it("says a check is stale after a later sync or when the window gained investigations", async () => {
    // A fresh live check: its own sync finished before it did
    await runVerifyLive({ verificationId: await start("live") }, ctx());
    let view = (await loadReleaseVerification((await getSpaceById(space.id))!, "v3"))!;
    expect(view.stale).toEqual({ live: false, reads: false });

    await db().insert(syncState).values({ spaceId: space.id, lastSyncCompletedAt: new Date(Date.now() + 60_000), status: "succeeded" }).onConflictDoUpdate({
      target: syncState.spaceId,
      set: { lastSyncCompletedAt: new Date(Date.now() + 60_000) },
    });
    await storeBundle(space.id, syntheticBundle({ spaceId: space.id, taskId: "t-d", incidentId: "INC-4", createdAt: new Date("2026-11-05T12:00:00Z"), reads: [] }));
    view = (await loadReleaseVerification((await getSpaceById(space.id))!, "v3"))!;
    expect(view.stale).toEqual({ live: true, reads: true });
    expect(view.lastSyncAt).not.toBeNull();
    await dropBundle(space.id, "t-d");
  });

  it("reads back what the apply job verified for a release tagged after a plan", async () => {
    const [plan] = await db()
      .insert(plans)
      .values({ spaceId: space.id, title: "Apply revision v2 global scope", origin: { kind: "drafts" } as never, originKind: "drafts", state: "applied", createdBy: actor.email, finishedAt: new Date("2026-11-04T23:00:00Z") })
      .returning();
    const verification = (ok: boolean) => ({ ok, expectedContentHash: "a", actualContentHash: ok ? "a" : "b", expectedMetadataHash: "m", actualMetadataHash: "m", metadataMismatch: [], fileMismatch: ok ? [] : ["x.md"], attempts: 1 });
    await db()
      .insert(planItems)
      .values([
        { planId: plan!.id, position: 0, kind: "upsert", assetType: "memory", assetKey: "runbooks/db/failover", name: "db/failover", verification: verification(true) },
        { planId: plan!.id, position: 1, kind: "upsert", assetType: "skill", assetKey: "triage", name: "triage", verification: verification(false) },
        { planId: plan!.id, position: 2, kind: "upsert", assetType: "skill", assetKey: "other", name: "other", verification: null },
      ]);
    await db().insert(applyRuns).values({ planId: plan!.id, spaceId: space.id, startedBy: actor.email, status: "succeeded", startedAt: new Date("2026-11-04T22:59:00Z"), finishedAt: new Date("2026-11-04T23:01:00Z") });

    expect(await applyReadBack(space.id, plan!.id)).toEqual({
      planId: plan!.id,
      title: "Apply revision v2 global scope",
      at: "2026-11-04T23:01:00.000Z",
      total: 2,
      matched: 1,
      mismatched: ["triage"],
    });
    // Another space's plan, or a planId that isn't a UUID, reads as none
    expect(await applyReadBack(randomUUID(), plan!.id)).toBeNull();
    expect(await applyReadBack(space.id, "not-a-uuid")).toBeNull();

    await db().update(releases).set({ planId: plan!.id }).where(eq(releases.id, v3.id));
    const view = (await loadReleaseVerification(space, "v3"))!;
    expect(view.release.planId).toBe(plan!.id);
    expect(view.applied).toMatchObject({ title: "Apply revision v2 global scope", total: 2, matched: 1 });
    await db().update(releases).set({ planId: null }).where(eq(releases.id, v3.id));
  });
});
