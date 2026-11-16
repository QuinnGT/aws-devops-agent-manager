import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useTempDataDir } from "@/server/assets/test-support/history-fixture";
import { db } from "@/server/db/client";
import { agentSpaces, assetIndex, auditItems, audits, findings, historyRepos, packageImports, planItems, plans, reviews } from "@/server/db/schema";
import { HistoryRepo, type HistoryRepoConfig } from "@/server/git/history-repo";
import { enqueue } from "@/server/jobs/enqueue";
import { testJobContext } from "@/server/jobs/registry";
import { getAppPolicy } from "@/server/policy";
import { createReleaseHandler, prepareCreateRelease } from "@/server/releases/create";
import { commitDelete, commitVersion, type TestAsset } from "@/server/releases/test-support";
import { getSpaceById, type Space } from "@/server/spaces/queries";
import { truncateAll } from "../../../test/helpers/db";
import { createRevisionHandler } from "./create";
import "./jobs";
import { usualLayout } from "./layouts";
import { loadRevisionDetail, loadRevisionList } from "./loaders";
import { saveRevisionHandler, type SaveRevisionInput } from "./save";
import { createPlanFromRevision, exportRevision, REVISION_PERMISSIONS, requestCreateRevision, requestSaveRevision } from "./service";
import { GLOBAL_MD, PACKAGE_FILES } from "./test-support";
import { loadRevisionPage, loadSaveFindings } from "./views";

/**
 * A revision from a release, end to end. Release v1.2 of the space; after it, the skill low-sample-size-check is deleted
 * live and token-signing-check is updated live (v4 to v5). A revision
 * from v1.2 edits one instruction file. Its plan must hold that file only,
 * and both the plan and the revision page name the two live changes it
 * leaves alone. Also: the revision page's plan state words, the save
 * dialog's owner labels, the usual layout, and the Viewer's package export.
 */

vi.mock("@/server/jobs/enqueue", () => ({ enqueue: vi.fn(async () => crypto.randomUUID()) }));

const policy = getAppPolicy().policy;
const layout = policy.historyLayout;
const ALIAS = "scope-space";
const alex = { email: "alex@example.com", name: "Alex" };
const syncMock = vi.fn(async (spaceId: string) => ({ spaceId, mode: "reconcile", status: "succeeded", listed: 0, changedAssets: 0, changes: 0, commits: 0, deferred: 0, deleted: 0, attributionFailed: false, pushed: false }) as never);
const id = (n: number) => `ki-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (d: number) => `2026-11-${String(d).padStart(2, "0")}T01:00:00.000Z`;
const skillMd = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} steps\n---\n${body}\n`;
const skill = (n: number, name: string, body: string, version = 4, updatedAt = at(1)): TestAsset => ({
  assetId: id(n),
  assetType: "skill",
  metadata: { name, description: `${name} steps`, agent_types: ["INCIDENT_TRIAGE", "INCIDENT_RCA"], status: "ACTIVE", skill_type: "USER" },
  version,
  updatedAt,
  files: { "SKILL.md": skillMd(name, body) },
});

const SAMPLE = skill(6, "low-sample-size-check", "Check the denominator.");
const SURGE = skill(7, "token-signing-check", "Compare with the day before.");
const SURGE_LIVE: TestAsset = { ...SURGE, version: 5, updatedAt: at(12), files: { "SKILL.md": skillMd("token-signing-check", "Compare with the same weekday a week earlier.") } };
const ASSETS: TestAsset[] = [
  { assetId: id(1), assetType: "agents_md", metadata: { agent_type: "GENERIC", status: "ACTIVE" }, version: 4, updatedAt: at(1), files: { "AGENTS.md": GLOBAL_MD } },
  { assetId: id(2), assetType: "agents_md", metadata: { agent_type: "INCIDENT_TRIAGE", status: "ACTIVE" }, version: 4, updatedAt: at(1), files: { "AGENTS.md": PACKAGE_FILES["instructions/incident-triage.md"]! } },
  skill(3, "triage", "Triage body"),
  { assetId: id(4), assetType: "memory_store", metadata: { name: "runbooks", description: "Runbooks", agent_types: ["INCIDENT_TRIAGE", "INCIDENT_RCA"], status: "ACTIVE" }, version: 4, updatedAt: at(1), files: { "runbooks.md": "# Runbooks\n" } },
  {
    assetId: id(5),
    assetType: "memory",
    metadata: { name: "failover", description: "Database failover", memory_store_id: id(4), status: "ACTIVE" },
    version: 4,
    updatedAt: at(1),
    files: { "failover.md": PACKAGE_FILES["memory/runbooks/failover.md"]! },
    storeName: "runbooks",
  },
  SAMPLE,
  SURGE,
];

