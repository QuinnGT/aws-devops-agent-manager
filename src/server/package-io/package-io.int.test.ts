import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHistoryFixture, fixtureAssets, fixtureRepoConfig, IDS, SPACE_FIXTURE, TEST_ALIAS, useTempDataDir, type BuiltFixture } from "@/server/assets/test-support/history-fixture";
import { db } from "@/server/db/client";
import { agentSpaces, assetIndex, auditEvents, historyRepos, packageImports } from "@/server/db/schema";
import { HistoryRepo } from "@/server/git/history-repo";
import { assetDisplayName } from "@/server/history/layout";
import { testJobContext } from "@/server/jobs/registry";
import { zipPackage } from "@/server/packages/build";
import { packageFromFiles, readPackageFolder, readPackageZip } from "@/server/packages/read";
import { addOverlays } from "@/server/packages/test-support/policy";
import type { CreatePlanInput } from "@/server/plans/contract";
import { getAppPolicy } from "@/server/policy";
import { getSpaceById, type Space } from "@/server/spaces/queries";
import { sha256Hex } from "@/server/sync/content";
import { readZip, writeZip } from "@/server/packages/zip";
import { apiFixture, SAMPLE_DATA_DIR, samplePackageDir } from "../../../test/helpers/fixtures";
import { truncateAll } from "../../../test/helpers/db";
import { runExpireUploads } from "./expire";
import { readSnapshotsAtCommit } from "./history";
import { loadExportOptions, loadImportDetail, loadImportList } from "./loaders";
import { checksFailedMessage, createPlanFromImport, exportDownloadHeaders, exportPackage, getImportRow, importPackage, previewExport } from "./service";
import { packageImportsDir } from "./storage";
import { PackageIoError } from "./types";

const plans = vi.hoisted(() => ({ calls: [] as CreatePlanInput[], fail: false }));
// Most export tests read the zip of a package that fails its layout's checks (no base package), so the block is off unless a test turns it on.
const exportPolicy = vi.hoisted(() => ({ block: false }));
vi.mock("@/server/journals/policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/journals/policy")>();
  return {
    ...actual,
    policyForSpace: vi.fn(async (s: Parameters<typeof actual.policyForSpace>[0]) => {
      const loaded = await actual.policyForSpace(s);
      const p = loaded.policy;
      return { ...loaded, policy: { ...p, packageIo: { ...p.packageIo, export: { ...p.packageIo.export, blockOnFailedChecks: exportPolicy.block } } } };
    }),
  };
});
vi.mock("@/server/plans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/plans")>();
  return {
    ...actual,
    createPlan: vi.fn(async (input: CreatePlanInput) => {
      if (plans.fail) throw new Error("plans service unavailable");
      plans.calls.push(input);
      return { planId: `00000000-0000-4000-8000-${String(plans.calls.length).padStart(12, "0")}`, checkRunId: "00000000-0000-4000-9000-000000000001" };
    }),
  };
});

// The sample policy overlay adds the AnyCompany layouts, so the sample package can be imported by name or detected.
const restoreOverlay = addOverlays([path.join(SAMPLE_DATA_DIR, "policy")]);
const policy = getAppPolicy().policy;
const actor = { email: "editor@example.com", name: "Editor" };

let tmp: Awaited<ReturnType<typeof useTempDataDir>>;
let repo: HistoryRepo;
let built: BuiltFixture;
let space: Space;
let otherSpace: Space;

const agentsMdText = apiFixture<{ file: { content: { text: string } } }>("GetAssetFile.agents_md").response.file.content.text;

async function auditActions(action: string) {
  return db()
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.spaceId, space.id)));
}

