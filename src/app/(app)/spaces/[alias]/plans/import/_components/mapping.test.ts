import { describe, expect, it } from "vitest";
import type { ImportDetail, ImportItem, ImportItemGroup } from "@/server/package-io";
import type { PlanTypeOption } from "@/server/package-io/loaders";
import { getAppPolicy } from "@/server/policy";
import { typeErrorsText, typePlanCountsText, validationFailedText } from "@/server/package-io/format";
import { breakdown, nonAssetSummary, plainResult, relativeTo, resultAssetName, selectionBlocker, typeFileCount, typeForPath, typeResults, typeRows, withAssetKey } from "./mapping";

const typeDirs = { agents_md: "instructions", skill: "skills", memory_store: "memory", memory: "memory" };

function item(over: Partial<ImportItem> & Pick<ImportItem, "assetType" | "key" | "action">): ImportItem {
  return {
    assetKey: `${over.assetType}:${over.key}`,
    assetId: null,
    liveVersion: null,
    source: null,
    metadata: {},
    files: [],
    contentHash: "",
    metadataHash: "",
    changes: null,
    errors: 0,
    warnings: 0,
    ...over,
  };
}

const generic = item({
  assetType: "agents_md",
  key: "GENERIC",
  action: "update",
  assetId: "ai-1",
  liveVersion: 5,
  source: "instructions/global.md",
  files: [{ path: "AGENTS.md", size: 18432, sha256: "x", sourcePath: "instructions/global.md", lines: 105 }],
  changes: { content: true, metadataKeys: [], committed: true },
  diffStat: { added: 81, removed: 70 },
});
const chat = item({ assetType: "agents_md", key: "CHAT", action: "create", source: "instructions/chat.md", files: [{ path: "AGENTS.md", size: 7577, sha256: "y", sourcePath: "instructions/chat.md", lines: 120 }] });
const skill = item({
  assetType: "skill",
  key: "rds-failover",
  action: "unchanged",
  source: "skills/rds-failover",
  files: [
    { path: "SKILL.md", size: 100, sha256: "a", sourcePath: "skills/rds-failover/SKILL.md" },
    { path: "references/a.md", size: 50, sha256: "b", sourcePath: "skills/rds-failover/references/a.md" },
  ],
});

const group = (assetType: string, items: ImportItem[]): ImportItemGroup => ({
  assetType,
  label: assetType,
  counts: { create: items.filter((i) => i.action === "create").length, update: items.filter((i) => i.action === "update").length, unchanged: items.filter((i) => i.action === "unchanged").length },
  items,
});

const detail: Pick<ImportDetail, "validation" | "layout" | "files"> = {
  layout: { name: "instruction-folders-shared", label: "Instruction folders with a shared section", typeDirs, nonAssets: ["README.md", "evaluation/**"], manifest: null },
  files: [
    {
      role: "asset",
      files: [
        { path: "instructions/global.md", role: "asset", assetKey: "agents_md:GENERIC", size: 18432, build: null },
        { path: "instructions/chat.md", role: "asset", assetKey: "agents_md:CHAT", size: 7577, build: null },
      ],
    },
    { role: "skipped", files: [{ path: "instructions/learning.md", role: "skipped", assetKey: null, size: 900, build: null }] },
  ],
  validation: {
    errors: [],
    warnings: [
      { level: "warning", code: "package.no-agent-type", message: "instructions/learning.md has no documented agent_type value.", path: "instructions/learning.md" },
      { level: "warning", code: "file.long", message: "AGENTS.md has 193 lines; about 120 lines is recommended.", assetKey: "agents_md:CHAT", path: "AGENTS.md" },
      { level: "warning", code: "metadata.recommendation", message: "kebab-case", assetKey: "memory:verity/x" },
    ],
  },
};

