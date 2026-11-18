import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { validateAssetSet } from "@/server/validation/set";
import { checkPackage } from "./check";
import { packageToDesiredAssets } from "./desired";
import { rankLayouts } from "./detect";
import { exportPackageZip } from "./export";
import { getLayout } from "./layout";
import { readPackageZip } from "./read";
import { targetPackageAssets } from "./target";
import { agentSpacePackage, descriptor, SAFETY, SPACE_IDS as I } from "./test-support/agent-space";
import { testPolicy } from "./test-support/policy";
import type { DesiredAsset, DesiredFile, LiveAssetRef, PackageContents } from "./types";

/**
 * The Agent Space folder layout (agent-space-folders): mapping, targeting a
 * space, detection and export, on a synthetic package. The sample Agent Space
 * export is covered in sample-data.test.ts.
 */

const policy = getAppPolicy().policy;
const layout = getLayout(policy, "agent-space-folders");
// The test layout `strict-folders` adds the text checks that the default layout leaves empty.
const strict = testPolicy();
const strictLayout = getLayout(strict, "strict-folders");

const bytesOf = (f: DesiredFile) => Buffer.from(f.content, f.encoding === "utf8" ? "utf8" : "base64");
const countByType = (assets: readonly DesiredAsset[]) => Object.fromEntries([...new Set(assets.map((a) => a.assetType))].map((t) => [t, assets.filter((a) => a.assetType === t).length]));
const live = (assetId: string, assetType: string, metadata: Record<string, unknown>): LiveAssetRef => ({ assetId, assetType, metadata });

/**
 * Every file of a folder asset (and of a memory, which keeps its frontmatter)
 * is the package file's bytes, and no descriptor or index is an asset file.
 * A memory store's file is its STORE.md body in the instruction folders layout, so it is not compared.
 */
function expectByteExact(contents: PackageContents, assets: readonly DesiredAsset[]) {
  for (const a of assets) {
    if (!a.sourceAssetId && a.assetType !== "memory") continue;
    for (const f of a.files) {
      expect(f.path.endsWith("_asset.json"), `${a.key}: ${f.path}`).toBe(false);
      expect(f.sourcePath).not.toBe("INDEX.json");
      expect(bytesOf(f).equals(contents.files.get(f.sourcePath!)!), f.sourcePath).toBe(true);
    }
  }
}

