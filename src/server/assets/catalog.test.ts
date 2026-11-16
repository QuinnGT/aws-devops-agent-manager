import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { apiFixture } from "../../../test/helpers/fixtures";
import { collectAssetReferences, groupReferences, instructionSlots, managedLabel, resolveAssetTypeTabs, skillFields } from "./catalog";

const policy = getAppPolicy().policy;
type ListAssets = { items: { assetId: string; assetType: string; metadata: Record<string, unknown> }[] };
const assets = apiFixture<ListAssets>("ListAssets.page1").response.items;
const liveTypes = apiFixture<{ items: { assetType: string; description: string }[] }>("ListAssetTypes").response.items;

describe("resolveAssetTypeTabs", () => {
  // ListAssets.summary is a plain summary file, not a { request, response } capture
  const counts = (apiFixture("ListAssets.summary") as unknown as { counts: Record<string, number> }).counts;

  it("uses ListAssetTypes in policy order with labels and counts", () => {
    const { tabs, source } = resolveAssetTypeTabs(liveTypes, policy.assetTypes.assetTypes, counts);
    expect(source).toBe("live");
    expect(tabs.map((t) => t.assetType)).toEqual(["agents_md", "skill", "memory_store", "memory", "custom_agent", "attachment", "test_profile", "feedback", "artifact"]);
    expect(tabs[0]).toMatchObject({ label: "Instructions (AGENTS.md)", count: 1, description: "Agent configuration in AGENTS.md format", inPolicy: true });
    expect(tabs.find((t) => t.assetType === "custom_agent")?.count).toBe(0);
  });

  it("falls back to policy, and keeps indexed or new types visible", () => {
    const fallback = resolveAssetTypeTabs(null, policy.assetTypes.assetTypes, { ...counts, mystery: 2 });
    expect(fallback.source).toBe("policy");
    expect(fallback.tabs.at(-1)).toMatchObject({ assetType: "mystery", label: "mystery", inPolicy: false, count: 2 });
    const withNew = resolveAssetTypeTabs([...liveTypes, { assetType: "brand_new" }], policy.assetTypes.assetTypes, counts);
    expect(withNew.tabs.at(-1)?.assetType).toBe("brand_new");
  });
});

describe("managedLabel", () => {
  const stores = new Map(assets.filter((a) => a.assetType === "memory_store").map((a) => [a.assetId, { name: String(a.metadata.name), assetType: a.assetType }]));

  it("labels managed stores and the memories in them from policy managedNames", () => {
    const types = policy.assetTypes.assetTypes;
    const store = { assetId: "ki-63edd778-1a7a-483f-8b18-479742a15a04", assetType: "memory_store", name: "chat-tool-use-best-practices", parentAssetId: null };
    expect(managedLabel(types, store, stores)).toEqual({ managed: true, via: "self" });
    const memory = { assetId: "ki-9184fa09-8e79-4a11-90fa-a6b81ab5fe6b", assetType: "memory", name: "overview", parentAssetId: store.assetId };
    expect(managedLabel(types, memory, stores)).toEqual({ managed: true, via: "store", storeName: "chat-tool-use-best-practices" });
    const userStore = { assetId: "ki-f7aad8aa-0449-4221-bd9d-bceee6f33d24", assetType: "memory_store", name: "verity", parentAssetId: null };
    expect(managedLabel(types, userStore, stores)).toEqual({ managed: false });
    const verityMemory = { assetId: "ki-b77513b3", assetType: "memory", name: "verity-report-farm-bars-required", parentAssetId: userStore.assetId };
    expect(managedLabel(types, verityMemory, stores)).toEqual({ managed: false });
  });
});

describe("instructionSlots", () => {
  it("puts GENERIC first and adds agent types policy doesn't list", () => {
    const md = [
      { assetId: "a", metadata: { agent_type: "INCIDENT_RCA" } },
      { assetId: "b", metadata: { agent_type: "GENERIC" } },
      { assetId: "c", metadata: { agent_type: "FUTURE_AGENT" } },
    ];
    const slots = instructionSlots(policy.agentTypes.agentTypes, md);
    expect(slots[0]).toMatchObject({ agentType: "GENERIC", primary: true });
    expect(slots[0]!.assets.map((a) => a.assetId)).toEqual(["b"]);
    expect(slots.find((s) => s.agentType === "INCIDENT_RCA")!.assets.map((a) => a.assetId)).toEqual(["a"]);
    expect(slots.at(-1)).toMatchObject({ agentType: "FUTURE_AGENT", inPolicy: false });
    expect(slots).toHaveLength(policy.agentTypes.agentTypes.length + 1);
  });
});

describe("collectAssetReferences", () => {
  const index = new Map(assets.map((a) => [a.assetId, { name: String(a.metadata.name ?? a.assetId), assetType: a.assetType }]));

  it("resolves skill and memory store IDs from any metadata key to names", () => {
    const meta = {
      name: "triage-helper",
      skills: ["ki-aa94f065-d420-4979-932c-41327da12ee3", "ki-6e6624f9-cca2-4545-8c89-3519caa36a0f"],
      memory: { store_ids: ["ki-f7aad8aa-0449-4221-bd9d-bceee6f33d24"] },
      unknown_ref: "ki-00000000-0000-0000-0000-000000000000",
      description: "not an id",
    };
    const refs = collectAssetReferences(meta, index, "ki-self");
    expect(refs.map((r) => [r.key, r.name, r.assetType])).toEqual([
      ["skills", "verity", "skill"],
      ["skills", "chat-tool-use-best-practices", "skill"],
      ["memory.store_ids", "verity", "memory_store"],
      ["unknown_ref", null, null],
    ]);
    const groups = groupReferences(refs);
    expect(groups.map((g) => g.assetType)).toEqual(["skill", "memory_store", null]);
    expect(groups[0]!.refs.map((r) => r.name)).toEqual(["chat-tool-use-best-practices", "verity"]);
  });
});

describe("skillFields", () => {
  it("reads agent types and status from metadata and enable_tools from metadata or frontmatter", () => {
    const meta = apiFixture<{ asset: { metadata: Record<string, unknown> } }>("GetAsset.skill").response.asset.metadata;
    expect(skillFields(meta, null)).toEqual({ agentTypes: ["GENERIC"], enableTools: [], enableToolsFrom: null, skillType: "LEARNED", status: "ACTIVE" });
    expect(skillFields(meta, { enable_tools: ["use_aws", "skill_read"] })).toMatchObject({ enableTools: ["use_aws", "skill_read"], enableToolsFrom: "frontmatter" });
    expect(skillFields({ ...meta, enable_tools: "verify_aws_claim" }, { enable_tools: ["x"] })).toMatchObject({ enableTools: ["verify_aws_claim"], enableToolsFrom: "metadata" });
  });
});
