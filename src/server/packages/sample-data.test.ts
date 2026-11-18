import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validatePackage } from "@/server/validation/package";
import { validateAssetSet } from "@/server/validation/set";
import { buildRelease } from "./build";
import { checkPackage } from "./check";
import { packageToDesiredAssets } from "./desired";
import { exportPackageZip } from "./export";
import { getLayout } from "./layout";
import { packageFromFiles, readPackageFolder, readPackageZip } from "./read";
import { targetPackageAssets } from "./target";
import { assetKeyOf, type DesiredAsset, type LiveAssetRef, type PackageContents } from "./types";
import { SAMPLE_DATA_DIR, sampleAgentSpaceExportDir, samplePackageDir, samplePolicy } from "../../../test/helpers/fixtures";

/**
 * The sample packages (sample-data/packages): both versions and the Agent
 * Space export read, map to assets, pass their checks, compare as the story
 * says, and fail the checks when a rule is broken. What the checks should
 * report is in sample-data/expected/packages.json.
 */

const policy = samplePolicy();
const expected = JSON.parse(readFileSync(path.join(SAMPLE_DATA_DIR, "expected/packages.json"), "utf8"));
const LAYOUT = { v1: "anycompany-v1", v2: "anycompany-v2", export: "anycompany-folders" } as const;

const read = (dir: string, layout: string) => readPackageFolder(dir, { policy, layout });
const map = (contents: PackageContents, layout: string) => packageToDesiredAssets(contents, layout, { policy });
const countByType = (assets: readonly DesiredAsset[]) => Object.fromEntries([...new Set(assets.map((a) => a.assetType))].map((t) => [t, assets.filter((a) => a.assetType === t).length]));
const text = (contents: PackageContents, p: string) => contents.files.get(p)!.toString("utf8");

/** The package with some files replaced, added (a string) or removed (null). */
function change(contents: PackageContents, patch: Record<string, string | null>): PackageContents {
  const files: Record<string, string | Buffer> = Object.fromEntries(contents.files);
  for (const [p, v] of Object.entries(patch)) {
    if (v === null) delete files[p];
    else files[p] = v;
  }
  return packageFromFiles(contents.name, files);
}

/** What a revision of one asset holds: its metadata, references and every file. */
const signature = (a: DesiredAsset) => JSON.stringify([a.metadata, a.refs ?? null, a.files.map((f) => [f.path, f.content])]);

function compare(from: readonly DesiredAsset[], to: readonly DesiredAsset[]) {
  const before = new Map(from.map((a) => [assetKeyOf(a), a]));
  const after = new Map(to.map((a) => [assetKeyOf(a), a]));
  const keys = (pick: (k: string) => boolean, m: Map<string, DesiredAsset>) => [...m.keys()].filter(pick).sort();
  return {
    added: keys((k) => !before.has(k), after),
    removed: keys((k) => !after.has(k), before),
    changed: keys((k) => before.has(k) && signature(before.get(k)!) !== signature(after.get(k)!), after),
    unchanged: keys((k) => before.has(k) && signature(before.get(k)!) === signature(after.get(k)!), after),
  };
}

describe("the sample policy overlay", () => {
  it("adds the AnyCompany layouts over the app's layouts", () => {
    const layouts = policy.packageLayouts.layouts;
    expect(Object.keys(layouts)).toEqual(expect.arrayContaining(["anycompany-v1", "anycompany-v2", "anycompany-folders"]));
    expect(layouts["anycompany-v2"]!.sharedSections.map((s) => s.name)).toEqual(["handoff"]);
    expect(layouts["anycompany-v1"]!.sharedSections).toEqual([]);
    expect(layouts["anycompany-v2"]!.checks.textPatterns.map((p) => p.pattern)).toEqual([expect.stringContaining("anyco_logs|anyco_metrics|anyco_changes|anyco_cmdb|anyco_traces")]);
    expect(layouts["anycompany-folders"]!.checks.requiredText[0]!.asset).toEqual({ assetType: "agents_md", metadata: { agent_type: "GENERIC" } });
    // The overlay keeps what it does not name: folders, manifest and build steps come from the base layouts.
    expect(layouts["anycompany-v2"]!.manifest).toBe("reference/ASSET-METADATA.json");
    expect(layouts["anycompany-folders"]!.assetFolders?.descriptor).toBe("_asset.json");
  });
});

