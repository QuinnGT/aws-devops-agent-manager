import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { writeModesFor } from "@/server/policy/sections/plans";
import { clientTokenFor, parseClientToken } from "./client-token";
import { applyMetadataPatch, metadataPatch, removalValue } from "./content";
import { applyOrder } from "./resolve";
import { describeStepsPlain, planWriteSteps } from "./write-plan";

const f = (path: string, sha256 = path) => ({ path, sha256, size: 1 });
const auto = { create: "auto", content: "auto" } as const;

describe("describeStepsPlain", () => {
  it("says what apply will do in plain words, and nothing for no write", () => {
    expect(describeStepsPlain([])).toBeNull();
    expect(describeStepsPlain([{ op: "UpdateAsset", content: "file", path: "AGENTS.md" }])).toBe("Apply will replace AGENTS.md.");
    expect(describeStepsPlain([{ op: "UpdateAssetFile", path: "a.md" }, { op: "CreateAssetFile", path: "b.md" }, { op: "UpdateAsset", content: null }])).toBe("Apply will change a.md, add b.md, update its details and status.");
    expect(describeStepsPlain([{ op: "CreateAsset", content: "zip" }])).toBe("Apply will create the asset.");
  });
});

describe("planWriteSteps", () => {
  it("creates one file inline and several as a zip", () => {
    expect(planWriteSteps({ kind: "create", multiFile: false, modes: auto, live: [], desired: [f("AGENTS.md")], metadataChanged: true })).toEqual({ ok: true, steps: [{ op: "CreateAsset", content: "file" }] });
    expect(planWriteSteps({ kind: "create", multiFile: true, modes: auto, live: [], desired: [f("SKILL.md"), f("references/a.md")], metadataChanged: true })).toEqual({ ok: true, steps: [{ op: "CreateAsset", content: "zip" }] });
    expect(planWriteSteps({ kind: "create", multiFile: true, modes: { create: "file", content: "auto" }, live: [], desired: [f("a"), f("b")], metadataChanged: false }).ok).toBe(false);
  });

  it("updates one changed file with UpdateAsset and the metadata patch in the same call", () => {
    const r = planWriteSteps({ kind: "update", multiFile: true, modes: auto, live: [f("SKILL.md", "1"), f("r.md")], desired: [f("SKILL.md", "2"), f("r.md")], metadataChanged: true });
    expect(r).toEqual({ ok: true, steps: [{ op: "UpdateAsset", content: "file", path: "SKILL.md" }] });
  });

  it("uses a zip for several changes to a multi-file asset, per-file calls otherwise", () => {
    const live = [f("SKILL.md", "1"), f("a.md"), f("b.md")];
    const desired = [f("SKILL.md", "2"), f("a.md", "x"), f("c.md")];
    expect(planWriteSteps({ kind: "update", multiFile: true, modes: auto, live, desired, metadataChanged: false })).toEqual({ ok: true, steps: [{ op: "UpdateAsset", content: "zip" }] });
    expect(planWriteSteps({ kind: "update", multiFile: false, modes: auto, live, desired, metadataChanged: true })).toEqual({
      ok: true,
      steps: [
        { op: "UpdateAssetFile", path: "SKILL.md" },
        { op: "UpdateAssetFile", path: "a.md" },
        { op: "CreateAssetFile", path: "c.md" },
        { op: "DeleteAssetFile", path: "b.md" },
        { op: "UpdateAsset", content: null },
      ],
    });
    expect(planWriteSteps({ kind: "update", multiFile: true, modes: { create: "auto", content: "file" }, live, desired, metadataChanged: false }).ok).toBe(false);
  });

  it("sends metadata alone for a status switch and nothing when nothing changed", () => {
    expect(planWriteSteps({ kind: "update", multiFile: false, modes: auto, live: [f("m.md")], desired: [f("m.md")], metadataChanged: true })).toEqual({ ok: true, steps: [{ op: "UpdateAsset", content: null }] });
    expect(planWriteSteps({ kind: "update", multiFile: false, modes: auto, live: [f("m.md")], desired: [f("m.md")], metadataChanged: false })).toEqual({ ok: true, steps: [] });
    expect(planWriteSteps({ kind: "delete", multiFile: false, modes: auto, live: [], desired: [], metadataChanged: false })).toEqual({ ok: true, steps: [{ op: "DeleteAsset" }] });
  });

  it("reads the per-type modes from plans.yaml", () => {
    const p = getAppPolicy().policy.plans;
    expect(writeModesFor(p, "agents_md")).toEqual({ create: "file", content: "auto" });
    expect(writeModesFor(p, "skill")).toEqual({ create: "auto", content: "auto" });
    expect(writeModesFor(p, "something_new")).toEqual(p.write.default);
  });
});

