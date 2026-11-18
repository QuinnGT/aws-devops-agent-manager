import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useTempDataDir } from "@/server/assets/test-support/history-fixture";
import { db } from "@/server/db/client";
import { agentSpaces, assetIndex, auditEvents, auditItems, audits, findings, historyRepos, planItems, plans, releases, reviews, revisionChanges, revisions } from "@/server/db/schema";
import { HistoryRepo, type HistoryRepoConfig } from "@/server/git/history-repo";
import { enqueue } from "@/server/jobs/enqueue";
import { testJobContext } from "@/server/jobs/registry";
import { readZip } from "@/server/packages/zip";
import { notifyPlanApplied } from "@/server/plans";
import { getAppPolicy } from "@/server/policy";
import { createReleaseHandler } from "@/server/releases/create";
import { parseManifest } from "@/server/releases/manifest";
import { commitVersion, type TestAsset } from "@/server/releases/test-support";
import { getSpaceById, type Space } from "@/server/spaces/queries";
import { truncateAll } from "../../../test/helpers/db";
import { createRevisionHandler } from "./create";
import { loadLinkableFindings, loadRevisionDetail, loadRevisionList } from "./loaders";
import "./jobs";
import { saveRevisionHandler, type SaveRevisionInput } from "./save";
import { abandonRevision, createPlanFromRevision, exportRevision, requestCreateRevision, requestSaveRevision } from "./service";
import { addTestLayouts } from "@/server/packages/test-support/policy";
import { GLOBAL_MD, PACKAGE_FILES, SAFETY } from "./test-support";
import { RevisionError } from "./types";

// Jobs run directly in this test; nothing is sent to pg-boss.
vi.mock("@/server/jobs/enqueue", () => ({ enqueue: vi.fn(async () => crypto.randomUUID()) }));

// The test layout strict-instructions carries the text checks the default layouts leave out.
const restoreLayouts = addTestLayouts();
const policy = getAppPolicy().policy;
const layout = policy.historyLayout;
const ALIAS = "rev-space";
const alex = { email: "alex@example.com", name: "Alex" };
const syncMock = vi.fn(async (spaceId: string) => ({ spaceId, mode: "reconcile", status: "succeeded", listed: 0, changedAssets: 0, changes: 0, commits: 0, deferred: 0, deleted: 0, attributionFailed: false, pushed: false }) as never);

