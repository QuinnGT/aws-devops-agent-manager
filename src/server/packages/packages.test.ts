import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AssetSnapshot } from "@/lib/assets/types";
import { getAppPolicy, loadPolicyFromDirs, PolicyError } from "@/server/policy";
import { resolvedSchema } from "@/server/validation/schemas";
import { buildRelease } from "./build";
import { checkPackage } from "./check";
import { packageToDesiredAssets, packageToPackageFiles } from "./desired";
import { exportPackageZip } from "./export";
import { pythonFrontmatter } from "./frontmatter";
import { getLayout } from "./layout";
import { snapshotsToDesiredAssets } from "./live";
import { packageFromFiles, readPackageZip } from "./read";
import { pythonJsonDumps } from "./text";
import { SHARED_BEGIN as BEGIN, SHARED_END as END, STRICT_SAFETY as SAFETY, testPolicy } from "./test-support/policy";
import { readZip } from "./zip";

const policy = getAppPolicy().policy;
// The app's policy plus the test layouts: strict-shared carries every kind of check.
const strict = testPolicy();
const STRICT = "strict-shared";
const APP_POLICY = path.resolve(__dirname, "../../../policy");

function demoPackage(overrides: Record<string, string> = {}) {
  return packageFromFiles("demo", {
    "README.md": "# Demo\n",
    "instructions/global.md": `# Global\n\n${SAFETY}`,
    "instructions/incident-triage.md": `# Triage\n\n${BEGIN}\nold\n${END}\n`,
    "instructions/incident-rca.md": `# RCA\n\n${BEGIN}\n${END}\nTail.\n`,
    "instructions/shared/common.md": "## Common rules\n\n- Delegate.\n\n",
    "instructions/learning.md": "# Learning\n",
    "instructions/grader.md": "# Grader\n",
    "skills/demo-skill/SKILL.md": "---\nname: demo-skill\ndescription: Use when testing.\n---\n# Demo\n",
    "memory/demo-store/STORE.md": "---\nstore: demo-store\ndescription: Demo notes. Read when testing.\nagent_types: Generic (all agents)\n---\n\nDemo store.\n",
    "memory/demo-store/notes/first.md": "---\nname: notes/first\ndescription: First note.\n---\n\n# First\n",
    ...overrides,
  });
}

describe("package layouts policy", () => {
  it("defaults to the plain instruction folders, with no shared section and no text rules", () => {
    const base = getLayout(policy);
    expect(base.name).toBe("instruction-folders");
    expect(policy.packageLayouts.defaultLayout).toBe("instruction-folders");
    expect(base.sharedSections).toEqual([]);
    expect(base.checks).toMatchObject({ textPatterns: [], requiredText: [], forbiddenText: [], requiredFiles: [] });
    expect(base.skills?.agentTypes.bySkill).toEqual({});
    expect(getLayout(policy, "agent-space-folders").checks).toMatchObject({ textPatterns: [], requiredText: [], forbiddenText: [], requiredFiles: [] });
  });

  it("resolves extends: a layout inherits its parent and adds its own rules", () => {
    const shared = getLayout(policy, "instruction-folders-shared");
    const base = getLayout(policy, "instruction-folders");
    expect(shared.name).toBe("instruction-folders-shared");
    expect(shared.ignore).toContain("**/.DS_Store");
    expect(shared.instructions?.files).toMatchObject({ "global.md": "GENERIC" });
    expect(shared.checks.requireArchives).toBe(true);
    expect(shared.sharedSections.map((s) => s.name)).toEqual(["common"]);
    expect(shared.nonAssets).toContain("instructions/shared/**");
    const strictShared = getLayout(strict, STRICT);
    expect(strictShared.sharedSections.map((s) => s.name)).toEqual(["common"]);
    expect(strictShared.instructions?.files).toMatchObject({ "global.md": "GENERIC", "learning.md": null });
    expect(strictShared.checks.forbiddenText).toHaveLength(1);
    expect(base.sharedSections).toEqual([]);
    expect(base.checks.forbiddenText).toEqual([]);
  });

  it("rejects extends cycles and invalid metadata schemas", () => {
    const over = mkdtempSync(path.join(tmpdir(), "dam-policy-"));
    writeFileSync(path.join(over, "package-layouts.yaml"), "layouts:\n  a: { extends: b, label: A }\n  b: { extends: a, label: B }\n");
    expect(() => loadPolicyFromDirs([APP_POLICY, over])).toThrow(PolicyError);
    const bad = mkdtempSync(path.join(tmpdir(), "dam-policy-"));
    writeFileSync(path.join(bad, "asset-types.yaml"), "assetTypes:\n  skill:\n    metadataSchema: { type: nope }\n");
    expect(() => loadPolicyFromDirs([APP_POLICY, bad])).toThrow(PolicyError);
  });

  it("fills agent types and description limits into the schemas", () => {
    const schema = resolvedSchema(policy, "skill")!;
    const defs = schema.$defs as Record<string, { enum?: string[]; maxLength?: number }>;
    expect(defs.agentType?.enum).toContain("INCIDENT_RCA");
    expect(defs.description?.maxLength).toBe(1024);
  });
});