beforeAll(async () => {
  await truncateAll();
  tmp = await useTempDataDir();
  const cfg = fixtureRepoConfig("pkgio-history");
  repo = await HistoryRepo.open(cfg);
  built = await buildHistoryFixture(repo, fixtureAssets(), policy.historyLayout);
  // A release of the space at the agents_md version 5 commit.
  await repo.tag(`${TEST_ALIAS}/v1`, "Release v1", built.byAsset.get(IDS.agentsMd)![1]!.commit);

  const [repoRow] = await db().insert(historyRepos).values({ name: cfg.name }).returning();
  const [row] = await db()
    .insert(agentSpaces)
    .values({ alias: TEST_ALIAS, region: SPACE_FIXTURE.region, accountId: SPACE_FIXTURE.accountId, agentSpaceId: SPACE_FIXTURE.agentSpaceId, historyRepoId: repoRow!.id })
    .returning();
  const [other] = await db().insert(agentSpaces).values({ alias: "other-space", region: "us-east-1", accountId: SPACE_FIXTURE.accountId, agentSpaceId: "other" }).returning();
  space = (await getSpaceById(row!.id))!;
  otherSpace = (await getSpaceById(other!.id))!;

  for (const a of fixtureAssets()) {
    const last = a.versions.at(-1)!;
    await db()
      .insert(assetIndex)
      .values({
        spaceId: space.id,
        assetId: a.assetId,
        assetType: a.assetType,
        name: assetDisplayName(policy.historyLayout, { assetId: a.assetId, assetType: a.assetType, metadata: last.metadata }),
        parentAssetId: a.parentAssetId ?? null,
        liveVersion: last.version,
        liveUpdatedAt: new Date(last.updatedAt),
        lastSyncedVersion: last.version,
        lastSyncedUpdatedAt: new Date(last.updatedAt),
        gitPath: built.gitPaths.get(a.assetId)!,
        lastCommit: built.byAsset.get(a.assetId)!.at(-1)!.commit,
        metadata: last.metadata,
        createdAt: new Date(last.createdAt),
      });
  }
});

afterAll(async () => {
  await tmp.cleanup();
  restoreOverlay();
});

beforeEach(() => {
  plans.calls.length = 0;
  plans.fail = false;
  exportPolicy.block = false;
});