describe("agent-space-folders mapping", () => {
  it("maps each descriptor folder to an asset with its descriptor's type, metadata and source ID", () => {
    const contents = agentSpacePackage();
    const m = packageToDesiredAssets(contents, layout, { policy });
    expect(m.results).toEqual([]);
    expect(countByType(m.assets)).toEqual({ agents_md: 2, skill: 3, memory_store: 1, memory: 1, custom_agent: 1 });
    const verity = m.assets.find((a) => a.key === "verity")!;
    expect(verity).toMatchObject({ assetType: "skill", source: "skill/verity", sourceAssetId: I.verity, metadata: { name: "verity", status: "ACTIVE", skill_type: "USER" } });
    expect(verity.assetId).toBeUndefined();
    // Bookkeeping keys never reach the metadata, and the descriptor is not a file of the asset.
    expect(Object.keys(verity.metadata).sort()).toEqual(["agent_types", "description", "name", "skill_type", "status"]);
    expect(verity.files.map((f) => f.path)).toEqual(["SKILL.md", "references/sources.md"]);
    // The older copy keeps its own key, so results and rows stay apart.
    expect(m.assets.find((a) => a.source === "skill/verity.v1")!.key).toBe(`verity@${I.verityOld}`);
    const reviewer = m.assets.find((a) => a.assetType === "custom_agent")!;
    expect(reviewer.files.map((f) => f.path)).toEqual(["reviewer.md"]);
    expect(reviewer.metadata.skills).toEqual([I.verity, I.probe]);
    // memory/ has no descriptors and maps with the instruction folders STORE.md rules.
    expect(m.assets.find((a) => a.assetType === "memory")).toMatchObject({ key: "notes/first", refs: { memoryStore: "notes" } });
    // The descriptor belongs to its asset, so leaving the asset out of a download takes it too.
    expect(m.roles.get("agents_md/global/_asset.json")).toEqual({ role: "manifest", assetKey: "agents_md:GENERIC" });
    expect(m.roles.get("INDEX.json")).toEqual({ role: "manifest" });
    expect(m.roles.get("reference/DEPLOY.md")).toEqual({ role: "non-asset" });
    expect(m.roles.get(".gitignore")).toEqual({ role: "non-asset" });
    expectByteExact(contents, m.assets);
  });

  it("keeps file bytes exact, including a byte order mark and binary files", () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Global\r\n\r\n" + SAFETY, "utf8")]);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const contents = agentSpacePackage({ "agents_md/global/AGENTS.md": bom, "skill/verity/references/diagram.png": png });
    const m = packageToDesiredAssets(contents, layout, { policy });
    expectByteExact(contents, m.assets);
    expect(m.assets.find((a) => a.key === "verity")!.files.find((f) => f.path === "references/diagram.png")!.encoding).toBe("base64");
  });

  it("reports folders without a usable descriptor and leaves their files out", () => {
    const contents = agentSpacePackage({
      "skill/no-descriptor/SKILL.md": "---\nname: no-descriptor\ndescription: x\n---\n",
      "skill/broken/_asset.json": "{ not json",
      "skill/broken/SKILL.md": "# Broken\n",
      "skill/misplaced/_asset.json": descriptor("ki-a0000000-0000-4000-8000-0000000000f1", "custom_agent", { name: "misplaced" }),
      "skill/misplaced/SKILL.md": "# x\n",
      "custom_agent/nameless/_asset.json": descriptor("ki-a0000000-0000-4000-8000-0000000000f2", "custom_agent", { name: "nameless" }, { note: "kept by hand" }),
      "custom_agent/nameless/notes.md": "No main file.\n",
      "skill/twin/_asset.json": descriptor(I.probe, "skill", { name: "twin", description: "Same ID as probe.", agent_types: ["GENERIC"] }),
      "skill/twin/SKILL.md": "---\nname: twin\ndescription: Same ID as probe.\n---\n",
    });
    const m = packageToDesiredAssets(contents, layout, { policy });
    const codes = m.results.map((r) => `${r.level} ${r.code} ${r.path}`);
    expect(codes).toContain("warning package.descriptor-missing skill/no-descriptor");
    expect(m.roles.get("skill/no-descriptor/SKILL.md")).toEqual({ role: "unmapped" });
    expect(codes).toContain("error package.descriptor-invalid skill/broken/_asset.json");
    expect(m.roles.get("skill/broken/SKILL.md")).toEqual({ role: "skipped" });
    expect(codes).toContain("error package.descriptor-type skill/misplaced/_asset.json");
    expect(codes).toContain("warning package.descriptor-key custom_agent/nameless/_asset.json");
    expect(codes).toContain("error package.main-file-missing custom_agent/nameless");
    expect(codes.filter((c) => c.startsWith("error package.duplicate-asset-id"))).toHaveLength(2);
    // The test's INDEX.json lists every folder with a readable descriptor.
    expect(m.results.filter((r) => r.code === "package.index-stale").map((r) => r.message)).toEqual(["INDEX.json doesn't list skill/broken/."]);
  });

  it("checks INDEX.json against the folders, as warnings", () => {
    const index = JSON.stringify({ assets: [{ dir: "skill/verity", assetId: I.probe }, { dir: "skill/gone", assetId: "ki-x" }] });
    const m = packageToDesiredAssets(agentSpacePackage({ "INDEX.json": index }), layout, { policy });
    const stale = m.results.filter((r) => r.code === "package.index-stale").map((r) => r.message);
    expect(stale).toContain(`INDEX.json gives skill/verity/ the asset ID ${I.probe}, but its _asset.json says ${I.verity}.`);
    expect(stale).toContain("INDEX.json lists skill/gone/, which is not an asset folder in the package.");
    expect(stale).toContain("INDEX.json doesn't list agents_md/global/.");
    expect(m.results.every((r) => r.level === "warning")).toBe(true);
  });

  it("checks the safety messages in the GENERIC instructions, found by descriptor", () => {
    const missing = checkPackage(agentSpacePackage({ "agents_md/global/AGENTS.md": "# Global\n" }), { policy: strict, layout: strictLayout, includeTypes: ["agents_md"] });
    expect(checkPackage(agentSpacePackage(), { policy: strict, layout: strictLayout, includeTypes: ["agents_md"] }).results.filter((r) => r.code === "package.safety-message")).toEqual([]);
    // The default layout has no text rules.
    expect(checkPackage(agentSpacePackage({ "agents_md/global/AGENTS.md": "# Global\n" }), { policy, layout, includeTypes: ["agents_md"] }).results.filter((r) => r.code === "package.safety-message")).toEqual([]);
    expect(missing.results.filter((r) => r.code === "package.safety-message").map((r) => r.path)).toEqual(["agents_md/global/AGENTS.md", "agents_md/global/AGENTS.md"]);
    // Without GENERIC instructions in the package nothing is checked (the rule says missing: skip).
    const none = checkPackage(agentSpacePackage({ "agents_md/global/_asset.json": null, "agents_md/global/AGENTS.md": null }), { policy: strict, layout: strictLayout, includeTypes: ["agents_md"] });
    expect(none.results.filter((r) => r.code.startsWith("package.safety") || r.code === "package.required-file-missing")).toEqual([]);
    // Leaving instructions out leaves their package checks out too.
    expect(checkPackage(agentSpacePackage({ "agents_md/global/AGENTS.md": "# Global\n" }), { policy: strict, layout: strictLayout, includeTypes: ["skill"] }).results.some((r) => r.code === "package.safety-message")).toBe(false);
  });
});