describe.each(["v1", "v2"] as const)("sample package %s", (version) => {
  const layout = LAYOUT[version];
  const dir = samplePackageDir(version);
  const exp = expected.packages[version];

  it("reads from its folder with every file mapped, and holds no binary zips", async () => {
    const contents = await read(dir, layout);
    const m = map(contents, layout);
    expect(m.results).toEqual([]);
    expect([...m.roles].filter(([, r]) => r.role === "unmapped" || r.role === "skipped")).toEqual([]);
    expect(countByType(m.assets)).toEqual(exp.assetsByType);
    expect(m.assets).toHaveLength(exp.total);
    expect([...contents.files.keys()].filter((p) => p.endsWith(".zip"))).toEqual([]);
  });

  it("passes the build and the package checks, which only add the skill zips", async () => {
    const contents = await read(dir, layout);
    const check = checkPackage(contents, { policy, layout });
    expect(check.results).toEqual([]);
    expect(check.ok).toBe(true);
    // Indexes, shared sections and reference/VALIDATION.json are committed and current: the build creates only the zips.
    expect(check.build.changes.map((c) => `${c.change} ${c.path}`)).toEqual(exp.zipsBuilt.map((n: string) => `created skills/${n}.zip`));
    expect(check.build.validation.summary).toMatchObject(exp.validation);
    expect(JSON.parse(text(contents, "reference/VALIDATION.json"))).toEqual(check.build.validation.summary);
    // Skill zips are built, not committed: the checks on the raw folder ask for them, and the build creates them.
    const raw = validatePackage(contents, getLayout(policy, layout), { zipLimits: policy.limits.packageRead });
    expect(raw.results.map((r) => r.code)).toEqual(exp.zipsBuilt.map(() => "package.archive-missing"));
    // The full build also produces the package zip.
    const full = buildRelease(contents, getLayout(policy, layout), { zipLimits: policy.limits.packageRead });
    expect(full.ok).toBe(true);
    expect(full.packageZip?.data.length).toBeGreaterThan(1000);
  });

  it("gives skills their agent types from reference/ASSET-METADATA.json", async () => {
    const m = map(await read(dir, layout), layout);
    const types = Object.fromEntries(m.assets.filter((a) => a.assetType === "skill").map((a) => [a.key, a.metadata.agent_types]));
    expect(types).toEqual(exp.skillAgentTypes);
  });

  it("keeps the AnyCompany safety responses in the global instructions, each on its own line", async () => {
    const lines = text(await read(dir, layout), "instructions/global.md").split("\n");
    expect(lines).toContain("[READ-ONLY]: This agent gives advice only. A person makes every infrastructure and code change.");
    expect(lines).toContain("[DATA REDACTED]: The request contains credentials or personal data and was not processed.");
  });

  it("catches a dotted tool invocation, a changed safety response and a memory over budget", async () => {
    const contents = await read(dir, layout);
    const dotted = checkPackage(change(contents, { "skills/bounded-log-query/SKILL.md": `${text(contents, "skills/bounded-log-query/SKILL.md")}\nRun anyco_logs.search for the window.\n` }), { policy, layout });
    expect(dotted.ok).toBe(false);
    expect(dotted.results.filter((r) => r.level === "error").map((r) => [r.code, r.path])).toEqual([["package.dotted-invocation", "skills/bounded-log-query/SKILL.md"]]);
    for (const call of ["anyco_metrics.query", "anyco_changes.list", "anyco_cmdb.lookup", "anyco_traces.search"]) {
      const r = checkPackage(change(contents, { "instructions/chat.md": `${text(contents, "instructions/chat.md")}\nCall ${call} now.\n` }), { policy, layout });
      expect(r.results.map((x) => x.code), call).toContain("package.dotted-invocation");
    }
    // The tool names as the instructions write them do not match.
    expect(checkPackage(change(contents, { "instructions/chat.md": `${text(contents, "instructions/chat.md")}\nCall anyco_logs_search and anyco_cmdb_lookup.\n` }), { policy, layout }).ok).toBe(true);

    const noSafety = checkPackage(change(contents, { "instructions/global.md": text(contents, "instructions/global.md").replace("[READ-ONLY]: This agent gives advice only.", "[READ-ONLY]: Advice only.") }), { policy, layout });
    expect(noSafety.ok).toBe(false);
    expect(noSafety.results.filter((r) => r.level === "error").map((r) => [r.code, r.path])).toEqual([["package.safety-message", "instructions/global.md"]]);
    const noOther = checkPackage(change(contents, { "instructions/global.md": text(contents, "instructions/global.md").replace("[DATA REDACTED]", "[REDACTED]") }), { policy, layout });
    expect(noOther.results.filter((r) => r.code === "package.safety-message").map((r) => r.message)).toEqual([expect.stringContaining("[DATA REDACTED]: The request contains credentials or personal data and was not processed.")]);

    const big = checkPackage(change(contents, { "memory/runbooks/log-query-limits.md": `${text(contents, "memory/runbooks/log-query-limits.md")}\n${"x".repeat(17000)}\n` }), { policy, layout });
    // A design target warns but doesn't fail the package, so a revision with large memories can still be exported.
    expect(big.results.filter((r) => r.code === "package.memory-size").map((r) => r.level)).toEqual(["warning"]);
    expect(big.ok).toBe(true);
  });

  it("holds the memory bodies exactly as the story gives them, between the frontmatter and the two closing lines", async () => {
    const contents = await read(dir, layout);
    for (const [store, name, v1, v2] of expected.memoryBodies as [string, string, string | null, string | null][]) {
      const body = version === "v1" ? v1 : v2;
      const file = `memory/${store}/${name}.md`;
      if (body === null) {
        expect(contents.files.has(file), file).toBe(false);
        continue;
      }
      const t = text(contents, file);
      expect(t.startsWith(`---\nname: ${name}\ndescription: `), file).toBe(true);
      expect(t.split("\n---\n\n")[1], file).toBe(`${body}\n\nMemory: ${store}/${name}\nReview this memory when an incident shows it is wrong.\n`);
    }
  });
});