describe("buildRelease", () => {
  it("copies shared sections, writes indexes and skill zips, and validates", () => {
    const layout = getLayout(strict, STRICT);
    const r = buildRelease(demoPackage(), layout, { zipLimits: policy.limits.packageRead });
    expect(r.results.filter((x) => x.level === "error")).toEqual([]);
    expect(r.ok).toBe(true);
    const text = (p: string) => r.contents.files.get(p)!.toString("utf8");
    expect(text("instructions/incident-triage.md")).toBe(`# Triage\n\n${BEGIN}\n## Common rules\n\n- Delegate.\n${END}\n`);
    expect(text("instructions/incident-rca.md")).toBe(`# RCA\n\n${BEGIN}\n## Common rules\n\n- Delegate.\n${END}\nTail.\n`);
    expect(text("memory/demo-store/INDEX.md")).toBe(
      "# demo-store\n\nLinks are relative to this index. This is the validated local index preview.\n\n- [first](./notes/first.md): First note.\n",
    );
    const zip = readZip(r.contents.files.get("skills/demo-skill.zip")!, policy.limits.packageRead);
    expect(zip.entries.map((e) => e.name)).toEqual(["demo-skill/SKILL.md"]);
    expect(JSON.parse(text("reference/VALIDATION.json"))).toMatchObject({ status: "passed", instruction_files: 5, skills: 1, stores: 1, memories: 1 });
    expect(r.changes.map((c) => c.path)).toEqual([
      "instructions/incident-rca.md",
      "instructions/incident-triage.md",
      "memory/demo-store/INDEX.md",
      "reference/VALIDATION.json",
      "skills/demo-skill.zip",
    ]);
    expect(r.packageZip?.fileName).toBe("demo.zip");
    expect(readZip(r.packageZip!.data, policy.limits.packageRead).entries[0]!.name).toBe("demo/README.md");
  });

  it("reports missing markers, leaves that file alone and finishes the other steps", () => {
    const input = demoPackage({ "instructions/incident-rca.md": "# RCA\n" });
    const r = buildRelease(input, getLayout(strict, STRICT), { zipLimits: policy.limits.packageRead });
    expect(r.ok).toBe(false);
    expect(r.contents.files.get("instructions/incident-rca.md")!.toString()).toBe("# RCA\n");
    expect(r.contents.files.get("instructions/incident-triage.md")!.toString()).toContain("- Delegate.");
    expect(r.contents.files.has("skills/demo-skill.zip")).toBe(true);
    // Reported once, by the package checks.
    expect(r.results.map((x) => x.code)).toEqual(["package.shared-markers"]);
  });

  it("checkPackage maps the built package to valid assets", () => {
    const c = checkPackage(demoPackage(), { policy: strict, layout: STRICT });
    expect(c.results.filter((x) => x.level === "error")).toEqual([]);
    expect(c.ok).toBe(true);
    expect(c.mapped.assets.map((a) => `${a.assetType}:${a.key}`)).toEqual([
      "agents_md:GENERIC",
      "agents_md:INCIDENT_RCA",
      "agents_md:INCIDENT_TRIAGE",
      "skill:demo-skill",
      "memory_store:demo-store",
      "memory:demo-store/notes/first",
    ]);
    const store = c.mapped.assets.find((a) => a.assetType === "memory_store")!;
    expect(store.metadata).toEqual({ name: "demo-store", description: "Demo notes. Read when testing.", agent_types: ["GENERIC"] });
    expect(store.files).toEqual([{ path: "README.md", encoding: "utf8", content: "Demo store.\n", sourcePath: "memory/demo-store/STORE.md" }]);
    const files = packageToPackageFiles(c.build.contents);
    expect(files.find((f) => f.assetType === "memory")).toEqual({
      assetType: "memory",
      name: "demo-store/notes/first",
      path: "memory/demo-store/notes/first.md",
      body: "---\nname: notes/first\ndescription: First note.\n---\n\n# First\n",
    });
    expect(c.mapped.results.map((r) => r.code)).toEqual(["package.no-agent-type", "package.no-agent-type"]);
  });

  it("warns about files that no layout rule maps", () => {
    const m = packageToDesiredAssets(demoPackage({ "notes.txt": "x" }), STRICT, { policy: strict });
    expect(m.results.filter((r) => r.code === "package.unmapped-file").map((r) => r.path)).toEqual(["notes.txt"]);
  });
});