let tmp: Awaited<ReturnType<typeof useTempDataDir>>;
let repo: HistoryRepo;
let space: Space;
let releaseId = "";
let revId = "";
let findingId = "";
const ctx = () => testJobContext({ actor: { email: alex.email }, spaceId: space.id });

async function runSave(revisionId: string, request: Parameters<typeof requestSaveRevision>[2]) {
  vi.mocked(enqueue).mockClear();
  await requestSaveRevision(space, revisionId, request, alex);
  return saveRevisionHandler(vi.mocked(enqueue).mock.calls[0]![1] as SaveRevisionInput, ctx());
}

async function newRevision(name: string): Promise<string> {
  const created = await requestCreateRevision(space, { name, base: { kind: "release", releaseId }, layout: "instruction-folders" }, alex);
  await createRevisionHandler({ revisionId: created.revisionId }, ctx());
  return created.revisionId;
}

async function fileAt(revisionId: string, p: string): Promise<string> {
  const page = (await loadRevisionDetail(space, revisionId, undefined, { path: p }))!;
  return (page.file!.view as { text: string }).text;
}

beforeAll(async () => {
  await truncateAll();
  tmp = await useTempDataDir();
  const cfg: HistoryRepoConfig = { id: "00000000-0000-4000-8000-0000000000f3", name: "scope-space-history", remoteUrl: null, deployKeyFile: null, defaultBranch: "main", pushEnabled: false };
  repo = await HistoryRepo.open(cfg);
  const paths = new Map<string, string>();
  for (const a of ASSETS) paths.set(a.assetId, (await commitVersion(repo, layout, ALIAS, a)).gitPath);
  const [repoRow] = await db().insert(historyRepos).values({ name: cfg.name }).returning();
  const [row] = await db().insert(agentSpaces).values({ alias: ALIAS, region: "us-west-2", accountId: "111122223333", agentSpaceId: "space-scope", historyRepoId: repoRow!.id }).returning();
  space = (await getSpaceById(row!.id))!;
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
        gitPath: paths.get(a.assetId)!,
        metadata: a.metadata,
      });
  }
  const input = await prepareCreateRelease({ spaceId: space.id, name: "v1.2" });
  await createReleaseHandler(input, ctx(), { sync: syncMock });
  releaseId = input.releaseId;

  // After v1.2, in the live space (recorded by sync): one skill deleted, another updated.
  await commitDelete(repo, layout, ALIAS, SAMPLE, at(11));
  await db().update(assetIndex).set({ deletedAt: new Date(at(11)) }).where(and(eq(assetIndex.spaceId, space.id), eq(assetIndex.assetId, SAMPLE.assetId)));
  await commitVersion(repo, layout, ALIAS, SURGE_LIVE, SURGE);
  await db().update(assetIndex).set({ liveVersion: 5, lastSyncedVersion: 5, liveUpdatedAt: new Date(at(12)) }).where(and(eq(assetIndex.spaceId, space.id), eq(assetIndex.assetId, SURGE.assetId)));

  // An accepted fix whose owner is a profile code.
  const [audit] = await db()
    .insert(audits)
    .values({ spaceId: space.id, name: "Late October, all decided", profileId: "benchmark", profileSnapshot: policy.audits.profiles.benchmark!, policyDigest: "test", state: "reviewing", createdBy: alex.email })
    .returning();
  const [item] = await db().insert(auditItems).values({ auditId: audit!.id, spaceId: space.id, taskId: "task-31801", incidentId: "INCIDENT-31801", state: "reviewed" }).returning();
  const [review] = await db().insert(reviews).values({ auditId: audit!.id, auditItemId: item!.id, spaceId: space.id, runner: "ai-sdk", modelId: "mock", promptDigest: "d", state: "succeeded", startedBy: alex.email }).returning();
  await db().update(auditItems).set({ currentReviewId: review!.id }).where(eq(auditItems.id, item!.id));
  const values = { owner: "customer_memory", fix: "In incident-triage.md, test the client-input hypothesis first for fast-fail 5xx", evidence: [{ record: 12, quote: "q" }] };
  const [f] = await db()
    .insert(findings)
    .values({ auditId: audit!.id, auditItemId: item!.id, reviewId: review!.id, spaceId: space.id, incidentId: "INCIDENT-31801", kind: "fix", ordinal: 0, title: values.fix, proposed: values, current: values, citations: [{ record: 12, quote: "q", field: "fixes[0].evidence[0]", ok: true }], state: "accepted", reviewedBy: alex.email, reviewedAt: new Date() })
    .returning();
  findingId = f!.id;

  // The revision of the review: from v1.2, one instruction file edited.
  revId = await newRevision("cart-selection-fix");
  const triage = await fileAt(revId, "instructions/incident-triage.md");
  await runSave(revId, { message: "Test the client-input hypothesis first for fast-fail 5xx", edits: [{ path: "instructions/incident-triage.md", content: `${triage}\n## Fast-fail 5xx\n\nTest the client-input hypothesis first.\n` }], findingIds: [findingId] });
});

