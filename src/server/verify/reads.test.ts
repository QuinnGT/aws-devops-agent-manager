import { describe, expect, it } from "vitest";
import { deployedVsRead } from "@/server/analyzers/deployed-vs-read";
import { normalizeBundle } from "@/server/analyzers/normalize";
import { packageFromFiles, packageToDesiredAssets } from "@/server/packages";
import { getAppPolicy, type Policy } from "@/server/policy";
import { analyzerPackageFiles, desiredAssetsWithFiles, fileKey, memoryPathInStore, type AssetWithFiles } from "./package-files";
import { aggregateReads, classifyRead, identifyVersions, type InvestigationReads, type VersionCandidate } from "./reads";
import { memoryText, syntheticBundle, type SyntheticRead } from "./test-support";

const base = getAppPolicy().policy;
const policy: Policy = { ...base, verify: { ...base.verify, reads: { ...base.verify.reads, examplesPerFile: 2 } } };
const SPACE = "00000000-0000-4000-8000-000000000001";

const failover = {
  v1: memoryText("db/failover", [
    "Fail over the primary database by promoting the replica in the console.",
    "Retention of the failover log is about 30 days in every region.",
    "Page the database on-call before promoting any replica by hand.",
  ]),
  v2: memoryText("db/failover", [
    "Fail over the primary database by promoting the replica in the console.",
    "Retention of the failover log is deployment-dependent; check the stack.",
    "Page the database on-call before promoting any replica by hand.",
  ]),
  v3: memoryText("db/failover", [
    "Fail over the primary database with the runbook automation, not by hand.",
    "Retention of the failover log is deployment-dependent; check the stack.",
    "Page the database on-call before promoting any replica by hand.",
  ]),
};
const backup = memoryText("db/backup", ["Backups run nightly at 02:00 UTC and keep fourteen copies.", "Restore drills happen every quarter on the replica cluster."]);
const notes = memoryText("notes", ["General notes that no investigation in these tests ever reads.", "A second line so the body has enough lines to compare."]);
const triage = "---\nname: triage\ndescription: Triage skill\n---\n# Triage skill used by the verification tests\nStart from the alarm and the deployment timeline, then narrow down.\nAlways name the evidence record for each claim in the summary.\n";

function mem(assetId: string, name: string, body: string, version: number, over: Partial<AssetWithFiles> = {}): AssetWithFiles {
  const file = `${name.split("/").pop()}.md`;
  return { assetId, assetType: "memory", name, metadata: { name, status: "ACTIVE", memory_store_id: "ki-store" }, storeName: "runbooks", version, files: [{ path: file, content: body }], missingFiles: 0, ...over };
}

const assets: AssetWithFiles[] = [
  { assetId: "ki-store", assetType: "memory_store", name: "runbooks", metadata: { name: "runbooks" }, storeName: null, version: 1, files: [{ path: "README.md", content: "Runbooks" }], missingFiles: 0 },
  mem("ki-failover", "db/failover", failover.v3, 3),
  mem("ki-backup", "db/backup", backup, 1),
  mem("ki-notes", "notes", notes, 1),
  mem("ki-old", "old-notes", notes, 1, { metadata: { name: "old-notes", status: "INACTIVE" } }),
  mem("ki-reflection", "learned", notes, 1, { storeName: "reflections", managed: true }),
  mem("ki-big", "big", "", 1, { files: [], missingFiles: 1 }),
  {
    assetId: "ki-triage",
    assetType: "skill",
    name: "triage",
    metadata: { name: "triage", status: "ACTIVE" },
    storeName: null,
    version: 2,
    files: [
      { path: "SKILL.md", content: triage },
      { path: "references/x.md", content: "# Reference\nNot compared by the analyzer." },
    ],
    missingFiles: 0,
  },
  { assetId: "ki-generic", assetType: "agents_md", name: "GENERIC", metadata: { agent_type: "GENERIC" }, storeName: null, version: 4, files: [{ path: "AGENTS.md", content: "# Rules" }], missingFiles: 0 },
];

const pkg = analyzerPackageFiles(assets, policy);
const FAILOVER = "/aidevops/memory/runbooks/db/failover.md";
const BACKUP = "/aidevops/memory/runbooks/db/backup.md";
const TRIAGE = "/aidevops/skills/user/triage/SKILL.md";

const candidates: VersionCandidate[] = [
  { version: 2, relation: "older", commit: "c2", body: failover.v2 },
  { version: 1, relation: "older", commit: "c1", body: failover.v1 },
];

