import { describe, expect, it } from "vitest";
import { getLayout } from "@/server/packages/layout";
import { agentSpacePackage, SPACE_IDS as I } from "@/server/packages/test-support/agent-space";
import { getAppPolicy } from "@/server/policy";
import { analyzeImport, planItemsFromAnalysis, type LiveIndexEntry } from "./analyze";
import { createPlanRequestFromForm, layoutRequestFromForm } from "./forms";
import { buildImportDetail, resultTypes } from "./loaders";
import { importPlanNotes, type PackageImportRow } from "./service";

/**
 * The import planner with the Agent Space folder layout: matching by source
 * asset ID, then identity, then create; duplicates; type selection; plan
 * notes; the plan form; and the page loader's type options.
 */

const policy = getAppPolicy().policy;
const layout = getLayout(policy, "agent-space-folders");
const now = new Date("2026-11-13T00:00:00Z");

const entry = (assetId: string, assetType: string, metadata: Record<string, unknown>, name = String(metadata.name ?? metadata.agent_type)): LiveIndexEntry => ({
  assetId,
  assetType,
  name,
  metadata,
  liveVersion: 2,
  committed: null,
});

/** A space that holds GENERIC and verity by their source IDs, and a skill named probe under another ID. */
const space: LiveIndexEntry[] = [
  entry(I.global, "agents_md", { agent_type: "GENERIC", status: "ACTIVE" }),
  entry(I.verity, "skill", { name: "verity", status: "ACTIVE" }),
  entry("ki-b0000000-0000-4000-8000-000000000001", "skill", { name: "probe", status: "ACTIVE" }),
  entry(I.liveStore, "memory_store", { name: "patterns" }),
  entry("ki-b0000000-0000-4000-8000-000000000002", "skill", { name: "untouched", status: "ACTIVE" }),
];

const analyze = (includeTypes?: string[]) => analyzeImport({ contents: agentSpacePackage(), layout, policy, live: space, historyCommit: null, now, includeTypes });

describe("analyzeImport with Agent Space folders", () => {
  it("updates by source asset ID, then by identity, and creates the rest", () => {
    const a = analyze();
    const by = (key: string) => a.results.items.find((i) => i.key === key)!;
    expect(by("GENERIC")).toMatchObject({ action: "update", assetId: I.global, matchedBy: "asset-id", sourceAssetId: I.global });
    expect(by("verity")).toMatchObject({ action: "update", assetId: I.verity, matchedBy: "asset-id" });
    // probe's source ID is not in this space, but a live skill has its name.
    expect(by("probe")).toMatchObject({ action: "update", assetId: "ki-b0000000-0000-4000-8000-000000000001", matchedBy: "identity", sourceAssetId: I.probe });
    expect(by("INCIDENT_TRIAGE")).toMatchObject({ action: "create", assetId: null });
    expect(by("reviewer")).toMatchObject({ action: "create", refs: { skills: ["verity", "probe"] } });
    expect(by("reviewer").metadata).toMatchObject({ memory_stores: [I.liveStore] });
    expect(a.results.untouched.map((u) => u.name)).toEqual(["untouched", "patterns"]);
    // The older verity copy is left out: this space doesn't hold its ID.
    expect(a.results.leftOut).toEqual([
      expect.objectContaining({ assetKey: `skill:verity@${I.verityOld}`, reason: "duplicate", source: "skill/verity.v1", sourceAssetId: I.verityOld, keptKey: "verity" }),
    ]);
    expect(a.summary.counts.leftOut).toBe(1);
    expect(a.summary.ok).toBe(true);
    const notes = planItemsFromAnalysis(a).map((p) => p.note);
    expect(notes).toContain("From the package folder agents_md/global, matched by its asset ID.");
    expect(notes).toContain("From the package file skill/probe.");
  });

  it("plans only the selected types and notes what was left out", () => {
    const a = analyze(["agents_md", "skill"]);
    expect(new Set(a.results.items.map((i) => i.assetType))).toEqual(new Set(["agents_md", "skill"]));
    expect(a.results.leftOut!.map((l) => `${l.reason} ${l.assetType}`).sort()).toEqual(["duplicate skill", "type-not-selected custom_agent", "type-not-selected memory", "type-not-selected memory_store"]);
    expect(importPlanNotes(policy, a.results)).toEqual([
      "Left out of this import by choice: 1 memory store, 1 memory and 1 custom agent from the package.",
      "skill/verity.v1 is left out: skill/verity has the same name, verity, and has status ACTIVE. Assets that share a name are all imported only into a space that holds each of their asset IDs.",
    ]);
  });

  it("counts a type left out by choice the way its checkbox did, from the stored mapping of every type", () => {
    const all = analyze();
    const some = analyze(["agents_md", "memory_store", "memory", "custom_agent"]);
    const skills = all.results.items.filter((i) => i.assetType === "skill");
    const changes = skills.filter((i) => i.action !== "unchanged").length;
    const unchanged = skills.length - changes;
    const notes = importPlanNotes(policy, some.results, all.results);
    // The duplicate that every mapping leaves out is counted as left out, not as one more skill left out by choice.
    expect(notes[0]).toBe(`Left out of this import by choice: skills (${[`${changes} ${changes === 1 ? "change" : "changes"}`, unchanged ? `${unchanged} unchanged` : null, "1 left out"].filter(Boolean).join(", ")}) from the package.`);
    expect(importPlanNotes(policy, some.results)[0]).toBe(`Left out of this import by choice: ${skills.length + 1} skills from the package.`);
  });
});