describe("package import of the sample package v2", () => {
  const LAYOUT = "anycompany-v2";
  let zip: Buffer;
  let folder: { path: string; data: Buffer }[];
  let badMemoryName: Buffer;
  let importId: string;

  beforeAll(async () => {
    const contents = await readPackageFolder(samplePackageDir("v2"), { policy, layout: LAYOUT });
    zip = zipPackage(contents, "sample-package-v2");
    folder = [...contents.files].map(([p, data]) => ({ path: `sample-package-v2/${p}`, data }));
    // A memory name the service rejects (an underscore): the plan is blocked.
    const files = Object.fromEntries(contents.files);
    const body = files["memory/runbooks/log-query-limits.md"]!.toString("utf8").replace("name: log-query-limits", "name: log_query_limits");
    delete files["memory/runbooks/log-query-limits.md"];
    files["memory/runbooks/log_query_limits.md"] = Buffer.from(body);
    files["memory/runbooks/INDEX.md"] = Buffer.from(files["memory/runbooks/INDEX.md"]!.toString("utf8").replace("./log-query-limits.md", "./log_query_limits.md"));
    badMemoryName = zipPackage(packageFromFiles("sample-package-v2", files), "sample-package-v2");
  });

  it("stores the zip, maps it against the index and records the import", async () => {
    const r = await importPackage(space, { upload: { kind: "zip", fileName: "sample-package-v2.zip", bytes: zip }, layout: LAYOUT }, actor);
    expect(r.status).toBe("analyzed");
    expect(r.problems).toEqual([]);
    importId = r.importId;

    const row = (await getImportRow(space.id, importId))!;
    expect(row).toMatchObject({ fileName: "sample-package-v2.zip", source: "zip", layout: LAYOUT, packageName: "sample-package-v2", status: "analyzed", importedBy: actor.email });
    expect(row.sha256).toBe(sha256Hex(zip));
    expect(row.sizeBytes).toBe(zip.length);
    const stored = readFileSync(path.join(packageImportsDir(), `${importId}.zip`));
    expect(sha256Hex(stored)).toBe(row.sha256);
    expect(row.expiresAt!.getTime() - row.createdAt.getTime()).toBeGreaterThanOrEqual((policy.packageIo.uploads.retentionDays * 86_400 - 5) * 1000);

    // The fixture space has GENERIC instructions, one skill, one store and two memories.
    expect(r.summary.ok).toBe(true);
    expect(r.summary.assets).toBe(26);
    expect(r.summary.counts).toMatchObject({ update: 1, unchanged: 0, untouched: 4, errors: 0 });
    expect(r.summary.counts.create).toBe(r.summary.assets - 1);

    const audit = await auditActions("package.import");
    expect(audit.find((e) => e.targetId === importId)).toMatchObject({ actorEmail: actor.email, result: "ok", targetType: "package_import" });
  });

  it("loads the import list and the detail grouped by asset type", async () => {
    const list = await loadImportList(space);
    expect(list.imports.map((i) => i.id)).toContain(importId);
    expect(list.imports.find((i) => i.id === importId)).toMatchObject({ status: "analyzed", layoutLabel: "AnyCompany instruction package v2", uploadAvailable: true });

    const detail = (await loadImportDetail(space, importId))!;
    expect(detail.groups.map((g) => g.assetType)).toEqual(["agents_md", "skill", "memory_store", "memory"]);
    const instructions = detail.groups[0]!;
    expect(instructions.label).toBe(policy.assetTypes.assetTypes.agents_md!.label);
    expect(instructions.counts).toEqual({ create: 4, update: 1, unchanged: 0 });
    expect(instructions.items.find((i) => i.key === "GENERIC")).toMatchObject({ action: "update", assetId: IDS.agentsMd, liveVersion: 5, changes: { content: true, committed: true } });
    // Lines added and removed against the committed AGENTS.md, and line counts per text file.
    const generic = instructions.items.find((i) => i.key === "GENERIC")!;
    expect(generic.diffStat!.added + generic.diffStat!.removed).toBeGreaterThan(0);
    expect(generic.files[0]!.lines).toBeGreaterThan(0);
    expect(detail.files.map((g) => g.role)).toEqual(["asset", "build-artifact", "manifest", "non-asset"]);
    expect(detail.untouched.flatMap((g) => g.assets.map((a) => a.assetId)).sort()).toEqual([IDS.overview, IDS.skill, IDS.store, IDS.testingMcp].sort());
    expect(detail.plan).toEqual({ planId: null, canCreate: true, reason: null, defaultTitle: "Import sample-package-v2.zip" });
    expect(detail.layout).toMatchObject({ name: LAYOUT, typeDirs: { agents_md: "instructions", skill: "skills", memory_store: "memory", memory: "memory" } });
    expect(detail.failedAssets).toBe(0);
    expect(detail.import.historyCommit).toBe(await repo.head());

    expect(await loadImportDetail(otherSpace, importId)).toBeNull();
    expect(await loadImportDetail(space, "not-a-uuid")).toBeNull();
  });

  it("creates a plan with only the create and update items", async () => {
    await expect(createPlanFromImport(otherSpace, importId, actor)).rejects.toMatchObject({ code: "not-found" });

    const r = await createPlanFromImport(space, importId, actor, { reason: "v2 audit", title: "  Import v2 for review " });
    expect(plans.calls).toHaveLength(1);
    const input = plans.calls[0]!;
    expect(input).toMatchObject({ spaceId: space.id, origin: { kind: "package", importId, fileName: "sample-package-v2.zip" }, reason: "v2 audit" });
    expect(input.title).toBe("Import v2 for review");
    expect(input.deletes).toBeUndefined();
    expect(input.items).toHaveLength(r.summary.counts.create + r.summary.counts.update);
    const generic = input.items.find((i) => i.desired.assetType === "agents_md" && i.desired.key === "GENERIC")!;
    expect(generic.desired.assetId).toBe(IDS.agentsMd);
    expect(generic.baseVersion).toBeNull();
    expect(input.items.filter((i) => i.desired.assetId).map((i) => i.desired.assetId)).toEqual([IDS.agentsMd]);
    const memory = input.items.find((i) => i.desired.assetType === "memory")!;
    expect(memory.desired.refs?.memoryStore).toBeTruthy();
    // Untouched live assets are never in the plan.
    expect(input.items.map((i) => i.desired.assetId)).not.toContain(IDS.skill);

    const row = (await getImportRow(space.id, importId))!;
    expect(row).toMatchObject({ status: "planned", planId: r.planId, plannedBy: actor.email });
    const audit = await auditActions("package.plan");
    expect(audit.find((e) => e.targetId === importId && e.result === "ok")?.details).toMatchObject({ planId: r.planId, items: input.items.length });

    await expect(createPlanFromImport(space, importId, actor)).rejects.toMatchObject({ code: "already-planned" });
    expect(plans.calls).toHaveLength(1);
    expect((await loadImportDetail(space, importId))!.plan).toMatchObject({ planId: r.planId, canCreate: false });
  });

  it("puts the import back when createPlan fails", async () => {
    const r = await importPackage(space, { upload: { kind: "zip", fileName: "again.zip", bytes: zip }, layout: LAYOUT }, actor);
    plans.fail = true;
    await expect(createPlanFromImport(space, r.importId, actor)).rejects.toThrow(/plans service unavailable/);
    expect((await getImportRow(space.id, r.importId))!).toMatchObject({ status: "analyzed", planId: null, plannedAt: null });
    const audit = await auditActions("package.plan");
    expect(audit.find((e) => e.targetId === r.importId)).toMatchObject({ result: "error" });
  });

  it("reads a folder upload the same way and stores it as a zip", async () => {
    const r = await importPackage(space, { upload: { kind: "folder", files: folder }, layout: LAYOUT }, actor);
    expect(r.status).toBe("analyzed");
    const row = (await getImportRow(space.id, r.importId))!;
    expect(row).toMatchObject({ source: "folder", fileName: "sample-package-v2", packageName: "sample-package-v2" });
    const stored = readFileSync(path.join(packageImportsDir(), `${r.importId}.zip`));
    expect(sha256Hex(stored)).toBe(row.sha256);
    expect(r.summary.counts).toMatchObject({ update: 1, untouched: 4 });
    const again = await importPackage(space, { upload: { kind: "folder", files: [...folder].reverse() }, layout: LAYOUT }, actor);
    expect((await getImportRow(space.id, again.importId))!.sha256).toBe(row.sha256);
  });

  it("deletes expired uploads and then refuses to plan", async () => {
    const r = await importPackage(space, { upload: { kind: "zip", fileName: "old.zip", bytes: zip }, layout: LAYOUT }, actor);
    await db().update(packageImports).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(packageImports.id, r.importId));
    const out = await runExpireUploads({}, testJobContext({ actor: { email: "system:schedule" } }));
    expect(out.deleted).toBeGreaterThanOrEqual(1);
    expect(existsSync(path.join(packageImportsDir(), `${r.importId}.zip`))).toBe(false);
    expect((await getImportRow(space.id, r.importId))!.fileDeletedAt).not.toBeNull();
    await expect(createPlanFromImport(space, r.importId, actor)).rejects.toMatchObject({ code: "upload-expired" });
    expect((await loadImportDetail(space, r.importId))!.plan.canCreate).toBe(false);
  });

  it("blocks the plan for a package with a memory name the service rejects", async () => {
    const r = await importPackage(space, { upload: { kind: "zip", fileName: "bad-name.zip", bytes: badMemoryName }, layout: LAYOUT }, actor);
    expect(r.summary.counts.errors).toBe(1);
    const detail = (await loadImportDetail(space, r.importId))!;
    expect(detail.plan.canCreate).toBe(false);
    await expect(createPlanFromImport(space, r.importId, actor)).rejects.toThrow(/1 validation error/);
  });

  it("detects the layout of a package with a shared section when none is named", async () => {
    const r = await importPackage(space, { upload: { kind: "zip", fileName: "detected.zip", bytes: zip } }, actor);
    const row = (await getImportRow(space.id, r.importId))!;
    // The base layout with a shared section and the sample layout map the package alike; both beat the plain layouts.
    expect(["instruction-folders-shared", LAYOUT]).toContain(row.layout);
    expect((row.results as { layouts: { layout: string }[] }).layouts.slice(0, 2).map((l) => l.layout).sort()).toEqual([LAYOUT, "instruction-folders-shared"].sort());
  });
});

