import { randomUUID } from "node:crypto";
import path from "node:path";
import { eq } from "drizzle-orm";
import { CloudTrailClient, LookupEventsCommand } from "@aws-sdk/client-cloudtrail";
import { mockClient } from "aws-sdk-client-mock";
import { permissionsForRole } from "@/server/auth/roles";
import { openSpaceHistoryRepo } from "@/server/assets/repo";
import { db } from "@/server/db/client";
import { drafts as draftsTable, journalExecutions, journalRecords, journalTasks } from "@/server/db/schema";
import { createDraftFromAsset, createPlanFromDrafts, updateDraft } from "@/server/drafts/service";
import { fakeReader, installWrites } from "@/server/plans/testing";
import { startApply } from "@/server/plans/service";
import type { Policy } from "@/server/policy";
import { requestCreateRelease } from "@/server/releases/jobs";
import { parseManifest } from "@/server/releases/manifest";
import { getReleaseByName } from "@/server/releases/queries";
import type { Space } from "@/server/spaces/queries";
import { syncSpace } from "@/server/sync/engine";
import type { FakeAsset, FakeSpace } from "@/server/sync/testing/fake-space";
import { fileKey, releasePackageFiles } from "@/server/verify/package-files";
import { requestVerification } from "@/server/verify/service";
import { syntheticBundle } from "@/server/verify/test-support";
import { logger, type SeedPerson } from "../lib/common";
import { runQueued } from "../lib/jobs";

/**
 * The release Verification tab's part of the demo.
 * Against a mocked Agent Space (aws-sdk-client-mock, no AWS calls), with the
 * jobs run in this process:
 *
 *   - a baseline sync and a first release from the live state (no checks, no
 *     investigations since: the empty states)
 *   - a plan with two drafts (a memory and a skill), checked and applied
 *   - a second release, tagged after that plan
 *   - live changes since: one skill changed, one deleted, one added
 *   - five investigations after the release; one read the memory's older
 *     body (from the first release), two requested the deleted skill and got
 *     nothing back
 *   - both checks run: live state and what the agent read
 *
 * The story's names, texts and incidents come from the caller (parts/story.ts
 * has the sample dataset's).
 */

const log = logger("verify");

/** What the story changes. Asset IDs are of the fake space. */
export interface VerifyStory {
  planMemoryId: string;
  planSkillId: string;
  changedSkillId: string;
  deletedSkillId: string;
  /** Names of the two releases: the baseline and the one after the plan */
  firstReleaseName: string;
  releaseName: string;
  /** The whole new text of the plan memory's main file and of the plan skill's SKILL.md, and the skill's new description (it must match the SKILL.md frontmatter) */
  memoryText: string;
  skillText: string;
  skillDescription: string;
  /** Appended to the changed skill's main file after the release */
  changedNote: string;
  planTitle: string;
  planReason: string;
  releaseNote: string;
  /** The skill added live after the release: its metadata and the whole text of its SKILL.md */
  added: { name: string; description: string; agentTypes: string[]; text: string };
  /** Titles and incident IDs of the five investigations after the release */
  investigations: { incident: string; title: string }[];
}

export interface Mocks {
  fake: FakeSpace;
  restore(): void;
}

/** Install the fake Agent Space (reads and writes) and a CloudTrail with no events. */
export function installMocks(fake: FakeSpace): Mocks {
  fake.install();
  installWrites(fake, { clock: new Date(Date.now() - 60 * 60_000), createDefaults: { status: "ACTIVE" } });
  const trail = mockClient(CloudTrailClient);
  trail.on(LookupEventsCommand).resolves({ Events: [] });
  return {
    fake,
    restore: () => {
      trail.restore();
      fake.restore();
    },
  };
}

/** The asset of this type whose latest version has this metadata name. */
export function byName(fake: FakeSpace, type: string, name: string): FakeAsset | undefined {
  return [...fake.assets.values()].find((a) => a.assetType === type && a.versions.at(-1)!.metadata.name === name);
}

const mainFile = (a: FakeAsset) => a.versions.at(-1)!.files.find((f) => f.path === "SKILL.md") ?? a.versions.at(-1)!.files[0]!;