describe("mapping result rows", () => {
  it("relates paths to the type folders", () => {
    expect(relativeTo("instructions", "instructions/global.md")).toBe("global.md");
    expect(relativeTo("instructions", "README.md")).toBe("README.md");
    expect(typeForPath(typeDirs, "memory/verity/STORE.md")).toBe("memory_store");
    expect(typeForPath(typeDirs, "tools/x.py")).toBeNull();
  });

  it("builds one row per asset, then the files that aren't imported", () => {
    const rows = typeRows(detail, group("agents_md", [generic, chat]));
    expect(rows.map((r) => [r.file, r.asset, r.change.word])).toEqual([
      ["global.md", "GENERIC", "update"],
      ["chat.md", "CHAT", "create"],
      ["learning.md", null, "not-imported"],
    ]);
    expect(rows[0]!.change).toMatchObject({ from: 5, added: 81, removed: 70 });
    expect(rows[0]).toMatchObject({ size: 18432, lines: 105 });
    expect(rows[1]!.results.map((r) => r.code)).toEqual(["file.long"]);
    expect(rows[2]!.results.map((r) => r.code)).toEqual(["package.no-agent-type"]);
    expect(typeFileCount(detail, group("agents_md", [generic, chat]))).toBe(3);
  });

  it("shows a skill folder with a trailing slash and no line count", () => {
    const [row] = typeRows(detail, group("skill", [skill]));
    expect(row).toMatchObject({ file: "rds-failover/", size: 150, lines: null, change: { word: "unchanged" } });
  });

  it("collects a type's results by asset key and by folder", () => {
    expect(typeResults(detail, "agents_md").map((r) => r.code)).toEqual(["package.no-agent-type", "file.long"]);
    expect(typeResults(detail, "memory").map((r) => r.code)).toEqual(["metadata.recommendation"]);
    expect(typeResults(detail, "skill")).toEqual([]);
  });

  it("names non-asset files by the layout's patterns", () => {
    expect(nonAssetSummary(["README.md", "evaluation/a/b.md", "evaluation/c.md", "instructions/shared/x.md", "tools/y.py"], ["README.md", "evaluation/**"])).toEqual([
      "README.md",
      "evaluation/",
      "instructions/shared/",
      "tools/",
    ]);
  });

  it("writes breakdowns and prefixes messages with the asset key", () => {
    const noun = (t: string, n: number) => (t === "skill" ? (n === 1 ? "skill" : "skills") : n === 1 ? "memory" : "memories");
    expect(breakdown([{ assetType: "skill", count: 16 }, { assetType: "memory", count: 0 }, { assetType: "memory", count: 1 }], noun)).toBe("16 skills, 1 memory");
    expect(withAssetKey({ level: "warning", code: "file.long", message: "AGENTS.md has 193 lines.", assetKey: "agents_md:INCIDENT_RCA" }).message).toBe("INCIDENT_RCA: AGENTS.md has 193 lines.");
    expect(withAssetKey({ level: "warning", code: "x", message: "m" }).message).toBe("m");
  });

  it("adds a row for a package asset left out of the plan, with the reason", () => {
    const leftOut = [
      {
        assetKey: "skill:rds-failover@ki-2",
        assetType: "skill",
        key: "rds-failover@ki-2",
        source: "skills/rds-failover.v1",
        sourceAssetId: "ki-2",
        reason: "duplicate" as const,
        message: "skills/rds-failover.v1 is left out: skills/rds-failover has the same name.",
        keptKey: "rds-failover",
      },
    ];
    const rows = typeRows({ ...detail, leftOut }, group("skill", [skill]));
    expect(rows[1]).toMatchObject({ file: "rds-failover.v1/", asset: "rds-failover@ki-2", assetId: null, change: { word: "left-out", reason: leftOut[0]!.message } });
  });
});