describe("package import against committed state", () => {
  const small = (globalMd: string) => zipPackage(packageFromFiles("small", { "instructions/global.md": globalMd }));

  it("marks an asset unchanged when its content and metadata match the committed state", async () => {
    const r = await importPackage(space, { upload: { kind: "zip", fileName: "small.zip", bytes: small(agentsMdText) }, layout: "instruction-folders" }, actor);
    expect(r.status).toBe("analyzed");
    const detail = (await loadImportDetail(space, r.importId))!;
    expect(detail.groups[0]!.items[0]).toMatchObject({ assetKey: "agents_md:GENERIC", action: "unchanged", assetId: IDS.agentsMd, changes: null });
    expect(r.summary.counts).toMatchObject({ create: 0, update: 0, unchanged: 1, untouched: 4 });
    // The v2 layout's package checks fail on this one-file package, so the plan is refused.
    expect(r.summary.ok).toBe(false);
    await expect(createPlanFromImport(space, r.importId, actor)).rejects.toMatchObject({ code: "not-plannable" });
  });

  it("refuses a plan with nothing to change when errors don't block it", async () => {
    const policyDir = path.join(repo.dir, "policy");
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(path.join(policyDir, "package-io.yaml"), "import:\n  blockPlanOnErrors: false\n");
    try {
      const r = await importPackage(space, { upload: { kind: "zip", fileName: "small.zip", bytes: small(agentsMdText) }, layout: "instruction-folders" }, actor);
      await expect(createPlanFromImport(space, r.importId, actor)).rejects.toMatchObject({ code: "nothing-to-plan" });
      const changed = await importPackage(space, { upload: { kind: "zip", fileName: "small.zip", bytes: small(`${agentsMdText}\nOne more line.\n`) }, layout: "instruction-folders" }, actor);
      const plan = await createPlanFromImport(space, changed.importId, actor);
      expect(plan.items).toBe(1);
      expect(plans.calls[0]!.items[0]!.desired).toMatchObject({ assetType: "agents_md", assetId: IDS.agentsMd });
    } finally {
      rmSync(policyDir, { recursive: true, force: true });
    }
  });

  it("records a rejected upload without storing it", async () => {
    const safe = writeZip([{ name: "aaaa/x.md", data: Buffer.from("x") }]);
    const bad = Buffer.from(safe);
    let i = bad.indexOf("aaaa/x.md");
    while (i >= 0) {
      bad.write("../a/x.md", i, "latin1");
      i = bad.indexOf("aaaa/x.md", i + 1);
    }
    const r = await importPackage(space, { upload: { kind: "zip", fileName: "evil.zip", bytes: bad } }, actor);
    expect(r.status).toBe("rejected");
    expect(r.problems[0]!.level).toBe("error");
    const row = (await getImportRow(space.id, r.importId))!;
    expect(row).toMatchObject({ status: "rejected", storedPath: null });
    expect(existsSync(path.join(packageImportsDir(), `${r.importId}.zip`))).toBe(false);
    const audit = await auditActions("package.import");
    expect(audit.find((e) => e.targetId === r.importId)).toMatchObject({ result: "error" });
    await expect(createPlanFromImport(space, r.importId, actor)).rejects.toMatchObject({ code: "not-plannable" });
  });

  it("refuses an unknown layout", async () => {
    await expect(importPackage(space, { upload: { kind: "zip", fileName: "x.zip", bytes: small("x") }, layout: "nope" }, actor)).rejects.toBeInstanceOf(PackageIoError);
  });
});