describe("targeting a space", () => {
  const mapped = () => packageToDesiredAssets(agentSpacePackage(), layout, { policy }).assets;
  const sourceSpace: LiveAssetRef[] = [
    live(I.global, "agents_md", { agent_type: "GENERIC", status: "ACTIVE" }),
    live(I.triage, "agents_md", { agent_type: "INCIDENT_TRIAGE", status: "ACTIVE" }),
    live(I.verity, "skill", { name: "verity", status: "ACTIVE" }),
    live(I.verityOld, "skill", { name: "verity", status: "ACTIVE" }),
    live(I.probe, "skill", { name: "probe", status: "ACTIVE" }),
    live(I.reviewer, "custom_agent", { name: "reviewer" }),
    live(I.liveStore, "memory_store", { name: "patterns" }),
  ];

  it("updates by source asset ID and keeps both copies of a name in the space they came from", () => {
    const t = targetPackageAssets(mapped(), { policy, layout, live: sourceSpace });
    expect(t.leftOut).toEqual([]);
    expect(t.results).toEqual([]);
    expect(t.assets.filter((a) => a.assetType === "skill").map((a) => [a.key, a.assetId])).toEqual([
      ["probe", I.probe],
      ["verity", I.verity],
      [`verity@${I.verityOld}`, I.verityOld],
    ]);
    // Every referenced ID is live there, so the references stay IDs.
    const reviewer = t.assets.find((a) => a.assetType === "custom_agent")!;
    expect(reviewer).toMatchObject({ assetId: I.reviewer, metadata: { skills: [I.verity, I.probe], memory_stores: [I.liveStore] } });
    expect(reviewer.refs).toBeUndefined();
    // Both live copies already share the name: a warning, not an error.
    const set = validateAssetSet(t.assets, { policy, live: sourceSpace, perAsset: false });
    expect(set.filter((r) => r.level === "error")).toEqual([]);
    expect(set.filter((r) => r.code === "identity.duplicate-live")).toHaveLength(2);
  });

  it("plans the ACTIVE copy elsewhere and leaves the other out with the reason", () => {
    const t = targetPackageAssets(mapped(), { policy, layout, live: [live(I.verity, "skill", { name: "verity" }), live(I.liveStore, "memory_store", { name: "patterns" })] });
    expect(t.leftOut.map((l) => [l.reason, l.asset.source, l.keptKey])).toEqual([["duplicate", "skill/verity.v1", "verity"]]);
    expect(t.leftOut[0]!.message).toBe(
      "skill/verity.v1 is left out: skill/verity has the same name, verity, and has status ACTIVE. Assets that share a name are all imported only into a space that holds each of their asset IDs.",
    );
    expect(t.results).toMatchObject([{ level: "warning", code: "import.duplicate-left-out", assetKey: `skill:verity@${I.verityOld}` }]);
    expect(t.assets.find((a) => a.key === "verity")!.assetId).toBe(I.verity);
    expect(t.assets.find((a) => a.key === "probe")!.assetId).toBeUndefined();
  });

  it("leaves every copy out when none or several are ACTIVE", () => {
    const both = packageToDesiredAssets(
      agentSpacePackage({ "skill/verity.v1/_asset.json": descriptor(I.verityOld, "skill", { name: "verity", description: "Older procedure.", agent_types: ["GENERIC"], status: "ACTIVE", skill_type: "USER" }) }),
      layout,
      { policy },
    ).assets;
    const t = targetPackageAssets(both, { policy, layout, live: [] });
    expect(t.leftOut.map((l) => l.asset.source).sort()).toEqual(["skill/verity", "skill/verity.v1"]);
    expect(t.leftOut[0]!.message).toContain("more than one has status ACTIVE");
    expect(t.assets.some((a) => a.metadata.name === "verity")).toBe(false);
  });

  it("remaps references to the package's assets as names, and reports IDs that are nowhere", () => {
    const t = targetPackageAssets(mapped(), { policy, layout, live: [] });
    const reviewer = t.assets.find((a) => a.assetType === "custom_agent")!;
    expect(reviewer.refs).toEqual({ skills: ["verity", "probe"] });
    expect(reviewer.metadata.skills).toBeUndefined();
    expect(reviewer.metadata.memory_stores).toEqual([]);
    // A custom agent's stores are optional, so the unknown one is dropped with a warning, not an error.
    expect(t.results.filter((r) => r.level === "error")).toEqual([]);
    expect(t.results.filter((r) => r.code === "reference.not-in-package")).toEqual([
      {
        level: "warning",
        code: "reference.not-in-package",
        message: `memory_stores names memory store ${I.liveStore}, which is not in this package or in this space, so the plan leaves this reference out.`,
        assetKey: "custom_agent:reviewer",
        path: "metadata.memory_stores",
      },
    ]);
    // A space that has the store by ID and a live skill verity: the live ID turns into its name next to the package's probe.
    const t2 = targetPackageAssets(mapped(), { policy, layout, live: [live("ki-live-verity", "skill", { name: "verity" }), live(I.liveStore, "memory_store", { name: "patterns" })] });
    const r2 = t2.assets.find((a) => a.assetType === "custom_agent")!;
    expect(r2).toMatchObject({ refs: { skills: ["verity", "probe"] }, metadata: { memory_stores: [I.liveStore] } });
    expect(t2.results.filter((r) => r.level === "error")).toEqual([]);
    expect(validateAssetSet(t2.assets, { policy, live: [live("ki-live-verity", "skill", { name: "verity" }), live(I.liveStore, "memory_store", { name: "patterns" })], perAsset: false }).filter((r) => r.code.startsWith("reference"))).toEqual([]);
  });

  it("resolves a store ID through the package's STORE.md asset_id, by name in another space", () => {
    const store = `---\nstore: notes\nasset_id: ${I.liveStore}\ndescription: Demo notes. Read when testing.\nagent_types: Generic (all agents)\n---\n\nDemo store.\n`;
    const assets = packageToDesiredAssets(agentSpacePackage({ "memory/notes/STORE.md": store }), layout, { policy }).assets;
    expect(assets.find((a) => a.assetType === "memory_store")).toMatchObject({ sourceAssetId: I.liveStore, metadata: { name: "notes" } });
    // Another space with a store named notes: the reference becomes the name, which the plan resolves there.
    const elsewhere = [live("ki-b0000000-0000-4000-8000-000000000001", "memory_store", { name: "notes" })];
    const t = targetPackageAssets(assets, { policy, layout, live: elsewhere });
    expect(t.assets.find((a) => a.assetType === "custom_agent")!.refs).toEqual({ skills: ["verity", "probe"], memoryStores: ["notes"] });
    expect(t.results.filter((r) => r.code.startsWith("reference"))).toEqual([]);
  });

  it("checks an asset that matches a live one by name as an update, not a create", () => {
    // LEARNED skills can't be created, but one that exists here by name is an update.
    const learned: DesiredAsset = { assetType: "skill", key: "prefs", metadata: { name: "prefs", description: "Customer preferences.", agent_types: ["GENERIC"], skill_type: "LEARNED" }, files: [{ path: "SKILL.md", encoding: "utf8", content: "---\nname: prefs\ndescription: Customer preferences.\n---\n# Prefs\n" }] };
    expect(validateAssetSet([learned], { policy, live: [] }).map((r) => r.code)).toContain("metadata.create");
    expect(validateAssetSet([learned], { policy, live: [live("ki-c0000000-0000-4000-8000-000000000001", "skill", { name: "prefs", skill_type: "LEARNED" })] }).map((r) => r.code)).not.toContain("metadata.create");
  });

  it("leaves out the asset types that are not selected", () => {
    const t = targetPackageAssets(mapped(), { policy, layout, live: [], includeTypes: ["agents_md", "skill"] });
    expect(new Set(t.assets.map((a) => a.assetType))).toEqual(new Set(["agents_md", "skill"]));
    expect(t.leftOut.filter((l) => l.reason === "type-not-selected").map((l) => l.asset.assetType).sort()).toEqual(["custom_agent", "memory", "memory_store"]);
    // The custom agent is not checked at all, so its unknown store ID is not an error.
    expect(t.results.some((r) => r.level === "error")).toBe(false);
  });

  it("still reports a duplicate a change would create, and one without source IDs", () => {
    // Renaming probe to verity in the source space creates a third verity.
    const renamed = mapped().map((a) => (a.key === "probe" ? { ...a, metadata: { ...a.metadata, name: "verity" } } : a));
    const t = targetPackageAssets(renamed, { policy, layout, live: sourceSpace });
    expect(validateAssetSet(t.assets, { policy, live: sourceSpace, perAsset: false }).filter((r) => r.code === "identity.duplicate")).toHaveLength(3);
    const plain: DesiredAsset[] = [
      { assetType: "skill", key: "x", metadata: { name: "x", description: "d", agent_types: ["GENERIC"] }, files: [{ path: "SKILL.md", encoding: "utf8", content: "# x\n" }] },
      { assetType: "skill", key: "x", metadata: { name: "x", description: "e", agent_types: ["GENERIC"] }, files: [{ path: "SKILL.md", encoding: "utf8", content: "# y\n" }] },
    ];
    expect(targetPackageAssets(plain, { policy, layout, live: [] }).leftOut).toEqual([]);
    expect(validateAssetSet(plain, { policy, live: [] }).filter((r) => r.code === "identity.duplicate")).toHaveLength(2);
  });
});