const id = (n: number) => `ki-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ID = { generic: id(1), triage: id(2), skill: id(3), store: id(4), memory: id(5) };
const at = (d: number) => `2026-10-0${d}T01:00:00.000Z`;

/** The synthetic package's assets as the sync worker would have committed them. */
const ASSETS: TestAsset[] = [
  { assetId: ID.generic, assetType: "agents_md", metadata: { agent_type: "GENERIC", status: "ACTIVE" }, version: 1, updatedAt: at(1), files: { "AGENTS.md": GLOBAL_MD } },
  { assetId: ID.triage, assetType: "agents_md", metadata: { agent_type: "INCIDENT_TRIAGE", status: "ACTIVE" }, version: 1, updatedAt: at(2), files: { "AGENTS.md": PACKAGE_FILES["instructions/incident-triage.md"]! } },
  {
    assetId: ID.skill,
    assetType: "skill",
    metadata: { name: "triage", description: "Triage steps", agent_types: ["INCIDENT_TRIAGE", "INCIDENT_RCA"], status: "ACTIVE", skill_type: "USER" },
    version: 1,
    updatedAt: at(3),
    files: { "SKILL.md": PACKAGE_FILES["skills/triage/SKILL.md"]! },
  },
  { assetId: ID.store, assetType: "memory_store", metadata: { name: "runbooks", description: "Runbooks", agent_types: ["INCIDENT_TRIAGE", "INCIDENT_RCA"], status: "ACTIVE" }, version: 1, updatedAt: at(4), files: { "runbooks.md": "# Runbooks\n" } },
  {
    assetId: ID.memory,
    assetType: "memory",
    metadata: { name: "failover", description: "Database failover", memory_store_id: ID.store, status: "ACTIVE" },
    version: 1,
    updatedAt: at(5),
    files: { "failover.md": PACKAGE_FILES["memory/runbooks/failover.md"]! },
    storeName: "runbooks",
  },
];

let tmp: Awaited<ReturnType<typeof useTempDataDir>>;
let repo: HistoryRepo;
let space: Space;
let otherSpace: Space;
let releaseV1: string;
const F: { fix: string; diagnosis: string; proposed: string; otherSpace: string } = { fix: "", diagnosis: "", proposed: "", otherSpace: "" };

function cfg(): HistoryRepoConfig {
  return { id: "00000000-0000-4000-8000-0000000000f1", name: "rev-space-history", remoteUrl: null, deployKeyFile: null, defaultBranch: "main", pushEnabled: false };
}

const ctx = () => testJobContext({ actor: { email: alex.email }, spaceId: space.id });

async function seedFinding(spaceId: string, state: "accepted" | "proposed", kind: string, title: string, incidentId: string): Promise<string> {
  const [audit] = await db()
    .insert(audits)
    .values({ spaceId, name: "Late October low scores", profileId: "benchmark", profileSnapshot: policy.audits.profiles.benchmark!, policyDigest: "test", state: "reviewing", createdBy: alex.email })
    .returning();
  const [item] = await db().insert(auditItems).values({ auditId: audit!.id, spaceId, taskId: `task-${incidentId}-${kind}-${state}`, incidentId, state: "reviewed" }).returning();
  const [review] = await db().insert(reviews).values({ auditId: audit!.id, auditItemId: item!.id, spaceId, runner: "ai-sdk", modelId: "mock", promptDigest: "d", state: "succeeded", startedBy: alex.email }).returning();
  // The linkable findings are those of an item's current review (audits module).
  await db().update(auditItems).set({ currentReviewId: review!.id }).where(eq(auditItems.id, item!.id));
  const values = { owner: "instructions", fix: title, evidence: [{ record: 12, quote: "precedent" }] };
  const [f] = await db()
    .insert(findings)
    .values({
      auditId: audit!.id,
      auditItemId: item!.id,
      reviewId: review!.id,
      spaceId,
      incidentId,
      kind,
      ordinal: 0,
      title,
      proposed: values,
      current: values,
      citations: [{ record: 12, quote: "root cause: monitor precedent", field: "fixes[0].evidence[0]", ok: true }],
      state,
      reviewedBy: state === "accepted" ? alex.email : null,
      reviewedAt: state === "accepted" ? new Date() : null,
    })
    .returning();
  return f!.id;
}

async function runSave(revisionId: string, request: Parameters<typeof requestSaveRevision>[2]): Promise<{ input: SaveRevisionInput; result: Awaited<ReturnType<typeof saveRevisionHandler>> }> {
  vi.mocked(enqueue).mockClear();
  await requestSaveRevision(space, revisionId, request, alex);
  const input = vi.mocked(enqueue).mock.calls[0]![1] as SaveRevisionInput;
  return { input, result: await saveRevisionHandler(input, ctx()) };
}

async function row(revisionId: string) {
  const [r] = await db().select().from(revisions).where(eq(revisions.id, revisionId));
  return r!;
}

async function actions(): Promise<{ action: string; result: string }[]> {
  return db().select({ action: auditEvents.action, result: auditEvents.result }).from(auditEvents).orderBy(asc(auditEvents.id));
}

beforeAll(async () => {
  await truncateAll();
  tmp = await useTempDataDir();
  repo = await HistoryRepo.open(cfg());
  const gitPaths = new Map<string, string>();
  for (const a of ASSETS) gitPaths.set(a.assetId, (await commitVersion(repo, layout, ALIAS, a)).gitPath);
  const [repoRow] = await db().insert(historyRepos).values({ name: cfg().name }).returning();
  const [spaceRow] = await db().insert(agentSpaces).values({ alias: ALIAS, region: "us-west-2", accountId: "111122223333", agentSpaceId: "space-rev", historyRepoId: repoRow!.id }).returning();
  const [otherRow] = await db().insert(agentSpaces).values({ alias: "other-space", region: "us-west-2", accountId: "111122223333", agentSpaceId: "space-other" }).returning();
  space = (await getSpaceById(spaceRow!.id))!;
  otherSpace = (await getSpaceById(otherRow!.id))!;
  for (const a of ASSETS) {
    await db()
      .insert(assetIndex)
      .values({
        spaceId: space.id,
        assetId: a.assetId,
        assetType: a.assetType,
        name: String(a.metadata.name ?? a.metadata.agent_type),
        parentAssetId: typeof a.metadata.memory_store_id === "string" ? a.metadata.memory_store_id : null,
        liveVersion: a.version,
        liveUpdatedAt: new Date(a.updatedAt),
        lastSyncedVersion: a.version,
        gitPath: gitPaths.get(a.assetId)!,
        metadata: a.metadata,
      });
  }
  // Release v1 of the space, tagged on the history repository's HEAD.
  const { prepareCreateRelease } = await import("@/server/releases/create");
  const input = await prepareCreateRelease({ spaceId: space.id, name: "v1" });
  await createReleaseHandler(input, testJobContext({ actor: { email: alex.email }, spaceId: space.id }), { sync: syncMock });
  releaseV1 = input.releaseId;

  F.fix = await seedFinding(space.id, "accepted", "fix", "Record precedents only as hypotheses", "INCIDENT-31495");
  F.diagnosis = await seedFinding(space.id, "accepted", "diagnosis", "INCIDENT-31499: kept a resolved gap open", "INCIDENT-31499");
  F.proposed = await seedFinding(space.id, "proposed", "fix", "Not reviewed yet", "INCIDENT-31500");
  F.otherSpace = await seedFinding(otherSpace.id, "accepted", "fix", "Another space's finding", "INCIDENT-1");
});

beforeEach(() => vi.mocked(enqueue).mockClear());

afterAll(async () => {
  await tmp.cleanup();
  restoreLayouts();
});

let revId = "";
let branch = "";
let mainHead = "";

describe("creating a revision from a release", () => {
  it("checks the name and the base before anything is queued", async () => {
    await expect(requestCreateRevision(space, { name: "bad name", base: { kind: "release", releaseId: releaseV1 }, layout: "strict-instructions" }, alex)).rejects.toMatchObject({ code: "name-invalid" });
    await expect(requestCreateRevision(space, { name: "v1", base: { kind: "release", releaseId: releaseV1 }, layout: "strict-instructions" }, alex)).rejects.toMatchObject({ code: "name-taken" });
    await expect(requestCreateRevision(space, { name: "v2", base: { kind: "release", releaseId: crypto.randomUUID() }, layout: "strict-instructions" }, alex)).rejects.toMatchObject({ code: "unknown-release" });
    await expect(requestCreateRevision(space, { name: "v2", base: { kind: "live" }, layout: "no-such-layout" }, alex)).rejects.toMatchObject({ code: "unknown-layout" });
    expect(vi.mocked(enqueue)).not.toHaveBeenCalled();
  });

  it("turns the release's assets into a package on a new branch, and runs the build", async () => {
    mainHead = (await repo.head())!;
    const requested = await requestCreateRevision(space, { name: "v2", base: { kind: "release", releaseId: releaseV1 }, layout: "strict-instructions", note: "Late October fixes" }, alex);
    revId = requested.revisionId;
    branch = requested.branch;
    expect(branch).toBe("revision/rev-space/v2");
    expect(vi.mocked(enqueue).mock.calls[0]![1]).toEqual({ revisionId: revId });
    await expect(requestCreateRevision(space, { name: "V2", base: { kind: "live" }, layout: "strict-instructions" }, alex)).rejects.toMatchObject({ code: "name-taken" });

    const result = await createRevisionHandler({ revisionId: revId }, ctx());
    expect(result).toMatchObject({ revisionId: revId, branch, build: "passed", resumed: false });
    const r = await row(revId);
    const [rel] = await db().select().from(releases).where(eq(releases.id, releaseV1));
    expect(r).toMatchObject({ state: "open", baseKind: "release", baseCommit: rel!.commit, createdCommit: result.createdCommit, headCommit: result.createdCommit, packageDir: "packages/rev-space/v2", layout: "strict-instructions" });
    expect(r.base).toMatchObject({ kind: "release", name: "v1", label: "release v1", fromRevisionId: null });
    expect(r.latestBuild).toMatchObject({ status: "passed", commit: result.createdCommit, errors: 0, assets: 5 });
    expect(r.latestBuild!.buildPaths).toEqual(expect.arrayContaining(["memory/runbooks/INDEX.md", "reference/VALIDATION.json", "skills/triage.zip"]));

    // The branch starts at the release commit and holds the package; the default branch did not move.
    expect(await repo.head()).toBe(mainHead);
    const files = (await repo.listTree(result.createdCommit, "packages/rev-space/v2")).map((e) => e.path.slice("packages/rev-space/v2/".length));
    expect(files).toEqual(["instructions/global.md", "instructions/incident-triage.md", "memory/runbooks/INDEX.md", "memory/runbooks/STORE.md", "memory/runbooks/failover.md", "reference/VALIDATION.json", "skills/triage.zip", "skills/triage/SKILL.md"]);
    const [first] = await repo.log({ ref: result.createdCommit, maxCount: 2 });
    expect(first).toMatchObject({ message: "Start revision v2 of rev-space from release v1", authorEmail: alex.email });
    expect(first!.trailers["Revision-Id"]).toBe(revId);
    expect(await repo.resolveCommit(`${result.createdCommit}^`)).toBe(rel!.commit);

    // A rerun of the job finishes the same revision.
    expect(await createRevisionHandler({ revisionId: revId }, ctx())).toMatchObject({ resumed: true, createdCommit: result.createdCommit });
  });
});

describe("saving a revision", () => {
  it("refuses links to findings that aren't accepted, linkable findings of the space, and unlinked saves without a reason", async () => {
    const edit = [{ path: "instructions/global.md", content: `${GLOBAL_MD}\nMore.\n` }];
    await expect(requestSaveRevision(space, revId, { message: "x", edits: edit, findingIds: [F.proposed] }, alex)).rejects.toMatchObject({ code: "finding-not-linkable" });
    await expect(requestSaveRevision(space, revId, { message: "x", edits: edit, findingIds: [F.otherSpace] }, alex)).rejects.toMatchObject({ code: "finding-not-linkable" });
    await expect(requestSaveRevision(space, revId, { message: "x", edits: edit, findingIds: [] }, alex)).rejects.toMatchObject({ code: "reason-required" });
    await expect(requestSaveRevision(space, revId, { message: "x", edits: [{ path: "../escape.md", content: "x" }], findingIds: [F.fix] }, alex)).rejects.toMatchObject({ code: "bad-request" });
    await expect(requestSaveRevision(space, revId, { message: "x", edits: edit, findingIds: [F.fix], expectedHead: "a".repeat(40) }, alex)).rejects.toMatchObject({ code: "moved" });
    await expect(requestSaveRevision(otherSpace, revId, { message: "x", edits: edit, findingIds: [F.fix] }, alex)).rejects.toBeInstanceOf(RevisionError);
    expect(vi.mocked(enqueue)).not.toHaveBeenCalled();
  });

  it("commits a linked change with its trailers, runs the build and keeps the default branch where it was", async () => {
    const before = await row(revId);
    // Drops one of the safety messages, so the package checks fail.
    const broken = GLOBAL_MD.replace(`${SAFETY[1]}\n`, "").concat("\nRecord a precedent from memory as a hypothesis and test its conditions.\n");
    const { input, result } = await runSave(revId, {
      message: "Record precedents\n  only as hypotheses",
      edits: [{ path: "instructions/global.md", content: broken }],
      findingIds: [F.fix, F.diagnosis, F.fix],
      expectedHead: before.headCommit,
    });
    expect(input.findingIds).toEqual([F.fix, F.diagnosis]);
    expect(result).toMatchObject({ build: "failed", changedPaths: ["instructions/global.md"], resumed: false });
    expect(result.buildPaths).toEqual(expect.arrayContaining(["reference/CHANGELOG.md", "reference/VALIDATION.json"]));
    expect(await repo.head()).toBe(mainHead);

    const [c] = await repo.log({ ref: result.commit, maxCount: 1 });
    expect(c).toMatchObject({ message: "Record precedents only as hypotheses", authorEmail: alex.email, authorName: "Alex" });
    const trailers = c!.body.trim().split("\n");
    expect(trailers).toEqual([`Revision-Id: ${revId}`, `Finding-Id: ${F.fix}`, `Finding-Id: ${F.diagnosis}`, `Revision-Change-Id: ${input.changeId}`, "Space: rev-space"]);
    expect(await repo.resolveCommit(`${result.commit}^`)).toBe(before.headCommit);

    const r = await row(revId);
    expect(r.headCommit).toBe(result.commit);
    expect(r.latestBuild).toMatchObject({ status: "failed", commit: result.commit });
    expect(r.latestBuild!.results.some((x) => x.code === "package.safety-message" && x.level === "error")).toBe(true);
    const [change] = await db().select().from(revisionChanges).where(eq(revisionChanges.id, input.changeId));
    expect(change).toMatchObject({ commit: result.commit, parentCommit: before.headCommit, changedPaths: ["instructions/global.md"], findingIds: [F.fix, F.diagnosis], buildStatus: "failed", author: alex.email, unlinkedReason: null });

    // The change record in the package cites the findings' audit, incident and evidence.
    const record = (await repo.readBlobs(result.commit, ["packages/rev-space/v2/reference/CHANGELOG.md"])).get("packages/rev-space/v2/reference/CHANGELOG.md")!.toString("utf8");
    expect(record).toContain("## v2, ");
    expect(record).toContain("Source: release v1.");
    expect(record).toContain(
      '| Record precedents only as hypotheses | `instructions/global.md` | Late October low scores | INCIDENT-31495; INCIDENT-31499 | Record precedents only as hypotheses; INCIDENT-31499: kept a resolved gap open | Record precedents only as hypotheses: R12 "root cause: monitor precedent"; INCIDENT-31499: kept a resolved gap open: R12 "root cause: monitor precedent" |',
    );

    // A retried job finds its own commit and does not commit twice.
    expect(await saveRevisionHandler(input, ctx())).toMatchObject({ commit: result.commit, resumed: true });
    expect(await repo.branchHead(branch)).toBe(result.commit);
  });

  it("refuses a plan while the build fails, and still downloads the package with a note", async () => {
    await expect(createPlanFromRevision(space, revId, alex)).rejects.toMatchObject({ code: "build-failed" });
    const res = await exportRevision(space, revId, alex);
    // A missing safety message is a layout text rule, not something the service refuses: the file stays.
    expect(res.leftOut).toEqual([]);
    const { entries, problems } = readZip(res.zip, policy.limits.packageRead);
    expect(problems).toEqual([]);
    const names = entries.map((e) => e.name);
    expect(names).toContain("v2/instructions/global.md");
    const note = entries.find((e) => e.name === "v2/reference/EXPORT-NOTES.md")!.data.toString();
    expect(note).toContain("# Export notes");
    expect(note).toContain("No asset was left out");
    expect(note).toContain("## Errors still in this package\n\n- instructions/global.md: ");
    const detail = await loadRevisionDetail(space, "v2", { permissions: ["audits.read", "revisions.build", "plans.create"], role: "publisher" });
    expect(detail!.actions.createPlan).toEqual({ available: false, reason: "The build and validation failed with 1 error. Fix it and save again." });
    expect(detail!.actions.export).toMatchObject({ available: true });
    expect(detail!.build!.leftOut).toEqual([]);
    const viewer = await loadRevisionDetail(space, revId, { permissions: ["audits.read"], role: "viewer" });
    expect(viewer!.actions.createPlan.reason).toMatch(/^Only .* can create plans\. You're a Viewer\.$/);
  });

  it("refuses a save from a stale head and an unchanged save", async () => {
    const r = await row(revId);
    await requestSaveRevision(space, revId, { message: "stale", edits: [{ path: "README.md", content: "# Package\n" }], findingIds: [], unlinkedReason: "The package needs a README.", expectedHead: r.headCommit }, alex);
    const input = vi.mocked(enqueue).mock.calls[0]![1] as SaveRevisionInput;
    await expect(saveRevisionHandler({ ...input, expectedHead: r.createdCommit }, ctx())).rejects.toMatchObject({ code: "moved" });
    const current = (await repo.readBlobs(r.headCommit!, ["packages/rev-space/v2/instructions/incident-triage.md"])).get("packages/rev-space/v2/instructions/incident-triage.md")!.toString("utf8");
    await expect(saveRevisionHandler({ ...input, changeId: crypto.randomUUID(), edits: [{ path: "instructions/incident-triage.md", encoding: "utf8", content: current }] }, ctx())).rejects.toMatchObject({ code: "nothing-changed" });
    expect(await repo.branchHead(branch)).toBe(r.headCommit);
  });

  it("passes after an unlinked fix with a reason, recorded in the change record", async () => {
    const { result, input } = await runSave(revId, {
      message: "Restore the security safety message",
      edits: [
        { path: "instructions/global.md", content: GLOBAL_MD.concat("\nRecord a precedent from memory as a hypothesis and test its conditions.\n") },
        { path: "README.md", content: "# v2 package\n" },
      ],
      findingIds: [],
      unlinkedReason: "The customer's exact safety responses must stay in place.",
    });
    expect(result).toMatchObject({ build: "passed", changedPaths: ["README.md", "instructions/global.md"] });
    const [c] = await repo.log({ ref: result.commit, maxCount: 1 });
    expect(c!.body).toContain("Unlinked-Reason: The customer's exact safety responses must stay in place.");
    expect(c!.body).not.toContain("Finding-Id");
    expect(c!.trailers["Revision-Change-Id"]).toBe(input.changeId);
    const record = (await repo.readBlobs(result.commit, ["packages/rev-space/v2/reference/CHANGELOG.md"])).get("packages/rev-space/v2/reference/CHANGELOG.md")!.toString("utf8");
    expect(record.match(/^\| (?!Change \||---)/gm)).toHaveLength(2);
    expect(record).toContain("| Restore the security safety message | `README.md`, `instructions/global.md` | None | None | None | Not linked to a finding: The customer's exact safety responses must stay in place. |");
    expect(await repo.head()).toBe(mainHead);
  });
});

let planId = "";

describe("plan, export and release", () => {
  it("creates a plan from the revision once the build passes", async () => {
    const res = await createPlanFromRevision(space, revId, alex);
    planId = res.planId;
    const [plan] = await db().select().from(plans).where(eq(plans.id, planId));
    expect(plan).toMatchObject({ title: "Apply revision v2", originKind: "revision", origin: { kind: "revision", revisionId: revId, name: "v2" }, state: "checking", createdBy: alex.email });
    expect(plan!.reason).toBe(
      "Revision v2: Record precedents only as hypotheses; Restore the security safety message. Findings: Record precedents only as hypotheses (Late October low scores); INCIDENT-31499: kept a resolved gap open (Late October low scores).",
    );
    const items = await db().select().from(planItems).where(eq(planItems.planId, planId));
    expect(items.map((i) => [i.assetType, i.assetKey, i.assetId])).toEqual([["agents_md", "GENERIC", ID.generic]]);
    expect(items[0]!.desired!.files[0]!.content).toContain("Record a precedent from memory as a hypothesis");
    const r = await row(revId);
    expect(r).toMatchObject({ planId, plannedCommit: r.headCommit });
    // A second plan waits until this one is applied or discarded.
    await expect(createPlanFromRevision(space, revId, alex)).rejects.toMatchObject({ code: "plan-open" });
    await expect(createPlanFromRevision(otherSpace, revId, alex)).rejects.toMatchObject({ code: "not-found" });
  });

  it("exports the package at the branch head as a zip", async () => {
    const res = await exportRevision(space, revId, alex);
    expect(res.fileName).toBe("v2.zip");
    expect(res.commit).toBe((await row(revId)).headCommit);
    const { entries, problems } = readZip(res.zip, policy.limits.packageRead);
    expect(problems).toEqual([]);
    const names = entries.map((e) => e.name);
    expect(names).toContain("v2/instructions/global.md");
    expect(names).toContain("v2/reference/CHANGELOG.md");
    expect(names.every((n) => n.startsWith("v2/"))).toBe(true);
    expect(entries.find((e) => e.name === "v2/README.md")!.data.toString()).toBe("# v2 package\n");
  });

  it("tags a release named after the revision when its plan finishes applying", async () => {
    // Simulated apply: the apply job's history commit on the default branch, then the plan ends "applied".
    const applied = await commitVersion(repo, layout, ALIAS, { ...ASSETS[0]!, version: 2, updatedAt: "2026-11-13T01:00:00.000Z", files: { "AGENTS.md": "applied\n" } }, ASSETS[0]);
    await db().update(plans).set({ state: "applied", resultCommit: applied.commit, applyStartedBy: alex.email, finishedAt: new Date() }).where(eq(plans.id, planId));
    vi.mocked(enqueue).mockClear();
    await notifyPlanApplied({ planId, spaceId: space.id, actor: { email: alex.email }, log: () => {} });

    const call = vi.mocked(enqueue).mock.calls.find((c) => c[0].name === "releases.create")!;
    expect(call[1]).toMatchObject({ spaceId: space.id, name: "v2", commit: applied.commit, planId, note: `Applied from revision v2 (plan ${planId}).` });
    const r = await row(revId);
    expect(r).toMatchObject({ state: "applied", releaseName: "v2", releaseError: null });
    expect(r.releaseId).toBe((call[1] as { releaseId: string }).releaseId);

    // The release job (worker) tags the apply's commit.
    const made = await createReleaseHandler(call[1] as never, testJobContext({ actor: { email: alex.email }, spaceId: space.id }));
    expect(made).toMatchObject({ name: "v2", tag: "rev-space/v2", sourceCommit: applied.commit });
    const manifest = parseManifest(await repo.show(made.commit, made.manifestPath))!;
    expect(manifest.release.planId).toBe(planId);

    // Idempotent: a second notification (a retried apply job) requests nothing.
    vi.mocked(enqueue).mockClear();
    await notifyPlanApplied({ planId, spaceId: space.id, actor: { email: alex.email }, log: () => {} });
    expect(vi.mocked(enqueue)).not.toHaveBeenCalled();

    const detail = await loadRevisionDetail(space, "v2", { permissions: ["audits.read", "revisions.build", "plans.create"] });
    expect(detail!.release).toMatchObject({ releaseId: made.releaseId, name: "v2", created: true });
    expect(detail!.actions.createPlan.reason).toBe("A plan from this revision was already applied and tagged as release v2. Start a new revision for further changes.");
    expect(detail!.actions.save.available).toBe(false);
  });

  it("starts the next revision from that release with the earlier revision's package files", async () => {
    const [rel] = await db().select().from(releases).where(and(eq(releases.spaceId, space.id), eq(releases.name, "v2")));
    const { revisionId } = await requestCreateRevision(space, { name: "v3", base: { kind: "release", releaseId: rel!.id }, layout: "strict-instructions" }, alex);
    const result = await createRevisionHandler({ revisionId }, ctx());
    const r = await row(revisionId);
    expect(r.base).toMatchObject({ kind: "release", name: "v2", fromRevisionId: revId });
    const pkg = await repo.readBlobs(result.createdCommit, ["packages/rev-space/v3/README.md", "packages/rev-space/v3/reference/CHANGELOG.md", "packages/rev-space/v3/instructions/global.md"]);
    expect(pkg.get("packages/rev-space/v3/README.md")!.toString()).toBe("# v2 package\n");
    expect(pkg.get("packages/rev-space/v3/reference/CHANGELOG.md")!.toString()).toContain("<!-- revision: v2 ");
    // The asset content is the release's (the applied version), not the earlier package's.
    expect(pkg.get("packages/rev-space/v3/instructions/global.md")!.toString()).toBe("applied\n");
  });

  it("makes one plan when a plan is requested twice at once", async () => {
    const { revisionId } = await requestCreateRevision(space, { name: "v4", base: { kind: "release", releaseId: releaseV1 }, layout: "strict-instructions" }, alex);
    await createRevisionHandler({ revisionId }, ctx());
    // A plan holds only what the revision changed, so it needs a save.
    await runSave(revisionId, { message: "Add a triage step", edits: [{ path: "instructions/incident-triage.md", content: "# Triage\n\nTriage rules.\nCheck onset first.\n" }], findingIds: [], unlinkedReason: "A plan needs a change to hold." });
    expect((await row(revisionId)).latestBuild?.status).toBe("passed");
    const slowPlan = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { planId: crypto.randomUUID(), checkRunId: crypto.randomUUID() };
    });
    const results = await Promise.allSettled([createPlanFromRevision(space, revisionId, alex, {}, { createPlan: slowPlan }), createPlanFromRevision(space, revisionId, alex, {}, { createPlan: slowPlan })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: "plan-open", message: "A plan is already being created from this revision." });
    expect(slowPlan).toHaveBeenCalledTimes(1);
    expect(await row(revisionId)).toMatchObject({ planClaimedAt: null });
    await abandonRevision(space, revisionId, alex);
  });
});

describe("a revision from the live space", () => {
  it("syncs first, reads HEAD, and can be abandoned while its branch stays", async () => {
    const { revisionId } = await requestCreateRevision(space, { name: "live-1", base: { kind: "live" }, layout: "strict-instructions" }, alex);
    syncMock.mockClear();
    await createRevisionHandler({ revisionId }, ctx(), { sync: syncMock });
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect((syncMock.mock.calls[0] as unknown[])[2]).toEqual({ mode: "reconcile" });
    const r = await row(revisionId);
    expect(r).toMatchObject({ state: "open", baseKind: "live", baseCommit: await repo.head() });
    expect(r.base.label).toBe("the live space");

    await abandonRevision(space, revisionId, alex, { note: "Superseded by v3" });
    expect(await row(revisionId)).toMatchObject({ state: "abandoned", abandonedBy: alex.email, stateReason: "Superseded by v3" });
    expect(await repo.branchHead(r.branch)).toBe(r.headCommit);
    await expect(requestSaveRevision(space, revisionId, { message: "x", edits: [{ path: "README.md", content: "x" }], findingIds: [F.fix] }, alex)).rejects.toMatchObject({ code: "not-open" });
    await expect(abandonRevision(space, revisionId, alex)).rejects.toMatchObject({ code: "not-open" });
  });

  it("marks the revision failed when the sync fails, and gives the name back", async () => {
    const { revisionId } = await requestCreateRevision(space, { name: "live-2", base: { kind: "live" }, layout: "strict-instructions" }, alex);
    const failing = vi.fn(async () => {
      throw new Error("throttled");
    });
    await expect(createRevisionHandler({ revisionId }, ctx(), { sync: failing as never })).rejects.toThrow(/sync of the space failed: throttled/);
    expect(await row(revisionId)).toMatchObject({ state: "failed" });
    // There is no package to download, so the export is still refused (and audited).
    await expect(exportRevision(space, revisionId, alex)).rejects.toMatchObject({ code: "export-blocked" });
    const again = await requestCreateRevision(space, { name: "live-2", base: { kind: "live" }, layout: "strict-instructions" }, alex);
    expect(again.revisionId).not.toBe(revisionId);
  });
});

describe("page loaders", () => {
  it("lists revisions with base, state, linked findings, build, plan and release", async () => {
    const list = await loadRevisionList(space);
    const v2 = list.revisions.find((r) => r.name === "v2")!;
    expect(v2).toMatchObject({ state: "applied", base: { kind: "release", label: "release v1" }, linkedFindings: 2, changes: 2, lastBuild: { status: "passed", current: true }, plan: { planId, state: "applied", outOfDate: false }, release: { name: "v2", created: true } });
    expect(list.revisions.map((r) => r.name).sort()).toEqual(["live-1", "live-2", "v2", "v3", "v4"]);
    expect((await loadRevisionList(otherSpace)).revisions).toEqual([]);
  });

  it("shows the file tree, a file, linked findings, the build, the change record and the diff against the base", async () => {
    const d = (await loadRevisionDetail(space, "v2", undefined, { path: "instructions/global.md", diffPath: "instructions/global.md" }))!;
    expect(d.repo).toEqual({ ok: true });
    expect(d.tree.find((t) => t.path === "instructions/global.md")).toMatchObject({ role: "asset", assetKey: "agents_md:GENERIC" });
    expect(d.tree.find((t) => t.path === "reference/CHANGELOG.md")).toMatchObject({ role: "non-asset", builtByLastSave: true });
    expect(d.file).toMatchObject({ path: "instructions/global.md", view: { kind: "text" } });
    expect(d.findings.map((f) => [f.id, f.state, f.changes])).toEqual(expect.arrayContaining([[F.fix, "accepted", 1], [F.diagnosis, "accepted", 1]]));
    expect(d.build).toMatchObject({ status: "passed" });
    expect(d.changelog).toContain("| Restore the security safety message |");
    expect(d.diff.files.map((f) => [f.status, f.path])).toEqual(
      expect.arrayContaining([
        ["added", "README.md"],
        ["added", "reference/CHANGELOG.md"],
        ["modified", "instructions/global.md"],
      ]),
    );
    expect(d.diff.text).toContain("+Record a precedent from memory as a hypothesis");
    expect(d.changes.map((c) => c.message)).toEqual(["Restore the security safety message", "Record precedents only as hypotheses"]);
    expect(await loadRevisionDetail(otherSpace, revId)).toBeNull();
    expect((await loadLinkableFindings(space)).map((f) => f.id).sort()).toEqual([F.fix, F.diagnosis].sort());
  });

  it("records every user action in the audit log", async () => {
    const seen = (await actions()).filter((a) => a.action.startsWith("revision."));
    expect(seen).toEqual(
      expect.arrayContaining([
        { action: "revision.create", result: "ok" },
        { action: "revision.create", result: "error" },
        { action: "revision.save", result: "ok" },
        { action: "revision.save", result: "error" },
        { action: "revision.plan", result: "ok" },
        { action: "revision.export", result: "ok" },
        { action: "revision.export", result: "error" },
        { action: "revision.release", result: "ok" },
        { action: "revision.abandon", result: "ok" },
      ]),
    );
  });
});

describe("a revision from a package import", () => {
  it("lays the import's files over the live space as the first save, and holds the import until abandoned", async () => {
    const { importPackage, createPlanFromImport } = await import("@/server/package-io/service");
    const { loadImportDetail } = await import("@/server/package-io/loaders");
    const { zipPackage } = await import("@/server/packages/build");
    const { syntheticPackage } = await import("./test-support");
    const upload = syntheticPackage("fix-me", {
      "skills/triage/SKILL.md": "---\nname: triage\ndescription: Triage steps\n---\nBetter triage body\n",
      "skills/probe/SKILL.md": "---\nname: probe\ndescription: Probe steps\n---\nProbe body\n",
      "instructions/incident-triage.md": null,
    });
    const imported = await importPackage(space, { upload: { kind: "zip", fileName: "fix-me.zip", bytes: zipPackage(upload) }, layout: "strict-instructions" }, alex);
    expect(imported.status).toBe("analyzed");

    await expect(requestCreateRevision(space, { name: "from-import", base: { kind: "release", releaseId: releaseV1 }, importId: imported.importId }, alex)).rejects.toMatchObject({ code: "bad-request" });
    const { revisionId } = await requestCreateRevision(space, { name: "from-import", base: { kind: "live" }, layout: "instruction-folders", importId: imported.importId }, alex);
    const result = await createRevisionHandler({ revisionId }, ctx(), { sync: syncMock });
    const r = await row(revisionId);
    // The import's layout wins over the request's, and the base names the file.
    expect(r).toMatchObject({ state: "open", baseKind: "live", layout: "strict-instructions" });
    expect(r.base).toMatchObject({ kind: "live", label: "the live space and fix-me.zip", fromImport: { importId: imported.importId, fileName: "fix-me.zip" } });
    expect(r.headCommit).not.toBe(r.createdCommit);
    expect(result.build).toBe(r.latestBuild!.status);

    // One save on top of the live export: the changed and the new skill. The triage instructions the package leaves out stay.
    const changes = await db().select().from(revisionChanges).where(eq(revisionChanges.revisionId, revisionId));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ message: "Add the files of fix-me.zip", findingIds: [], parentCommit: r.createdCommit, commit: r.headCommit });
    expect(changes[0]!.unlinkedReason).toContain("fix-me.zip");
    expect(changes[0]!.changedPaths).toEqual(expect.arrayContaining(["skills/probe/SKILL.md", "skills/triage/SKILL.md"]));
    expect(changes[0]!.changedPaths).not.toContain("instructions/incident-triage.md");
    const files = (await repo.listTree(r.headCommit!, r.packageDir)).map((e) => e.path.slice(r.packageDir.length + 1));
    expect(files).toEqual(expect.arrayContaining(["instructions/incident-triage.md", "skills/probe/SKILL.md"]));
    const [head] = await repo.log({ ref: r.headCommit!, maxCount: 1 });
    expect(head!.trailers["Revision-Change-Id"]).toBe((r.base as { fromImport: { changeId: string } }).fromImport.changeId);

    // A rerun adds nothing.
    expect(await createRevisionHandler({ revisionId }, ctx(), { sync: syncMock })).toMatchObject({ resumed: true });
    expect(await db().select().from(revisionChanges).where(eq(revisionChanges.revisionId, revisionId))).toHaveLength(1);

    // While the revision holds the import, the import can't make its own plan or a second revision.
    expect((await loadImportDetail(space, imported.importId))!.revision).toMatchObject({ current: { id: revisionId, name: "from-import" }, canStart: false });
    expect((await loadImportDetail(space, imported.importId))!.plan).toMatchObject({ canCreate: false, reason: expect.stringContaining("revision from-import") });
    await expect(createPlanFromImport(space, imported.importId, alex)).rejects.toMatchObject({ code: "in-revision" });
    await expect(requestCreateRevision(space, { name: "from-import-2", base: { kind: "live" }, importId: imported.importId }, alex)).rejects.toThrow(/already in revision from-import/);

    // Abandoning the revision gives the import back.
    await abandonRevision(space, revisionId, alex);
    expect((await loadImportDetail(space, imported.importId))!.revision).toEqual({ current: null, canStart: true, reason: null });
  });
});