describe("sample package v2 shared section", () => {
  const layout = LAYOUT.v2;

  it("is copied into the triage and RCA instructions between the markers", async () => {
    const contents = await read(samplePackageDir("v2"), layout);
    const handoff = text(contents, "instructions/shared/handoff.md").replace(/\n+$/, "");
    const begin = "<!-- shared: handoff (edit instructions/shared/handoff.md, then build the package) -->";
    const end = "<!-- /shared: handoff -->";
    for (const file of ["instructions/incident-triage.md", "instructions/incident-rca.md"]) {
      expect(text(contents, file)).toContain(`${begin}\n${handoff}\n${end}`);
    }
    for (const file of ["instructions/global.md", "instructions/chat.md", "instructions/incident-mitigation.md"]) expect(text(contents, file)).not.toContain("shared: handoff");
    // The source is not an asset.
    expect(map(contents, layout).assets.some((a) => a.source === "instructions/shared/handoff.md")).toBe(false);
    expect(map(contents, layout).roles.get("instructions/shared/handoff.md")).toEqual({ role: "non-asset" });
  });

  it("is rebuilt into both files when the source changes, and flagged stale until then", async () => {
    const contents = await read(samplePackageDir("v2"), layout);
    const edited = change(contents, { "instructions/shared/handoff.md": `${text(contents, "instructions/shared/handoff.md")}6. **Next step.** The one thing the next agent should do first.\n` });
    const zipLimits = policy.limits.packageRead;
    const stale = validatePackage(edited, getLayout(policy, layout), { requireArchives: false, zipLimits });
    expect(stale.results.filter((r) => r.code === "package.shared-stale").map((r) => r.path).sort()).toEqual(["instructions/incident-rca.md", "instructions/incident-triage.md"]);
    const built = checkPackage(edited, { policy, layout });
    expect(built.ok).toBe(true);
    expect(built.build.changes.filter((c) => c.change === "updated").map((c) => c.path)).toEqual(["instructions/incident-rca.md", "instructions/incident-triage.md"]);
    for (const file of ["instructions/incident-triage.md", "instructions/incident-rca.md"]) expect(text(built.build.contents, file)).toContain("6. **Next step.**");
  });

  it("reports missing markers and a missing source", async () => {
    const contents = await read(samplePackageDir("v2"), layout);
    const noMarker = checkPackage(change(contents, { "instructions/incident-rca.md": text(contents, "instructions/incident-rca.md").replace("<!-- /shared: handoff -->", "") }), { policy, layout });
    expect(noMarker.results.filter((r) => r.level === "error").map((r) => [r.code, r.path])).toEqual([["package.shared-markers", "instructions/incident-rca.md"]]);
    const noSource = checkPackage(change(contents, { "instructions/shared/handoff.md": null }), { policy, layout });
    expect(noSource.results.filter((r) => r.level === "error").map((r) => r.code)).toEqual(["package.shared-source-missing"]);
  });

  it("is not part of package v1, which uses the layout without the section", async () => {
    const v1 = await read(samplePackageDir("v1"), LAYOUT.v1);
    expect([...v1.files.keys()].some((p) => p.startsWith("instructions/shared/"))).toBe(false);
    expect(v1.files.get("instructions/incident-triage.md")!.toString("utf8")).not.toContain("shared:");
  });
});