describe("clientToken", () => {
  const id = "0b3c6a8e-1d2f-4a5b-9c8d-7e6f5a4b3c2d";
  it("is the plan item ID for the first call and adds the step index for later ones", () => {
    expect(clientTokenFor(id, 0)).toBe(id);
    expect(clientTokenFor(id, 2)).toBe(`${id}-2`);
    expect(clientTokenFor(id, 2).length).toBeLessThanOrEqual(128);
    expect(clientTokenFor(id, 3)).toMatch(/^[0-9a-f-]+$/);
    expect(parseClientToken(`${id}-2`)).toEqual({ planItemId: id, index: 2 });
    expect(parseClientToken(id.toUpperCase())).toEqual({ planItemId: id, index: 0 });
    expect(parseClientToken("7c1761ca-b256-4f44")).toBeNull();
    expect(() => clientTokenFor("not-a-uuid", 0)).toThrow();
  });
});

describe("metadata PATCH", () => {
  it("sends only changed keys and null for removed ones; the result drops nulls", () => {
    const live = { name: "x", status: "ACTIVE", agent_types: ["GENERIC"], added_later: 1 };
    const patch = metadataPatch(live, { name: "x", status: "INACTIVE", agent_types: ["GENERIC"] }, ["added_later", "never_there"]);
    expect(patch).toEqual({ status: "INACTIVE", added_later: null });
    expect(applyMetadataPatch(live, patch)).toEqual({ name: "x", status: "INACTIVE", agent_types: ["GENERIC"] });
  });

  it("removes an array key with [] and any other key with null", () => {
    const live = { name: "s", enable_tools: ["a"], note: "n" };
    const patch = metadataPatch(live, { name: "s" }, ["enable_tools", "note"]);
    // The API rejects null for enable_tools ("must be an array of strings") and drops a key sent as [].
    expect(patch).toEqual({ enable_tools: [], note: null });
    expect(applyMetadataPatch(live, patch)).toEqual({ name: "s" });
    expect(removalValue(["x"])).toEqual([]);
    expect(removalValue("x")).toBeNull();
  });
});

describe("applyOrder", () => {
  it("puts referenced types first and deletes last, memories before their stores", () => {
    const order = getAppPolicy().policy.plans.applyOrder;
    const items = [
      { kind: "upsert" as const, assetType: "custom_agent", position: 0 },
      { kind: "upsert" as const, assetType: "memory", position: 1 },
      { kind: "delete" as const, assetType: "memory_store", position: 2 },
      { kind: "upsert" as const, assetType: "memory_store", position: 3 },
      { kind: "delete" as const, assetType: "memory", position: 4 },
      { kind: "upsert" as const, assetType: "skill", position: 5 },
    ];
    expect(applyOrder(items, order).map((i) => `${i.kind}:${i.assetType}`)).toEqual([
      "upsert:memory_store",
      "upsert:skill",
      "upsert:memory",
      "upsert:custom_agent",
      "delete:memory",
      "delete:memory_store",
    ]);
  });
});