describe("selectionBlocker", () => {
  const opt = (assetType: string, changes: number, errors = 0): PlanTypeOption => ({ assetType, label: assetType === "memory" ? "Memories" : "Skills", nounOne: assetType, nounOther: `${assetType}s`, assets: changes, changes, failedAssets: errors, errors });
  const types = [opt("skill", 3), opt("memory", 2, 1)];
  const base = { types, unattributedErrors: 0, blockOnErrors: true };

  it("blocks a selection with a failing type and allows one without it", () => {
    expect(selectionBlocker({ ...base, selected: ["skill", "memory"] })).toBe("Validation failed for memories. Leave that type out, or fix the package and upload it again.");
    expect(selectionBlocker({ ...base, selected: ["skill"] })).toBeNull();
  });

  it("needs a type, changes, and no errors about the whole package", () => {
    expect(selectionBlocker({ ...base, selected: [] })).toBe("Choose at least one asset type.");
    expect(selectionBlocker({ ...base, types: [opt("skill", 0)], selected: ["skill"] })).toBe("Nothing to import: every selected asset matches live.");
    expect(selectionBlocker({ ...base, unattributedErrors: 2, selected: ["skill"] })).toMatch(/^The package has 2 validation errors that no asset type explains/);
    expect(selectionBlocker({ ...base, blockOnErrors: false, selected: ["skill", "memory"] })).toBeNull();
  });
});

describe("import messages in plain words", () => {
  const policy = getAppPolicy().policy;
  const id = "ki-85182353-a9e4-4711-afab-014bb8d9273f";

  it("says a reference to an asset that isn't anywhere in words, with the ID and the code in Details", () => {
    const r = plainResult(policy, {
      level: "error",
      code: "reference.not-in-package",
      message: `memory_stores names memory store ${id}, which is not in this package or in this space, so the reference can't be kept here.`,
      assetKey: "custom_agent:pr-change-analyzer",
      path: "metadata.memory_stores",
    });
    expect(r.text).toBe("pr-change-analyzer uses a memory store that isn't in this package or this space.");
    expect(r.text).not.toMatch(/ki-|reference\.|metadata\./);
    expect(r.details).toContain(id);
    expect(r.details).toContain("reference.not-in-package · metadata.memory_stores");
  });

  it("names instruction files by their agent type's label and keeps asset IDs out of the sentence", () => {
    expect(plainResult(policy, { level: "warning", code: "file.long", message: "AGENTS.md has 325 lines; about 120 lines is recommended.", assetKey: "agents_md:CHAT" }).text).toBe(
      "Chat instructions: AGENTS.md has 325 lines; about 120 lines is recommended.",
    );
    expect(plainResult(policy, { level: "warning", code: "file.long", message: "PREVENTION: AGENTS.md has 158 lines.", assetKey: "agents_md:PREVENTION" }).text).toBe("Prevention instructions: AGENTS.md has 158 lines.");
    const dup = plainResult(policy, { level: "warning", code: "import.duplicate-left-out", message: `skill/x.v2 is left out: it is the same as ${id}.`, assetKey: `skill:x@${id}` });
    expect(dup.text).toBe("x: skill/x.v2 is left out: it is the same as an asset ID (see Details).");
    expect(resultAssetName(policy, `skill:low-sample-size-check@${id}`)).toBe("low-sample-size-check");
  });
});

describe("import counts, one definition per number", () => {
  it("says assets with errors and errors the same way in the banner, the table and the checkboxes", () => {
    expect(validationFailedText(14, 22)).toBe("14 assets have validation errors (22 errors in all)");
    expect(validationFailedText(1, 1)).toBe("1 asset has validation errors (1 error in all)");
    expect(validationFailedText(0, 3)).toBe("The package has 3 errors");
    expect(typeErrorsText({ failedAssets: 12, errors: 20, nounOne: "custom agent", nounOther: "custom agents" })).toBe("12 custom agents with errors (20 errors)");
    expect(typeErrorsText({ failedAssets: 0, errors: 2, nounOne: "skill", nounOther: "skills" })).toBe("2 errors");
  });

  it("counts a type's changes, unchanged and left-out assets in the words the plan notes use", () => {
    expect(typePlanCountsText({ changes: 48, unchanged: 0, leftOut: 5 })).toBe("48 changes, 5 left out");
    expect(typePlanCountsText({ changes: 2, unchanged: 20, leftOut: 0 })).toBe("2 changes, 20 unchanged");
    expect(typePlanCountsText({ changes: 1, unchanged: 0, leftOut: 0 })).toBe("1 change");
  });
});