describe("v1 to v2", () => {
  it("adds, removes and changes the assets the story describes", async () => {
    const v1 = map(await read(samplePackageDir("v1"), LAYOUT.v1), LAYOUT.v1).assets;
    const v2 = map(await read(samplePackageDir("v2"), LAYOUT.v2), LAYOUT.v2).assets;
    const diff = compare(v1, v2);
    expect(diff).toEqual(expected.v1ToV2);
    // The story, in words: one skill added and one removed, one memory added, four skills revised, three instructions changed.
    expect(diff.added).toEqual(["memory:incident-patterns/patterns/low-traffic-alarms", "skill:consumer-lag-check"]);
    expect(diff.removed).toEqual(["skill:legacy-dashboard-links"]);
    expect(diff.changed.filter((k) => k.startsWith("skill:"))).toEqual(["skill:bounded-log-query", "skill:cache-path-check", "skill:change-window-search", "skill:vendor-status-check"]);
    expect(diff.changed.filter((k) => k.startsWith("agents_md:"))).toEqual(["agents_md:GENERIC", "agents_md:INCIDENT_RCA", "agents_md:INCIDENT_TRIAGE"]);
    expect(diff.unchanged.filter((k) => k.startsWith("skill:"))).toEqual(["skill:feature-flag-audit", "skill:low-sample-size-check", "skill:token-signing-check"]);
  });

  it("gives the revised cache skill a new reference file", async () => {
    const files = (assets: DesiredAsset[]) => assets.find((a) => a.key === "cache-path-check")!.files.map((f) => f.path);
    const v1 = map(await read(samplePackageDir("v1"), LAYOUT.v1), LAYOUT.v1).assets;
    const v2 = map(await read(samplePackageDir("v2"), LAYOUT.v2), LAYOUT.v2).assets;
    expect(files(v1)).toEqual(["SKILL.md"]);
    expect(files(v2)).toEqual(["SKILL.md", "references/cache-metrics.md"]);
  });
});