/** The files the agent reads for each asset of a release (deployed path, file path in the asset, body), by asset ID. */
async function deployedFiles(space: Space, policy: Policy, releaseName: string) {
  const release = (await getReleaseByName(space.id, releaseName))!;
  const manifest = parseManifest(release.manifest);
  const opened = await openSpaceHistoryRepo(space, policy.historyLayout);
  if (!manifest || !opened.ok) throw new Error(`release ${releaseName} can't be read`);
  const { files, origins } = await releasePackageFiles(opened.repo, manifest, policy);
  const out = new Map<string, { deployedPath: string; filePath: string; body: string }[]>();
  for (const f of files) {
    const o = origins.get(fileKey(f));
    if (!o) continue;
    out.set(o.assetId, [...(out.get(o.assetId) ?? []), { deployedPath: o.deployedPath, filePath: o.filePath, body: f.body }]);
  }
  return { release, files: out };
}

export interface VerifyScreens {
  firstRelease: string;
  release: string;
  planId: string;
  investigations: string[];
  /** Assets the story changed: the plan's memory and skill, the skill changed and the one deleted after the release */
  assetIds: string[];
}

/**
 * Seed the Verification tab. The mocks are installed and the space's first
 * sync has not run yet. `actor` needs plans.create and plans.apply (the seed
 * gives it the admin role's permissions).
 */