describe("export from live snapshots", () => {
  const t = "2026-11-01T00:00:00.000Z";
  const snap = (assetId: string, assetType: string, metadata: Record<string, unknown>, files: AssetSnapshot["files"]): AssetSnapshot => ({
    assetId,
    assetType,
    version: 1,
    createdAt: t,
    updatedAt: t,
    metadata,
    files,
  });
  const f = (p: string, content?: string) => ({ path: p, sha256: "0", size: content?.length ?? 9_000_000, encoding: "utf8" as const, content });
  const snapshots = [
    snap("ki-store", "memory_store", { name: "runbooks", description: "Runbooks. Read when testing.", agent_types: ["GENERIC"], status: "ACTIVE" }, [f("runbooks.md", "# runbooks")]),
    snap("ki-mem", "memory", { name: "db/failover", description: "Failover steps.", memory_store_id: "ki-store", status: "INACTIVE" }, [
      f("failover.md", "---\nname: db/failover\ndescription: Failover steps.\n---\n\nSteps.\n"),
    ]),
    snap("ki-skill", "skill", { name: "rds-check", description: "Use for RDS checks.", agent_types: ["GENERIC"], skill_type: "USER", status: "ACTIVE" }, [
      f("SKILL.md", "# RDS\n"),
      f("references/big.md"),
    ]),
    snap("ki-a", "agents_md", { agent_type: "GENERIC", status: "ACTIVE" }, [f("AGENTS.md", "# Global\n")]),
  ];

  it("places assets by name, records extra metadata in the manifest, and round-trips", () => {
    const { assets, results } = snapshotsToDesiredAssets(snapshots, policy);
    expect(results.map((r) => r.code)).toEqual(["live.file-not-committed"]);
    expect(assets.find((a) => a.assetType === "memory")).toMatchObject({ key: "runbooks/db/failover", refs: { memoryStore: "runbooks" } });

    const exp = exportPackageZip(assets, STRICT, { policy: strict, packageName: "space-export" });
    expect(exp.fileName).toBe("space-export.zip");
    expect(exp.ok).toBe(false); // the strict layout needs the safety messages and the shared section's source
    const errors = exp.results.filter((r) => r.level === "error");
    expect(errors.map((r) => r.code)).toEqual(expect.arrayContaining(["package.shared-source-missing", "package.safety-message"]));
    // The missing source is reported once, and optional agent files are warnings.
    expect(errors.filter((r) => r.path === "instructions/shared/common.md")).toEqual([
      expect.objectContaining({ message: "instructions/shared/common.md is missing, so the common section can't be copied." }),
    ]);
    expect(exp.results.filter((r) => r.code === "package.optional-agent-file").map((r) => [r.level, r.message])).toEqual([
      ["warning", "Missing optional agent file: learning.md."],
      ["warning", "Missing optional agent file: grader.md."],
    ]);
    expect([...exp.contents.files.keys()]).toEqual([
      "instructions/global.md",
      "memory/runbooks/INDEX.md",
      "memory/runbooks/STORE.md",
      "memory/runbooks/db/failover.md",
      "reference/ASSET-METADATA.json",
      "reference/VALIDATION.json",
      "skills/rds-check/SKILL.md",
      "skills/rds-check.zip",
    ]);
    expect(exp.contents.files.get("skills/rds-check/SKILL.md")!.toString()).toBe("---\nname: rds-check\ndescription: Use for RDS checks.\n---\n# RDS\n");
    expect(JSON.parse(exp.contents.files.get("reference/ASSET-METADATA.json")!.toString())).toEqual({
      layout: STRICT,
      assets: [
        { assetType: "memory", key: "runbooks/db/failover", metadata: { status: "INACTIVE" } },
        { assetType: "skill", key: "rds-check", metadata: { agent_types: ["GENERIC"] } },
      ],
    });
    expect(exportPackageZip(assets, STRICT, { policy: strict, packageName: "space-export" }).zip.equals(exp.zip)).toBe(true);

    const back = packageToDesiredAssets(readPackageZip(exp.zip, exp.fileName, { policy: strict, layout: STRICT }), STRICT, { policy: strict });
    const meta = (type: string) => back.assets.find((a) => a.assetType === type)!.metadata;
    expect(meta("skill")).toEqual({ name: "rds-check", description: "Use for RDS checks.", agent_types: ["GENERIC"] });
    expect(meta("memory")).toEqual({ name: "db/failover", description: "Failover steps.", status: "INACTIVE" });
    expect(meta("memory_store")).toEqual({ name: "runbooks", description: "Runbooks. Read when testing.", agent_types: ["GENERIC"] });
  });
});

describe("Python compatibility helpers", () => {
  it("dumps JSON like json.dumps(indent=2) and reads frontmatter like validate_package.py", () => {
    expect(pythonJsonDumps({ a: [1, "é"], b: {} })).toBe('{\n  "a": [\n    1,\n    "\\u00e9"\n  ],\n  "b": {}\n}');
    expect(pythonFrontmatter('---\nname: "x"\n  nested: y\ndescription: a: b\n---\nbody')).toEqual({ name: "x", description: "a: b" });
    expect(pythonFrontmatter("no frontmatter")).toBeNull();
  });
});