describe("layout detection", () => {
  it("suggests the layout that maps the most files", () => {
    expect(rankLayouts(agentSpacePackage(), policy)[0]!.layout).toBe("agent-space-folders");
    const folders = readPackageZip(exportPackageZip(packageToDesiredAssets(agentSpacePackage(), layout, { policy }).assets, "instruction-folders", { policy, packageName: "folders" }).zip, "folders.zip", { policy });
    expect(rankLayouts(folders, policy)[0]!.layout).toBe("instruction-folders");
  });
});

describe("agent-space-folders export", () => {
  it("writes one folder per asset with its descriptor and INDEX.json, and reads back the same assets", () => {
    const original = packageToDesiredAssets(agentSpacePackage(), layout, { policy }).assets.map((a) => (a.sourceAssetId ? { ...a, assetId: a.sourceAssetId } : a));
    const out = exportPackageZip(original, layout, { policy, packageName: "space" });
    expect(out.results.filter((r) => r.level === "error")).toEqual([]);
    const files = [...out.contents.files.keys()];
    expect(files).toContain("agents_md/global/_asset.json");
    expect(files).toContain("agents_md/incident-triage/AGENTS.md");
    expect(files).toContain("skill/verity/references/sources.md");
    expect(files).toContain(`skill/verity__${I.verityOld}/SKILL.md`);
    expect(files).toContain("custom_agent/reviewer/reviewer.md");
    expect(files).toContain("memory/notes/STORE.md");
    expect(JSON.parse(out.contents.files.get("custom_agent/reviewer/_asset.json")!.toString("utf8"))).toEqual({
      assetId: I.reviewer,
      assetType: "custom_agent",
      metadata: { name: "reviewer", skills: [I.verity, I.probe], memory_stores: [I.liveStore], tools: ["anyco_changes_list"] },
    });
    const index = JSON.parse(out.contents.files.get("INDEX.json")!.toString("utf8")) as { assets: { dir: string; assetId: string }[] };
    expect(index.assets.map((a) => a.dir)).toEqual(["agents_md/global", "agents_md/incident-triage", "skill/probe", "skill/verity", `skill/verity__${I.verityOld}`, "custom_agent/reviewer"]);

    const back = packageToDesiredAssets(readPackageZip(out.zip, "space.zip", { policy, layout }), layout, { policy });
    expect(back.results).toEqual([]);
    const shape = (a: DesiredAsset) => ({ type: a.assetType, key: a.key, id: a.sourceAssetId ?? null, metadata: a.metadata, files: a.files.map((f) => [f.path, f.encoding, f.content]) });
    expect(back.assets.map(shape)).toEqual(original.map((a) => ({ ...shape(a) })));
  });

  it("writes a store's asset ID into STORE.md and reads it back as the source asset ID", () => {
    const storeId = "ki-a0000000-0000-4000-8000-000000000008";
    const original = packageToDesiredAssets(agentSpacePackage(), layout, { policy }).assets.map((a) => (a.assetType === "memory_store" ? { ...a, assetId: storeId } : a));
    const out = exportPackageZip(original, layout, { policy, packageName: "space" });
    expect(out.contents.files.get("memory/notes/STORE.md")!.toString("utf8")).toContain(`asset_id: ${storeId}`);
    const back = packageToDesiredAssets(out.contents, layout, { policy });
    expect(back.assets.find((a) => a.assetType === "memory_store")).toMatchObject({ sourceAssetId: storeId, metadata: { name: "notes" } });
    expect(back.assets.find((a) => a.assetType === "memory_store")!.metadata).not.toHaveProperty("asset_id");
  });
});