afterAll(async () => {
  await tmp.cleanup();
});

describe("a plan from a revision holds only the revision's changes", () => {
  it("plans the edited instruction file and names the skill deleted and the skill updated live after v1.2", async () => {
    const page = (await loadRevisionPage(space, "cart-selection-fix"))!;
    expect(page.scope).toEqual({
      changed: ["Incident triage instructions"],
      leftAlone: [
        "Skill low-sample-size-check changed in the live space after v1.2; a plan from this revision leaves it as it is.",
        "Skill token-signing-check changed in the live space after v1.2; a plan from this revision leaves it as it is.",
      ],
      conflicts: [],
      after: "v1.2",
    });

    const res = await createPlanFromRevision(space, revId, alex);
    expect(res.items).toBe(1);
    const items = await db().select().from(planItems).where(eq(planItems.planId, res.planId));
    expect(items.map((i) => [i.assetType, i.assetKey, i.assetId, i.baseVersion])).toEqual([["agents_md", "INCIDENT_TRIAGE", id(2), 4]]);
    const [plan] = await db().select().from(plans).where(eq(plans.id, res.planId));
    expect(plan!.notes).toEqual([
      "4 assets in the revision already match the space and are left out.",
      "Skill low-sample-size-check changed in the live space after v1.2; this plan leaves it as it is.",
      "Skill token-signing-check changed in the live space after v1.2; this plan leaves it as it is.",
    ]);
  });

  it("shows the plan's state the way the plan page does: Check failed, not Ready", async () => {
    const r = (await loadRevisionDetail(space, revId))!;
    await db()
      .update(plans)
      .set({ state: "ready", checkError: "CredentialsProviderError: Could not resolve credentials using profile: [dam-demo-no-aws]" })
      .where(eq(plans.id, r.plan!.planId));
    const after = (await loadRevisionDetail(space, revId))!;
    expect(after.plan).toMatchObject({ state: "ready", checkFailed: true, validationFailed: false });
    expect((await loadRevisionList(space)).revisions.find((x) => x.id === revId)!.plan).toMatchObject({ checkFailed: true });
    // While the plan is open, the page still lists what a plan leaves alone.
    expect((await loadRevisionPage(space, revId))!.scope?.leftAlone).toHaveLength(2);
  });

  it("carries the base version of an asset that changed on both sides, so the plan check flags it", async () => {
    const both = await newRevision("surge-and-sample");
    const surge = await fileAt(both, "skills/token-signing-check/SKILL.md");
    const sample = await fileAt(both, "skills/low-sample-size-check/SKILL.md");
    await runSave(both, {
      message: "Compare surges with the same hour and keep the sample-size check",
      edits: [
        { path: "skills/token-signing-check/SKILL.md", content: `${surge}\nCompare with the same hour a week earlier.\n` },
        { path: "skills/low-sample-size-check/SKILL.md", content: `${sample}\nSay how many samples the claim rests on.\n` },
      ],
      findingIds: [],
      unlinkedReason: "Both skills need these steps.",
    });
    const page = (await loadRevisionPage(space, both))!;
    expect(page.scope!.leftAlone).toEqual([]);
    expect(page.scope!.conflicts).toEqual([
      "Skill low-sample-size-check changed in this revision but was deleted from the live space after v1.2. A plan from this revision creates it again; discard the plan if it should stay deleted.",
      "Skill token-signing-check changed in this revision and in the live space after v1.2 (v4 in v1.2, v5 live). Apply skips it until you compare both versions and re-check the plan.",
    ]);
    const res = await createPlanFromRevision(space, both, alex);
    const items = await db().select().from(planItems).where(eq(planItems.planId, res.planId));
    expect(items.map((i) => [i.assetKey, i.assetId, i.baseVersion]).sort()).toEqual([
      ["low-sample-size-check", null, null],
      ["token-signing-check", SURGE.assetId, 4],
    ]);
  });

  it("refuses a plan when the saves changed no asset", async () => {
    const readme = await newRevision("readme-only");
    await runSave(readme, { message: "Describe the package", edits: [{ path: "README.md", content: "# Package notes\n" }], findingIds: [], unlinkedReason: "The README is not an asset." });
    await expect(createPlanFromRevision(space, readme, alex)).rejects.toMatchObject({ code: "nothing-to-plan", message: "No asset in the revision changed against release v1.2, so there is nothing to plan." });
  });
});

