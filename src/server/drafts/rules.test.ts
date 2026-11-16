import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { loadPolicyFromDirs } from "@/server/policy/loader";
import { editRulesFor, editViolations, isManagedAsset } from "./rules";

const policy = getAppPolicy().policy;
const STORE_ID = "ki-63edd778-1a7a-483f-8b18-479742a15a04";
const names = (type: string, id: string) => (type === "memory_store" && id === STORE_ID ? "chat-tool-use-best-practices" : undefined);

describe("managed assets", () => {
  it("are the stores in managedNames and the memories in them", () => {
    expect(isManagedAsset(policy, { assetType: "memory_store", metadata: { name: "monitors" } }, names)).toBe(true);
    expect(isManagedAsset(policy, { assetType: "memory", metadata: { name: "overview", memory_store_id: STORE_ID } }, names)).toBe(true);
    expect(isManagedAsset(policy, { assetType: "memory", metadata: { name: "x" }, refs: { memoryStore: "reflections" } }, names)).toBe(true);
    expect(isManagedAsset(policy, { assetType: "memory", metadata: { name: "x" }, refs: { memoryStore: "verity" } }, names)).toBe(false);
    expect(isManagedAsset(policy, { assetType: "skill", metadata: { name: "monitors" } }, names)).toBe(false);
  });

  it("allow content, metadata and the Active switch by default", () => {
    expect(editRulesFor(policy, "memory", true)).toMatchObject({ editable: true, managed: true, content: true, metadata: true, status: true, reason: null });
  });

  it("allow only the Active switch when plans.yaml turns content and metadata off", () => {
    const p = loadPolicyFromDirs([`${process.env.DAM_POLICY_DIR}`]).policy;
    const statusOnly = { ...p, plans: { ...p.plans, managed: { allowStatusSwitch: true, allowContentEdit: false, allowMetadataEdit: false } } };
    const rules = editRulesFor(statusOnly, "memory", true);
    expect(rules).toMatchObject({ editable: true, managed: true, content: false, metadata: false, status: true });
    expect(rules.reason).toBe("Editing memories in managed stores is turned off in this app's plan rules. You can still switch them on or off.");
    const before = { metadata: { name: "overview", status: "ACTIVE", description: "d" }, contentHash: "h1" };
    expect(editViolations(rules, before, { ...before, metadata: { ...before.metadata, status: "INACTIVE" } }, "memory:x")).toEqual([]);
    expect(editViolations(rules, before, { ...before, contentHash: "h2" }, "memory:x").map((r) => r.code)).toEqual(["managed.content"]);
    expect(editViolations(rules, before, { ...before, metadata: { ...before.metadata, description: "e" } }, "memory:x").map((r) => r.code)).toEqual(["managed.metadata"]);
    expect(editViolations(rules, null, before, "memory:x").map((r) => r.code)).toEqual(["managed.create"]);
  });

  it("follow plans.yaml when the switch is turned off", () => {
    const p = loadPolicyFromDirs([`${process.env.DAM_POLICY_DIR}`]).policy;
    const off = { ...p, plans: { ...p.plans, managed: { allowStatusSwitch: false, allowContentEdit: false, allowMetadataEdit: false } } };
    const rules = editRulesFor(off, "memory", true);
    expect(rules.editable).toBe(false);
    expect(editViolations(rules, { metadata: { status: "ACTIVE" }, contentHash: "h" }, { metadata: { status: "INACTIVE" }, contentHash: "h" }, "k")[0]?.code).toBe("edit.not-allowed");
  });

  it("refuse types that are not editable and the switch on types without status", () => {
    expect(editRulesFor(policy, "attachment", false)).toMatchObject({ editable: false });
    const md = editRulesFor(policy, "agents_md", false);
    expect(md).toMatchObject({ editable: true, content: true, status: false });
    const before = { metadata: { agent_type: "GENERIC", status: "ACTIVE" }, contentHash: "a" };
    expect(editViolations(md, before, { metadata: { agent_type: "GENERIC", status: "INACTIVE" }, contentHash: "b" }, "k").map((r) => r.code)).toEqual(["edit.status"]);
  });
});
