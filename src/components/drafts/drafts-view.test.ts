import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import type { DesiredFile } from "@/server/packages/types";
import { resolvedSchema } from "@/server/validation/schemas";
import { changedFiles, countLines, createPlanButton, diffAgainst, diffPill, editorButtons, isDirty, measureText } from "./editor-state";
import { checkMetadata, mergeValidation } from "./metadata-check";
import { fieldOfPath, formFromSchema, parseList, sentenceCase, setReference } from "./schema-form";
import { canSelect, createBlocker, hasCheckbox, headerState, pruneSelection, toggleAll, toggleOne } from "./selection";

const policy = getAppPolicy().policy;
const agentTypes = policy.agentTypes.agentTypes.map((a) => ({ id: a.id, label: a.label }));
const file = (path: string, content: string): DesiredFile => ({ path, encoding: "utf8", content });

describe("Details form from the JSON Schema", () => {
  const form = (assetType: string, metadata: Record<string, unknown>, opts: { allow?: { metadata: boolean; status: boolean }; readOnlyKeys?: string[] } = {}) =>
    formFromSchema({
      schema: resolvedSchema(policy, assetType),
      supportsStatus: policy.assetTypes.assetTypes[assetType]!.supportsStatus,
      references: (policy.assetTypes.assetTypes[assetType]!.references ?? []).map((r) => ({ ...r, options: [{ assetId: "ki-store", name: "verity" }] })),
      agentTypes,
      readOnlyKeys: opts.readOnlyKeys ?? ["skill_type"],
      descriptionMax: policy.limits.descriptionMaxChars,
      allow: opts.allow ?? { metadata: true, status: true },
      metadata,
    });

  it("gives a skill name, description, agent types, status and enable tools, with skill type read only", () => {
    const f = form("skill", { name: "verity", description: "d", agent_types: ["GENERIC"], skill_type: "USER", status: "ACTIVE" });
    expect(f.fields.map((x) => [x.key, x.kind])).toEqual([
      ["name", "text"],
      ["description", "description"],
      ["agent_types", "agent-types"],
      ["status", "status"],
      ["enable_tools", "list"],
    ]);
    expect(f.fields.find((x) => x.key === "name")?.hint).toMatch(/lowercase letters/);
    expect(f.facts).toEqual([{ key: "skill_type", label: "Skill type", value: "USER" }]);
    const at = f.fields.find((x) => x.kind === "agent-types");
    expect(at && "options" in at ? at.options.map((o) => o.id) : []).toEqual(policy.agentTypes.agentTypes.map((a) => a.id));
  });

  it("gives a memory a store picker by name", () => {
    const f = form("memory", { name: "x", description: "d", memory_store_id: "ki-store" });
    expect(f.fields.find((x) => x.key === "memory_store_id")).toMatchObject({ kind: "reference", label: "Memory store" });
  });

  it("keeps a managed memory to the status switch, with the rest read only", () => {
    const f = form("memory", { name: "overview", description: "d", memory_store_id: "ki-store", status: "ACTIVE" }, { allow: { metadata: false, status: true } });
    expect(f.fields.map((x) => x.kind)).toEqual(["status"]);
    expect(f.facts.map((x) => [x.label, x.value])).toEqual([
      ["Name", "overview"],
      ["Description", "d"],
      ["Memory store", "verity"],
    ]);
  });

  it("shows only the read-only agent type for instructions", () => {
    const f = form("agents_md", { agent_type: "GENERIC", status: "ACTIVE" }, { readOnlyKeys: ["agent_type"] });
    expect(f.fields).toEqual([]);
    expect(f.facts).toEqual([{ key: "agent_type", label: "Agent type", value: "Global (all agents)" }]);
  });

  it("labels keys in sentence case and parses comma lists", () => {
    expect(sentenceCase("enable_tools")).toBe("Enable tools");
    expect(sentenceCase("memoryStores")).toBe("Memory stores");
    expect(sentenceCase("memory_store_id")).toBe("Memory store");
    expect(parseList(" a, b ,, a ")).toEqual(["a", "b"]);
    expect(fieldOfPath("metadata.agent_types[1]")).toBe("agent_types");
    expect(fieldOfPath("metadata")).toBeNull();
  });

  it("writes picked asset IDs and their names", () => {
    const rule = { key: "memory_store_id", ref: "memoryStore", many: false, options: [{ assetId: "ki-1", name: "verity" }] };
    expect(setReference({ name: "x" }, {}, rule, ["ki-1"])).toEqual({ metadata: { name: "x", memory_store_id: "ki-1" }, refs: { memoryStore: "verity" } });
    const many = { key: "skills", ref: "skills", many: true, options: [{ assetId: "a", name: "A" }, { assetId: "b", name: "B" }] };
    expect(setReference({}, {}, many, ["b", "a"])).toEqual({ metadata: { skills: ["b", "a"] }, refs: { skills: ["B", "A"] } });
  });
});

describe("in-browser metadata check", () => {
  const schemas = { error: resolvedSchema(policy, "skill"), warning: resolvedSchema(policy, "skill", "metadataWarningSchema") };

  it("reports the x-hint the server reports", () => {
    const r = checkMetadata(schemas, { name: "verity", description: "d", agent_types: ["GENERIC", "INCIDENT_RCA"] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ level: "error", code: "metadata.schema", path: "metadata.agent_types" });
    expect(r[0]!.message).toContain("GENERIC (all agents) can't be combined");
    expect(checkMetadata(schemas, { name: "verity", description: "d", agent_types: ["GENERIC"] })).toEqual([]);
  });

  it("replaces the saved metadata results and keeps the file results", () => {
    const saved = [
      { level: "error" as const, code: "metadata.schema", message: "old" },
      { level: "warning" as const, code: "frontmatter.mirror", message: "file" },
    ];
    expect(mergeValidation(saved, []).map((r) => r.message)).toEqual(["file"]);
  });
});