describe("export of the sample package v2", () => {
  const layout = LAYOUT.v2;
  // The manifest leaves out the values the layout's manifestDefaults give (status ACTIVE), so a package read back has no status where the sample's own manifest wrote it.
  const withoutDefaults = (metadata: Record<string, unknown>) => Object.fromEntries(Object.entries(metadata).filter(([k, v]) => !(k === "status" && v === "ACTIVE")));
  const project = (c: PackageContents) => map(c, layout).assets.map((a) => ({ type: a.assetType, key: a.key, metadata: withoutDefaults(a.metadata), refs: a.refs, files: a.files.map((f) => [f.path, f.content]) }));
  const agentTypesOf = (manifest: Buffer) => Object.fromEntries((JSON.parse(manifest.toString("utf8")).assets as { assetType: string; key: string; metadata: { agent_types?: string[] } }[]).map((a) => [`${a.assetType}:${a.key}`, a.metadata.agent_types]));

  it("exports the assets back to the same package files, deterministically", async () => {
    const contents = await read(samplePackageDir("v2"), layout);
    const mapped = map(contents, layout);
    const built = buildRelease(contents, getLayout(policy, layout), { zipLimits: policy.limits.packageRead, packageZip: false });

    const exp = exportPackageZip(mapped.assets, layout, { policy, base: contents });
    expect(exp.results.filter((r) => r.level === "error")).toEqual([]);
    expect(exp.ok).toBe(true);
    expect([...exp.contents.files.keys()]).toEqual([...built.contents.files.keys()]);
    const MANIFEST = "reference/ASSET-METADATA.json";
    for (const [p, want] of built.contents.files) if (p !== MANIFEST) expect(exp.contents.files.get(p)!.equals(want), p).toBe(true);
    // The export writes the manifest in its own format and leaves out what the layout already gives: the default status, and the default agent types of a skill.
    const written = agentTypesOf(exp.contents.files.get(MANIFEST)!);
    const sample = agentTypesOf(built.contents.files.get(MANIFEST)!);
    const defaults = getLayout(policy, layout).skills!.agentTypes.default;
    for (const [key, types] of Object.entries(sample)) expect(written[key] ?? defaults, key).toEqual(types);
    expect(Object.keys(written).filter((k) => !(k in sample))).toEqual([]);
    expect(exportPackageZip(mapped.assets, layout, { policy, base: contents }).zip.equals(exp.zip)).toBe(true);
  });

  it("recovers the shared section source and maps back to the same assets without a base", async () => {
    const contents = await read(samplePackageDir("v2"), layout);
    const bare = exportPackageZip(map(contents, layout).assets, layout, { policy });
    expect(bare.contents.files.get("instructions/shared/handoff.md")).toEqual(contents.files.get("instructions/shared/handoff.md"));
    expect(project(readPackageZip(bare.zip, bare.fileName, { policy, layout }))).toEqual(project(contents));
  });
});