describe("package export", () => {
  it("exports the space at HEAD in the default layout", async () => {
    const r = await exportPackage(space, {}, actor);
    expect(r.layout).toBe("instruction-folders");
    expect(r.ref.kind).toBe("head");
    expect(r.ref.commit).toBe(await repo.head());
    expect(r.fileName).toBe(`${TEST_ALIAS}-${r.ref.label}.zip`);
    expect(r.assets).toBe(5);
    const pkg = readPackageZip(r.zip, r.fileName);
    expect(pkg.files.get("instructions/global.md")!.toString("utf8")).toBe(agentsMdText);
    expect(pkg.files.has("memory/chat-tool-use-best-practices/STORE.md")).toBe(true);
    expect(pkg.files.has("skills/chat-tool-use-best-practices/SKILL.md")).toBe(true);
    // The skill's diagram is above the commit threshold, so it has no stored content.
    expect(r.results.some((x) => x.code === "live.file-not-committed")).toBe(true);
    expect(r.warnings.every((w) => w.code === "export.not-placed")).toBe(true);
    expect(r.sha256).toBe(sha256Hex(r.zip));
    const headers = exportDownloadHeaders(r);
    expect(headers["Content-Disposition"]).toBe(`attachment; filename="${r.fileName}"`);
    const audit = await auditActions("package.export");
    expect(audit.find((e) => e.targetId === r.ref.commit)?.details).toMatchObject({ ref: "HEAD", layout: "instruction-folders", sha256: r.sha256, assets: 5 });
  });

  it("exports an older commit and a release tag", async () => {
    const first = built.commits[0]!;
    const atFirst = await exportPackage(space, { ref: first.commit.slice(0, 10), layout: "instruction-folders" }, actor);
    expect(atFirst.ref).toMatchObject({ kind: "commit", commit: first.commit });
    expect(atFirst.assets).toBe(1);
    expect(readPackageZip(atFirst.zip, atFirst.fileName).files.get("instructions/global.md")!.toString()).toContain("Short first draft.");

    const release = await exportPackage(space, { ref: `${TEST_ALIAS}/v1` }, actor);
    expect(release.ref).toMatchObject({ kind: "release", label: "v1", commit: built.byAsset.get(IDS.agentsMd)![1]!.commit });
    expect(release.fileName).toBe(`${TEST_ALIAS}-v1.zip`);
    expect(readPackageZip(release.zip, release.fileName).files.get("instructions/global.md")!.toString()).toBe(agentsMdText);
  });

  it("refuses refs that are not a commit or a release of this space", async () => {
    for (const ref of ["nope", "--output=/tmp/x", "other-space/v1", "main~1", "0000000"]) {
      await expect(exportPackage(space, { ref }, actor)).rejects.toMatchObject({ code: "unknown-ref" });
    }
    await expect(exportPackage(otherSpace, {}, actor)).rejects.toMatchObject({ code: "no-history" });
    const audit = await auditActions("package.export");
    expect(audit.filter((e) => e.result === "error").length).toBeGreaterThanOrEqual(5);
  });

  it("blocks the download when the checks fail and the policy says so, and audits the refusal", async () => {
    exportPolicy.block = true;
    const err = await exportPackage(space, {}, actor).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PackageIoError);
    expect(err).toMatchObject({ code: "checks-failed" });
    const failed = err as PackageIoError;
    expect(failed.message).toMatch(/^The package doesn't pass its checks: \d+ errors?\.$/);
    expect(failed.results.length).toBeGreaterThan(0);
    expect(failed.results.every((r) => r.level === "error")).toBe(true);
    const audit = await auditActions("package.export");
    expect(audit.some((e) => e.result === "error" && (e.details as { code?: string } | null)?.code === "checks-failed")).toBe(true);
  });

  it("downloads every asset with a notes file when the checks fail and the policy doesn't block", async () => {
    const r = await exportPackage(space, {}, actor);
    expect(r.ok).toBe(false);
    const pkg = readPackageZip(r.zip, r.fileName);
    const notes = pkg.files.get("reference/EXPORT-NOTES.md")!.toString("utf8");
    expect(notes).toContain("# Export notes");
    expect(notes).toContain("## Package check errors\n\n- ");
    expect(pkg.files.has("skills/chat-tool-use-best-practices/SKILL.md")).toBe(true);
    expect(pkg.files.has("memory/chat-tool-use-best-practices/categories/testing-mcp-servers.md")).toBe(true);
    expect(r.sha256).toBe(sha256Hex(r.zip));
    const p = await previewExport(space, {});
    expect(p).toMatchObject({ ok: false, blockedReason: null, notesFile: "reference/EXPORT-NOTES.md" });
    expect(p.errors.length).toBeGreaterThan(0);
  });

  it("previews an export: counts by type, the manifest, the errors, and a custom name", async () => {
    exportPolicy.block = true;
    const before = (await auditActions("package.export")).length;
    const p = await previewExport(space, { name: "demo-package.zip" });
    expect(p.ok).toBe(false);
    expect(p.blockedReason).toBe(checksFailedMessage(p.errors.length));
    expect(p.packageName).toBe("demo-package");
    expect(p.fileName).toBe("demo-package.zip");
    expect(p.layoutLabel).toBe("Instruction folders (instructions, skills, memory)");
    expect(p.manifest).toBe("reference/ASSET-METADATA.json");
    expect(p.included.reduce((n, t) => n + t.count, 0) + p.leftOut.reduce((n, t) => n + t.count, 0)).toBe(5);
    expect(p.included.map((t) => t.assetType)[0]).toBe("agents_md");
    // A preview is a read: nothing is audited.
    expect((await auditActions("package.export")).length).toBe(before);
    exportPolicy.block = false;
    expect((await previewExport(space, {})).blockedReason).toBeNull();
    await expect(previewExport(space, { ref: "nope" })).rejects.toMatchObject({ code: "unknown-ref" });
    const named = await exportPackage(space, { name: "demo-package" }, actor);
    expect(named.fileName).toBe("demo-package.zip");
  });

  it("lists layouts and export points", async () => {
    const o = await loadExportOptions(space);
    expect(o.repo).toEqual({ ok: true });
    expect(o.defaultLayout).toBe("instruction-folders");
    expect(o.layouts.map((l) => l.name)).toEqual(expect.arrayContaining(["instruction-folders", "instruction-folders-shared"]));
    expect(o.refs!.head!.commit).toBe(await repo.head());
    expect(o.refs!.releases).toEqual([expect.objectContaining({ kind: "release", ref: `${TEST_ALIAS}/v1`, label: "v1" })]);
    expect(o.refs!.commits.length).toBe(Math.min(built.commits.length, policy.packageIo.export.recentCommits));
    expect((await loadExportOptions(otherSpace)).repo).toMatchObject({ ok: false, reason: "no-repo" });
  });

  it("reads binary files from git as bytes", async () => {
    const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const dir = `spaces/${TEST_ALIAS}/skill/binary-skill`;
    const skillMd = "---\nname: binary-skill\ndescription: Use when testing binary files.\n---\n# Binary\n";
    const assetJson = {
      assetId: "ki-00000000-0000-4000-8000-0000000000bb",
      assetType: "skill",
      metadata: { name: "binary-skill", description: "Use when testing binary files.", agent_types: ["GENERIC"], skill_type: "USER", status: "ACTIVE" },
      serviceVersion: 1,
      serviceCreatedAt: "2026-11-11T00:00:00.000Z",
      serviceUpdatedAt: "2026-11-11T00:00:00.000Z",
      files: [
        { path: "SKILL.md", sha256: sha256Hex(skillMd), size: Buffer.byteLength(skillMd), committed: true },
        { path: "assets/bytes.bin", sha256: sha256Hex(binary), size: binary.length, committed: true },
      ],
    };
    const commit = await repo.writeAndCommit(
      [
        { path: `${dir}/asset.json`, content: `${JSON.stringify(assetJson, null, 2)}\n` },
        { path: `${dir}/SKILL.md`, content: skillMd },
        { path: `${dir}/assets/bytes.bin`, content: binary },
      ],
      { message: "Add binary skill", author: { name: "t", email: "t@example.com" }, committer: { name: "t", email: "t@example.com" }, date: new Date("2026-11-11T00:00:00Z") },
    );
    const snapshots = await readSnapshotsAtCommit(repo, policy.historyLayout, TEST_ALIAS, commit!);
    const file = snapshots.find((s) => s.assetId === assetJson.assetId)!.files.find((f) => f.path === "assets/bytes.bin")!;
    expect(file.encoding).toBe("base64");
    expect(Buffer.from(file.content!, "base64").equals(binary)).toBe(true);
    const r = await exportPackage(space, {}, actor);
    const zipped = readPackageZip(r.zip, r.fileName);
    const skillZip = readZip(zipped.files.get("skills/binary-skill.zip")!, policy.limits.packageRead);
    expect(skillZip.entries.find((e) => e.name.endsWith("assets/bytes.bin"))!.data.equals(binary)).toBe(true);
  });
});