describe("editor state", () => {
  it("finds the files a save sends and whether the form is dirty", () => {
    const base = { metadata: { status: "ACTIVE" }, files: [file("SKILL.md", "a"), file("r.md", "r")] };
    expect(changedFiles(base.files, [file("SKILL.md", "b"), file("r.md", "r")]).map((f) => f.path)).toEqual(["SKILL.md"]);
    expect(isDirty(base, { ...base })).toBe(false);
    expect(isDirty(base, { ...base, metadata: { status: "INACTIVE" } })).toBe(true);
    expect(isDirty(base, { metadata: { status: "ACTIVE", extra: undefined }, files: base.files })).toBe(false);
  });

  it("measures text like the server size meter", () => {
    expect(countLines("a\nb\n")).toBe(2);
    const m = measureText("é\n".repeat(130), { agentsMdMaxBytes: 100, agentsMdRecommendedLines: 120 });
    expect(m).toMatchObject({ bytes: 390, lines: 130, overLimit: true, overRecommendedLines: true, level: "error" });
  });

  it("diffs the editor text against live and labels the tab pill", () => {
    const diffs = diffAgainst([{ path: "A.md", encoding: "utf8", content: "a\nb\n" }, { path: "B.md", encoding: "utf8", content: "x\n" }], [file("A.md", "a\nc\nd\n"), file("B.md", "x\n")]);
    expect(diffs.map((d) => [d.path, d.status, d.added, d.removed])).toEqual([
      ["A.md", "modified", 2, 1],
      ["B.md", "unchanged", 0, 0],
    ]);
    expect(diffPill(diffs, [])).toBe("+2 −1");
    expect(diffPill([], [{ key: "status", kind: "changed", before: "ACTIVE", after: "INACTIVE" }])).toBe("status");
    expect(diffPill([], [])).toBeNull();
  });

  it("follows the buttons-by-role table", () => {
    const s = { readOnly: false, exists: true, planTitle: null, assetDeleted: false, lockedReason: null, dirty: false, saving: false };
    expect(editorButtons({ ...s, readOnly: true })).toEqual({ save: null, discard: false, cancel: false });
    expect(editorButtons({ ...s, exists: false })).toEqual({ save: { enabled: true, reason: null }, discard: false, cancel: true });
    expect(editorButtons({ ...s, planTitle: "P", dirty: true }).save).toEqual({ enabled: false, reason: "This draft is in plan P." });
    expect(editorButtons({ ...s, assetDeleted: true })).toEqual({ save: { enabled: false, reason: "The asset was deleted from the space." }, discard: true, cancel: false });
    expect(editorButtons(s)).toEqual({ save: { enabled: false, reason: "No unsaved changes" }, discard: true, cancel: false });
    expect(editorButtons({ ...s, dirty: true })).toEqual({ save: { enabled: true, reason: null }, discard: true, cancel: false });
  });

  it("offers Create plan from this draft once the draft is saved", () => {
    const s = { canCreate: true, readOnly: false, exists: true, planTitle: null, assetDeleted: false, lockedReason: null, dirty: false, errors: 0 };
    expect(createPlanButton(s)).toEqual({ enabled: true, reason: null });
    expect(createPlanButton({ ...s, dirty: true })).toEqual({ enabled: false, reason: "Save the draft first." });
    expect(createPlanButton({ ...s, errors: 1 })).toEqual({ enabled: false, reason: "Fix the validation errors first." });
    expect(createPlanButton({ ...s, exists: false })).toBeNull();
    expect(createPlanButton({ ...s, canCreate: false })).toBeNull();
    expect(createPlanButton({ ...s, planTitle: "P" })).toBeNull();
  });
});

describe("drafts selection", () => {
  const row = (id: string, o: Partial<{ mine: boolean; plan: { id: string } | null; assetDeleted: boolean; errors: number }> = {}) => ({
    id,
    name: id,
    mine: o.mine ?? true,
    plan: o.plan ?? null,
    assetDeleted: o.assetDeleted ?? false,
    validation: { errors: o.errors ?? 0 },
  });
  const rows = [row("a"), row("b", { errors: 1 }), row("c", { plan: { id: "P" } }), row("d", { mine: false }), row("e", { assetDeleted: true })];

  it("offers checkboxes only on my drafts that aren't in a plan", () => {
    expect(rows.filter(hasCheckbox).map((r) => r.id)).toEqual(["a", "b", "e"]);
    expect(rows.filter(canSelect).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("drives the header checkbox", () => {
    expect(headerState(new Set(), rows)).toBe(false);
    expect(headerState(new Set(["a"]), rows)).toBe("indeterminate");
    expect(headerState(new Set(["a", "b"]), rows)).toBe(true);
    expect([...toggleAll(new Set(["a"]), rows)]).toEqual(["a", "b"]);
    expect([...toggleAll(new Set(["a", "b"]), rows)]).toEqual([]);
    expect([...toggleOne(new Set(["a"]), "b", true)]).toEqual(["a", "b"]);
    expect([...pruneSelection(new Set(["a", "c", "zz"]), rows)]).toEqual(["a"]);
  });

  it("explains why Create plan is disabled, first match", () => {
    expect(createBlocker([rows[0]!, rows[1]!], "")).toBe("Fix the errors in b first.");
    expect(createBlocker([rows[0]!], "  ")).toBe("Enter a plan title.");
    expect(createBlocker([rows[0]!], "Title")).toBeNull();
  });
});