function investigate(taskId: string, reads: SyntheticRead[], minutes: number): InvestigationReads {
  const bundle = syntheticBundle({ spaceId: SPACE, taskId, incidentId: `INC-${taskId}`, createdAt: new Date(Date.UTC(2026, 10, 12, 0, minutes)), reads });
  const norm = normalizeBundle(bundle);
  const output = deployedVsRead(norm, pkg.files);
  const failoverFile = pkg.files.find((f) => f.name === "runbooks" && f.path === "db/failover.md")!;
  const needs = output.files.some((f) => f.path === "db/failover.md" && (f.verdict === "near" || f.verdict === "different"));
  return {
    taskId,
    incidentId: `INC-${taskId}`,
    output,
    recordIdOf: (n) => norm.records[n - 1]?.recordId ?? null,
    versions: identifyVersions(norm, needs ? [{ file: failoverFile, releaseVersion: 3, candidates }] : []),
  };
}

describe("package files of a release", () => {
  it("maps memories to their store and path, and skills to SKILL.md, as the agent reads them", () => {
    expect(memoryPathInStore("db/failover", "failover.md")).toBe("db/failover.md");
    expect(memoryPathInStore("overview", "overview.md")).toBe("overview.md");
    expect(pkg.files.map((f) => `${f.assetType}:${f.name}:${f.path}`)).toEqual(["memory:runbooks:db/failover.md", "memory:runbooks:db/backup.md", "memory:runbooks:notes.md", "skill:triage:SKILL.md"]);
    expect([...pkg.origins.values()].map((o) => o.deployedPath)).toEqual([FAILOVER, BACKUP, "/aidevops/memory/runbooks/notes.md", TRIAGE]);
    expect(pkg.origins.get(fileKey({ assetType: "memory", name: "runbooks", path: "db/failover.md" }))).toMatchObject({ assetId: "ki-failover", assetName: "db/failover", store: "runbooks", version: 3, filePath: "failover.md" });
    expect(pkg.skipped).toEqual([
      { assetId: "ki-store", assetType: "memory_store", name: "runbooks", reason: "not-compared" },
      { assetId: "ki-old", assetType: "memory", name: "old-notes", reason: "inactive" },
      { assetId: "ki-reflection", assetType: "memory", name: "learned", reason: "managed" },
      { assetId: "ki-big", assetType: "memory", name: "big", reason: "not-in-git" },
      { assetId: "ki-generic", assetType: "agents_md", name: "GENERIC", reason: "not-compared" },
    ]);
  });

  it("includes inactive and managed assets when policy says so", () => {
    const all: Policy = { ...policy, verify: { ...policy.verify, reads: { ...policy.verify.reads, inactive: "include", managed: "include" } } };
    const r = analyzerPackageFiles(assets, all);
    expect(r.files.map((f) => `${f.name}:${f.path}`)).toContain("reflections:learned.md");
    expect(r.files.map((f) => `${f.name}:${f.path}`)).toContain("runbooks:old-notes.md");
  });

  it("maps a package's desired assets the same way", () => {
    const contents = packageFromFiles("demo", {
      "memory/runbooks/STORE.md": "---\nstore: runbooks\ndescription: Runbooks. Read when paged.\nagent_types: Generic (all agents)\n---\nRunbooks.\n",
      "memory/runbooks/db/failover.md": failover.v3,
      "skills/triage/SKILL.md": triage,
    });
    const mapped = packageToDesiredAssets(contents, "instruction-folders", { policy });
    const r = analyzerPackageFiles(desiredAssetsWithFiles(mapped.assets, policy), policy);
    expect(r.files.map((f) => `${f.assetType}:${f.name}:${f.path}`)).toEqual(["skill:triage:SKILL.md", "memory:runbooks:db/failover.md"]);
  });
});