describe("sample Agent Space export", () => {
  const layout = LAYOUT.export;
  const exp = expected.packages.agentSpaceExport;
  const load = async () => map(await read(sampleAgentSpaceExportDir(), layout), layout);

  it("maps every folder to an asset, from its descriptor", async () => {
    const contents = await read(sampleAgentSpaceExportDir(), layout);
    const m = map(contents, layout);
    expect(m.results).toEqual([]);
    expect(countByType(m.assets)).toEqual(exp.assetsByType);
    expect(m.assets).toHaveLength(exp.total);
    expect([...m.roles].filter(([, r]) => r.role === "unmapped" || r.role === "skipped")).toEqual([]);
    expect(m.roles.get("INDEX.json")).toEqual({ role: "manifest" });
    expect(m.roles.get("README.md")).toEqual({ role: "non-asset" });
    const ids = m.assets.filter((a) => a.sourceAssetId).map((a) => a.sourceAssetId!);
    expect(ids).toHaveLength(exp.assetIds.length);
    expect([...ids].sort()).toEqual(exp.assetIds);
    expect(ids.every((id) => /^ki-00000000-0000-4000-8000-0000000001\d\d$/.test(id))).toBe(true);
    // Bookkeeping keys never reach the metadata, and the descriptor is not a file of the asset.
    for (const a of m.assets.filter((x) => x.sourceAssetId)) {
      expect(Object.keys(a.metadata).filter((k) => ["version", "createdAt", "updatedAt", "creator", "editor"].includes(k))).toEqual([]);
      expect(a.files.some((f) => f.path === "_asset.json")).toBe(false);
    }
  });

  it("maps to the same assets as v2, plus the custom agents and the older skill copy", async () => {
    const v2 = map(await read(samplePackageDir("v2"), LAYOUT.v2), LAYOUT.v2).assets;
    const space = (await load()).assets;
    const diff = compareCore(v2, space);
    expect(diff).toEqual(exp.againstV2);
    // What the two share is byte for byte: the files of each asset.
    const byKey = new Map(space.map((a) => [assetKeyOf(a), a]));
    for (const a of v2) {
      const same = byKey.get(assetKeyOf(a))!;
      expect(same.files.map((f) => [f.path, f.content]), assetKeyOf(a)).toEqual(a.files.map((f) => [f.path, f.content]));
    }
  });

  it("passes the build and the package checks, and the checks look inside the export by descriptor", async () => {
    const contents = await read(sampleAgentSpaceExportDir(), layout);
    const check = checkPackage(contents, { policy, layout });
    expect(check.ok).toBe(true);
    expect(check.build.changes).toEqual([]);
    expect(check.results.map((r) => [r.level, r.code])).toEqual(exp.checkResults);

    const global = text(contents, "agents_md/global/AGENTS.md");
    const noSafety = checkPackage(change(contents, { "agents_md/global/AGENTS.md": global.replace("[DATA REDACTED]", "[REDACTED]") }), { policy, layout });
    expect(noSafety.results.filter((r) => r.level === "error").map((r) => [r.code, r.path])).toEqual([["package.safety-message", "agents_md/global/AGENTS.md"]]);
    // Without GENERIC instructions nothing is checked.
    const none = checkPackage(change(contents, { "agents_md/global/AGENTS.md": null, "agents_md/global/_asset.json": null }), { policy, layout, includeTypes: ["agents_md"] });
    expect(none.results.filter((r) => r.code.startsWith("package.safety"))).toEqual([]);

    const agent = text(contents, "custom_agent/capacity-reviewer/capacity-reviewer.md");
    const dotted = checkPackage(change(contents, { "custom_agent/capacity-reviewer/capacity-reviewer.md": `${agent}\nCall anyco_metrics.query.\n` }), { policy, layout });
    expect(dotted.results.filter((r) => r.level === "error").map((r) => [r.code, r.path])).toEqual([["package.dotted-invocation", "custom_agent/capacity-reviewer/capacity-reviewer.md"]]);
  });

  it("lists every folder in INDEX.json with the descriptor's asset ID", async () => {
    const contents = await read(sampleAgentSpaceExportDir(), layout);
    const index = JSON.parse(text(contents, "INDEX.json")) as { assets: { dir: string; assetId: string; status: string }[] };
    expect(index.assets.map((a) => a.dir)).toEqual(exp.indexDirs);
    for (const a of index.assets) expect(JSON.parse(text(contents, `${a.dir}/_asset.json`)).assetId).toBe(a.assetId);
    const old = index.assets.find((a) => a.dir === "skill/cache-path-check.v1")!;
    expect([old.assetId, old.status]).toEqual(exp.olderSkill);
    // A stale index is a warning, not an error.
    const stale = packageToDesiredAssets(change(contents, { "INDEX.json": JSON.stringify({ assets: [{ dir: "skill/cache-path-check", assetId: "ki-wrong" }] }) }), layout, { policy });
    expect(stale.results.every((r) => r.level === "warning" && r.code === "package.index-stale")).toBe(true);
    expect(stale.results.length).toBeGreaterThan(1);
  });

  describe("duplicate skills", () => {
    const live = (assets: readonly DesiredAsset[]): LiveAssetRef[] => assets.filter((a) => a.sourceAssetId).map((a) => ({ assetId: a.sourceAssetId!, assetType: a.assetType, metadata: a.metadata }));
    const layoutRule = getLayout(policy, layout);

    it("gives the older copy its own key and leaves it out of any other space", async () => {
      const { assets } = await load();
      const keys = assets.filter((a) => a.assetType === "skill" && a.metadata.name === "cache-path-check").map((a) => [a.key, a.source, a.metadata.status]);
      expect(keys).toEqual([
        ["cache-path-check", "skill/cache-path-check", "ACTIVE"],
        ["cache-path-check@ki-00000000-0000-4000-8000-000000000113", "skill/cache-path-check.v1", "INACTIVE"],
      ]);
      const t = targetPackageAssets(assets, { policy, layout: layoutRule, live: [] });
      expect(t.leftOut.map((l) => [l.reason, l.asset.source, l.keptKey])).toEqual([["duplicate", "skill/cache-path-check.v1", "cache-path-check"]]);
      expect(t.leftOut[0]!.message).toBe(
        "skill/cache-path-check.v1 is left out: skill/cache-path-check has the same name, cache-path-check, and has status ACTIVE. Assets that share a name are all imported only into a space that holds each of their asset IDs.",
      );
      expect(t.results.map((r) => [r.level, r.code])).toEqual([["warning", "import.duplicate-left-out"]]);
      expect(t.assets).toHaveLength(exp.total - 1);
      // The custom agents refer to skills by ID in the export; elsewhere the references become names.
      const agents = Object.fromEntries(t.assets.filter((a) => a.assetType === "custom_agent").map((a) => [a.key, a.refs]));
      expect(agents).toEqual(exp.customAgentRefs);
    });

    it("keeps both copies in the space the export came from, each updating its own asset", async () => {
      const { assets } = await load();
      const space = live(assets);
      const t = targetPackageAssets(assets, { policy, layout: layoutRule, live: space });
      expect(t.leftOut).toEqual([]);
      expect(t.results).toEqual([]);
      expect(t.assets.filter((a) => a.metadata.name === "cache-path-check").map((a) => [a.key, a.assetId])).toEqual([
        ["cache-path-check", "ki-00000000-0000-4000-8000-000000000112"],
        ["cache-path-check@ki-00000000-0000-4000-8000-000000000113", "ki-00000000-0000-4000-8000-000000000113"],
      ]);
      const set = validateAssetSet(t.assets, { policy, live: space, perAsset: false });
      expect(set.filter((r) => r.level === "error")).toEqual([]);
      expect(set.filter((r) => r.code === "identity.duplicate-live")).toHaveLength(2);
    });

    it("leaves both copies out when both are ACTIVE", async () => {
      const contents = await read(sampleAgentSpaceExportDir(), layout);
      const old = JSON.parse(text(contents, "skill/cache-path-check.v1/_asset.json"));
      old.metadata.status = "ACTIVE";
      const both = packageToDesiredAssets(change(contents, { "skill/cache-path-check.v1/_asset.json": JSON.stringify(old) }), layout, { policy }).assets;
      const t = targetPackageAssets(both, { policy, layout: layoutRule, live: [] });
      expect(t.leftOut.map((l) => l.asset.source).sort()).toEqual(["skill/cache-path-check", "skill/cache-path-check.v1"]);
      expect(t.assets.some((a) => a.metadata.name === "cache-path-check")).toBe(false);
    });
  });
});