describe("other revision screens", () => {
  it("lets a Viewer export the package zip (audits.read)", async () => {
    expect(REVISION_PERMISSIONS.export).toBe("audits.read");
    const viewer = (await loadRevisionDetail(space, revId, { permissions: ["audits.read"], role: "viewer" }))!;
    expect(viewer.actions.export).toEqual({ available: true, reason: null });
    expect(viewer.actions.save.available).toBe(false);
    const zip = await exportRevision(space, revId, { email: "viewer@example.com" });
    expect(zip.fileName).toBe("cart-selection-fix.zip");
  });

  it("labels finding owners with the profile's words and gives the dialog the finding's text", async () => {
    const [f] = await loadSaveFindings(space);
    expect(f).toMatchObject({ id: findingId, owner: "Customer memory or runbook content", ownerLabel: "Owner", kindLabel: "Fix" });
    expect(f!.text).toContain("In incident-triage.md");
  });

  it("starts a new revision with the layout of the space's last import", async () => {
    expect(await usualLayout(space.id, policy)).toMatchObject({ name: policy.packageLayouts.defaultLayout, source: "default" });
    await db().insert(packageImports).values({ spaceId: space.id, fileName: "anycompany-instructions-v2.zip", source: "zip", sha256: "0".repeat(64), sizeBytes: 10, layout: "agent-space-folders", status: "planned", importedBy: alex.email });
    expect(await usualLayout(space.id, policy)).toMatchObject({ name: "agent-space-folders", source: "import" });
  });
});