export async function seedVerification(space: Space, policy: Policy, mocks: Mocks, story: VerifyStory, person: SeedPerson): Promise<VerifyScreens> {
  const { fake } = mocks;
  const spaceId = space.id;
  const actor = { ...person, permissions: permissionsForRole(policy, "admin") };
  const reader = fakeReader(fake, policy).reader;
  const asset = (id: string) => {
    const a = fake.assets.get(id);
    if (!a) throw new Error(`the fake space has no asset ${id}`);
    return a;
  };

  await syncSpace(spaceId, { actor: { email: "system:seed" } });
  log("baseline sync done");

  // An earlier release made from the live state: no checks and no investigations in its window (the empty states)
  const first = await requestCreateRelease({ spaceId, name: story.firstReleaseName, note: "Baseline after the first sync." }, actor);
  await runQueued(first.runId, `release ${story.firstReleaseName}`);

  // ---------- plan: new versions of a memory and a skill ----------
  const memory = asset(story.planMemoryId);
  const skill = asset(story.planSkillId);
  const drafts: string[] = [];
  for (const [a, file, text, description] of [
    [memory, memory.versions.at(-1)!.files.find((f) => f.path.endsWith(".md")) ?? memory.versions.at(-1)!.files[0]!, story.memoryText, null],
    [skill, mainFile(skill), story.skillText, story.skillDescription],
  ] as const) {
    const d = await createDraftFromAsset({ spaceId, assetId: a.assetId }, actor, { reader });
    const [draft] = await db().select({ desired: draftsTable.desired }).from(draftsTable).where(eq(draftsTable.id, d.draftId));
    await updateDraft({ spaceId, draftId: d.draftId, files: [{ path: file.path, content: text }], ...(description ? { metadata: { ...draft!.desired.metadata, description } } : {}) }, actor);
    drafts.push(d.draftId);
  }
  const plan = await createPlanFromDrafts({ spaceId, draftIds: drafts, title: story.planTitle, reason: story.planReason }, actor);
  await runQueued(plan.checkRunId, "plan check");
  const apply = await startApply({ spaceId, planId: plan.planId, reason: story.planReason }, actor);
  await runQueued(apply.applyRunId, "plan apply");
  log(`plan ${plan.planId} applied`);

  const created = await requestCreateRelease({ spaceId, name: story.releaseName, note: story.releaseNote, planId: plan.planId }, actor);
  await runQueued(created.runId, `release ${story.releaseName}`);
  log(`release ${story.releaseName} tagged`);

  // ---------- what the agent reads, before the live changes ----------
  const older = (await deployedFiles(space, policy, story.firstReleaseName)).files;
  const { release, files: current } = await deployedFiles(space, policy, story.releaseName);
  const read = (files: Map<string, { deployedPath: string; filePath: string; body: string }[]>, id: string) => {
    const f = files.get(id)?.[0];
    if (!f) throw new Error(`release has no compared file for ${id}`);
    return f;
  };
  const memoryNow = read(current, memory.assetId);
  const memoryBefore = read(older, memory.assetId);
  const skillNow = read(current, skill.assetId);
  const deletedPath = read(current, story.deletedSkillId).deployedPath;
  const changedFile = read(current, story.changedSkillId);

  // ---------- live changes since the release ----------
  const changed = asset(story.changedSkillId);
  const later = (s: number) => new Date(Date.now() + s * 1000).toISOString();
  fake.addVersion(changed.assetId, { updatedAt: later(1), files: changed.versions.at(-1)!.files.map((f) => (f.path === changedFile.filePath ? { ...f, text: `${(f.text ?? "").replace(/\n*$/, "\n")}${story.changedNote}` } : { ...f })) });
  const changedBody = changed.versions.at(-1)!.files.find((f) => f.path === changedFile.filePath)?.text ?? "";
  fake.remove(story.deletedSkillId);
  fake.add({
    assetId: `ki-${randomUUID()}`,
    assetType: "skill",
    versions: [
      {
        version: 1,
        createdAt: later(2),
        updatedAt: later(2),
        metadata: { name: story.added.name, description: story.added.description, agent_types: story.added.agentTypes, status: "ACTIVE", skill_type: "USER" },
        files: [{ path: "SKILL.md", text: story.added.text, mimeType: "text/markdown" }],
      },
    ],
  });

  // ---------- investigations after the release (stored the way the journals module stores them) ----------
  const store = `${path.posix.dirname(memoryNow.deployedPath)}/`;
  const readsOf: { path: string; body: string | null }[][] = [
    [
      { path: memoryBefore.deployedPath, body: memoryBefore.body },
      { path: skillNow.deployedPath, body: skillNow.body },
    ],
    [
      { path: memoryNow.deployedPath, body: memoryNow.body },
      { path: deletedPath, body: null },
    ],
    [{ path: changedFile.deployedPath, body: changedBody }],
    [
      { path: deletedPath, body: null },
      { path: memoryNow.deployedPath, body: memoryNow.body },
      { path: skillNow.deployedPath, body: skillNow.body },
    ],
    [{ path: store, body: `${path.posix.basename(memoryNow.deployedPath)}\n` }],
  ];
  const t0 = release.createdAt.getTime();
  const taskIds: string[] = [];
  for (const [i, inv] of story.investigations.slice(0, readsOf.length).entries()) {
    const taskId = `seed-inv-${i + 1}`;
    const bundle = syntheticBundle({ spaceId, taskId, incidentId: inv.incident, createdAt: new Date(t0 + (i + 1) * 1000), reads: readsOf[i]! });
    bundle.task.title = inv.title;
    await db().insert(journalTasks).values({ spaceId, taskId: bundle.task.taskId, incidentId: bundle.task.incidentId, title: bundle.task.title, taskType: bundle.task.taskType, status: bundle.task.status, priority: bundle.task.priority, reference: bundle.task.reference, createdAt: bundle.task.createdAt, updatedAt: bundle.task.updatedAt, source: "api", raw: bundle.task.raw });
    await db().insert(journalExecutions).values(bundle.executions.map((e) => ({ ...e, spaceId })));
    await db().insert(journalRecords).values(bundle.records.map((r) => ({ ...r, spaceId, content: r.content, sizeBytes: JSON.stringify(r.raw).length })));
    taskIds.push(taskId);
  }
  log(`${taskIds.length} investigations after the release`);

  // ---------- both checks ----------
  const live = await requestVerification({ spaceId, releaseId: release.id, kind: "live" }, actor);
  await runQueued(live.runId, "live check");
  const reads = await requestVerification({ spaceId, releaseId: release.id, kind: "reads" }, actor);
  await runQueued(reads.runId, "reads check");
  log("live state and agent-read checks done");

  const firstRelease = (await getReleaseByName(spaceId, story.firstReleaseName))!;
  return {
    firstRelease: firstRelease.name,
    release: release.name,
    planId: plan.planId,
    investigations: taskIds,
    assetIds: [story.planMemoryId, story.planSkillId, story.changedSkillId, story.deletedSkillId],
  };
}