/** Like compare(), but a changed asset is one whose metadata keys in both, or whose files, differ (the export adds service keys such as skill_type). */
function compareCore(v2: readonly DesiredAsset[], space: readonly DesiredAsset[]) {
  const core = (a: DesiredAsset) => JSON.stringify([Object.fromEntries(Object.keys(a.metadata).filter((k) => ["agent_type", "name", "description", "agent_types"].includes(k)).sort().map((k) => [k, a.metadata[k]])), a.files.map((f) => [f.path, f.content])]);
  const before = new Map(v2.map((a) => [assetKeyOf(a), a]));
  const after = new Map(space.map((a) => [assetKeyOf(a), a]));
  return {
    onlyInExport: [...after.keys()].filter((k) => !before.has(k)).sort(),
    onlyInV2: [...before.keys()].filter((k) => !after.has(k)).sort(),
    different: [...after.keys()].filter((k) => before.has(k) && core(before.get(k)!) !== core(after.get(k)!)).sort(),
  };
}

describe("sample-data text", () => {
  /** Every file under a folder, as paths. */
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
  }

  it("has no em dashes", () => {
    const owned = ["packages", "policy", "journals/live-runs", "expected"].flatMap((d) => files(path.join(SAMPLE_DATA_DIR, d)));
    expect(owned.length).toBeGreaterThan(80);
    const dash = String.fromCharCode(0x2014);
    expect(owned.filter((f) => readFileSync(f, "utf8").includes(dash))).toEqual([]);
  });

  it("has no code fences in instructions, skills and memory, which the journal exports cannot carry", () => {
    const fence = "`".repeat(3);
    const md = files(path.join(SAMPLE_DATA_DIR, "packages")).filter((f) => f.endsWith(".md"));
    expect(md.filter((f) => readFileSync(f, "utf8").includes(fence))).toEqual([]);
  });
});