describe("plan and layout forms", () => {
  const ID = "6f1b2a8e-1c2d-4e3f-8a9b-0c1d2e3f4a5b";
  it("reads the selected asset types when the form offers the choice", () => {
    const form = new FormData();
    form.set("importId", ID);
    form.set("typeSelection", "1");
    form.append("types", "agents_md");
    form.append("types", "skill");
    expect(createPlanRequestFromForm(form).options.includeTypes).toEqual(["agents_md", "skill"]);
    const none = new FormData();
    none.set("importId", ID);
    none.set("typeSelection", "1");
    expect(() => createPlanRequestFromForm(none)).toThrow("Choose at least one asset type to import.");
    const old = new FormData();
    old.set("importId", ID);
    expect(createPlanRequestFromForm(old).options).not.toHaveProperty("includeTypes");
    const bad = new FormData();
    bad.set("importId", ID);
    bad.set("typeSelection", "1");
    bad.append("types", "../skill");
    expect(() => createPlanRequestFromForm(bad)).toThrow(/not valid/);
  });

  it("reads a layout override", () => {
    const form = new FormData();
    form.set("importId", ID);
    form.set("layout", " instruction-folders-shared ");
    expect(layoutRequestFromForm(form)).toEqual({ importId: ID, layout: "instruction-folders-shared" });
    expect(() => layoutRequestFromForm(new FormData())).toThrow("Choose a layout from the list.");
  });
});

describe("import detail for Agent Space folders", () => {
  function row(results: unknown, summary: unknown): PackageImportRow {
    const t = new Date("2026-11-13T00:00:00Z");
    return {
      id: "6f1b2a8e-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
      spaceId: "00000000-0000-4000-8000-000000000000",
      fileName: "space.zip",
      source: "zip",
      sha256: "0".repeat(64),
      sizeBytes: 100,
      layout: "agent-space-folders",
      packageName: "space-folders",
      status: "analyzed",
      mappingSummary: summary,
      results,
      planId: null,
      importedBy: "editor@example.com",
      plannedBy: null,
      storedPath: "x.zip",
      createdAt: t,
      analyzedAt: t,
      plannedAt: null,
      expiresAt: t,
      fileDeletedAt: null,
    } as PackageImportRow;
  }

  it("offers each mapped type with its changes and errors, and keeps the layout fit", () => {
    // Without the store in the space, the custom agent's reference is an error; only custom agents carry it.
    const a = analyzeImport({ contents: agentSpacePackage(), layout, policy, live: space.filter((e) => e.assetId !== I.liveStore), historyCommit: null, now });
    const results = { ...a.results, layouts: [{ layout: "agent-space-folders", label: layout.label, assets: 8, assetFiles: 12, unmappedFiles: 0 }], layoutChoice: "detected" as const };
    const d = buildImportDetail(row(results, a.summary), policy);
    expect(d.planTypes.types.map((t) => [t.assetType, t.assets, t.changes, t.failedAssets])).toEqual([
      ["agents_md", 2, 2, 0],
      ["skill", 2, 2, 0],
      ["memory_store", 1, 1, 0],
      ["memory", 1, 1, 0],
      ["custom_agent", 1, 1, 1],
    ]);
    expect(d.planTypes).toMatchObject({ unattributedErrors: 0, blockOnErrors: true, stateReason: null });
    // The type checkbox counts what the plan notes count: changes, unchanged, and duplicates left out anyway.
    expect(d.planTypes.types.find((t) => t.assetType === "skill")).toMatchObject({ unchanged: 0, leftOut: 1 });
    expect(d.planTypes.types.find((t) => t.assetType === "custom_agent")).toMatchObject({ errors: 1, failedAssets: 1, leftOut: 0 });
    // The whole package is blocked, a selection without custom agents is not (the client decides with selectionBlocker).
    expect(d.plan.canCreate).toBe(false);
    expect(d.layouts).toEqual({ candidates: results.layouts, choice: "detected", canChange: true });
    expect(d.layout!.typeDirs).toMatchObject({ agents_md: "agents_md", skill: "skill", custom_agent: "custom_agent", memory: "memory" });
    expect(d.leftOut).toHaveLength(1);
  });

  it("attributes a result to types by asset, by file and by folder", () => {
    const files = [{ path: "skill/verity/SKILL.md", assetKey: "skill:verity" }];
    const dirs = { skill: "skill", memory_store: "memory", memory: "memory" };
    expect(resultTypes({ level: "error", code: "x", message: "", assetKey: "custom_agent:reviewer" }, files, dirs)).toEqual(["custom_agent"]);
    expect(resultTypes({ level: "error", code: "x", message: "", path: "skill/verity/SKILL.md" }, files, dirs)).toEqual(["skill"]);
    expect(resultTypes({ level: "error", code: "x", message: "", path: "memory/notes/INDEX.md" }, files, dirs)).toEqual(["memory_store", "memory"]);
    expect(resultTypes({ level: "error", code: "x", message: "" }, files, dirs)).toEqual([]);
  });
});