describe("check 2: what the agent read", () => {
  // Newest first, as the job orders them.
  const investigations = [
    // October 12 shape: the release (v3) was sent, the agent requested the file and got the v1 body
    investigate("a", [{ path: FAILOVER, body: failover.v1 }, { path: BACKUP, body: null }, { path: TRIAGE, body: triage }], 40),
    investigate("b", [{ path: FAILOVER, body: failover.v1 }], 30),
    investigate("c", [{ path: FAILOVER, body: failover.v3 }], 20),
    investigate(
      "d",
      [
        {
          path: FAILOVER,
          body: memoryText("db/failover", ["Fail over the primary database with the runbook automation, not by hand.", "A line no version of this memory ever had in it."]),
        },
      ],
      10,
    ),
  ];

  it("classifies one investigation's read", () => {
    const out = investigations[0]!.output.files;
    const f = out.find((x) => x.path === "db/failover.md")!;
    expect(f).toMatchObject({ read: true, verdict: "different" });
    expect(classifyRead(f, investigations[0]!.versions?.get(fileKey(f)))).toBe("older-body");
    expect(classifyRead(f, null)).toBe("other-body");
    expect(classifyRead(out.find((x) => x.path === "db/backup.md"), null)).toBe("requested-no-body");
    expect(classifyRead(out.find((x) => x.path === "SKILL.md"), null)).toBe("release-body");
    expect(classifyRead(out.find((x) => x.path === "notes.md"), null)).toBe("not-requested");
    expect(classifyRead(undefined, null)).toBe("not-requested");
  });

  it("names the older version the agent read, and puts that file first", () => {
    const r = aggregateReads({ files: pkg.files, origins: pkg.origins, investigations, policy });
    expect(r.verdict).toBe("failed");
    expect(r.files.map((f) => [f.deployedPath, f.verdict])).toEqual([
      [FAILOVER, "older-body"],
      [TRIAGE, "release-body"],
      [BACKUP, "requested-no-body"],
      ["/aidevops/memory/runbooks/notes.md", "not-requested"],
    ]);
    const fo = r.files[0]!;
    expect(fo).toMatchObject({ assetId: "ki-failover", releaseVersion: 3, investigations: 4, requested: 4, store: "runbooks", assetName: "db/failover", filePath: "failover.md" });
    expect(fo.counts).toMatchObject({ "older-body": 2, "release-body": 1, "other-body": 1, "not-requested": 0 });
    expect(fo.matchedVersions).toEqual([{ version: 1, relation: "older", commit: "c1" }]);
    expect(fo.releaseOnly).toContain("Fail over the primary database with the runbook automation, not by hand.");
    expect(fo.deployedOnly).toContain("Fail over the primary database by promoting the replica in the console.");
    expect(fo.worstShares!.pkg).toBeLessThan(0.9);
    // Example links point at the record that returned the body; at most examplesPerFile per outcome
    expect(fo.examples["older-body"]).toEqual([
      { taskId: "a", incidentId: "INC-a", n: 3, recordId: "a-rec-3", version: 1 },
      { taskId: "b", incidentId: "INC-b", n: 3, recordId: "b-rec-3", version: 1 },
    ]);
    expect(fo.examples["release-body"]).toEqual([{ taskId: "c", incidentId: "INC-c", n: 3, recordId: "c-rec-3" }]);
    expect(fo.examples["other-body"]).toHaveLength(1);
    expect(fo.examples["not-requested"]).toBeUndefined();
    // A request without a body links to the request
    expect(r.files[2]!.examples["requested-no-body"]).toEqual([{ taskId: "a", incidentId: "INC-a", n: 4, recordId: "a-rec-4" }]);
    expect(r.counts).toMatchObject({ "older-body": 1, "release-body": 1, "requested-no-body": 1, "not-requested": 1 });
    expect(r.stores).toEqual([{ store: "runbooks", referencedIn: 4 }]);
  });

  it("turns a near match into an older body when an earlier version matches exactly", () => {
    // v2 differs from the release (v3) in one of five compared lines: the analyzer alone says "different" or "near";
    // the v2 candidate matches it exactly.
    const r = aggregateReads({ files: pkg.files, origins: pkg.origins, investigations: [investigate("e", [{ path: FAILOVER, body: failover.v2 }], 50)], policy });
    expect(r.files[0]).toMatchObject({ deployedPath: FAILOVER, verdict: "older-body", matchedVersions: [{ version: 2, relation: "older", commit: "c2" }] });
  });

  it("passes when every body read is the release's, and is inconclusive when none came back", () => {
    const ok = aggregateReads({ files: pkg.files, origins: pkg.origins, investigations: [investigate("f", [{ path: FAILOVER, body: failover.v3 }], 5)], policy });
    expect(ok.verdict).toBe("passed");
    const none = aggregateReads({ files: pkg.files, origins: pkg.origins, investigations: [investigate("g", [{ path: BACKUP, body: null }], 5)], policy });
    expect(none.verdict).toBe("inconclusive");
    expect(none.stores).toEqual([{ store: "runbooks", referencedIn: 1 }]);
  });

  it("names a newer version when the body matches a version after the release", () => {
    const later: VersionCandidate[] = [{ version: 4, relation: "newer", commit: "c4", body: failover.v1 }];
    const bundle = syntheticBundle({ spaceId: SPACE, taskId: "h", createdAt: new Date("2026-11-12T00:00:00Z"), reads: [{ path: FAILOVER, body: failover.v1 }] });
    const norm = normalizeBundle(bundle);
    const file = pkg.files[0]!;
    const versions = identifyVersions(norm, [{ file, releaseVersion: 3, candidates: later }]);
    const r = aggregateReads({ files: pkg.files, origins: pkg.origins, investigations: [{ taskId: "h", incidentId: null, output: deployedVsRead(norm, pkg.files), versions }], policy });
    expect(r.files[0]).toMatchObject({ verdict: "newer-body", matchedVersions: [{ version: 4, relation: "newer" }] });
    expect(r.verdict).toBe("failed");
  });
});
