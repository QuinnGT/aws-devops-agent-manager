import { describe, expect, it } from "vitest";
import type { DesiredAsset, LiveAssetRef } from "@/server/packages/types";
import { getAppPolicy } from "@/server/policy";
import { apiFixture } from "../../../test/helpers/fixtures";
import { assetIdentity } from "./identity";
import { validateAssetSet } from "./set";
import type { ValidationResult } from "./types";

const policy = getAppPolicy().policy;
const live = apiFixture<{ items: LiveAssetRef[] }>("ListAssets.page1").response.items;
const STORE_ID = "ki-63edd778-1a7a-483f-8b18-479742a15a04"; // chat-tool-use-best-practices
const SKILL_ID = live.find((a) => a.assetType === "skill" && a.metadata.name === "verity")!.assetId;

function d(assetType: string, metadata: Record<string, unknown>, extra: Partial<DesiredAsset> = {}, file = "x.md"): DesiredAsset {
  const a = { assetType, metadata, files: [{ path: file, encoding: "utf8" as const, content: "# x\n" }], ...extra };
  return { ...a, key: assetIdentity(policy, a) };
}
const store = (name: string) => d("memory_store", { name, description: "Runbooks.", agent_types: ["GENERIC"] }, {}, "README.md");
const memory = (name: string, storeName: string) => d("memory", { name, description: "d" }, { refs: { memoryStore: storeName } });
const skill = (name: string) => d("skill", { name, description: "d", agent_types: ["GENERIC"] }, {}, "SKILL.md");
const run = (desired: DesiredAsset[], perAsset = true) => validateAssetSet(desired, { policy, live, perAsset });
const codes = (r: ValidationResult[]) => r.map((x) => `${x.code} ${x.assetKey}`);

describe("validateAssetSet", () => {
  it("accepts a new store with a memory that refers to it by name", () => {
    expect(run([store("runbooks"), memory("db/failover", "runbooks")])).toEqual([]);
  });

  it("resolves memory_store_id against the live space", () => {
    const ok = d("memory", { name: "new-note", description: "d", memory_store_id: STORE_ID });
    expect(run([ok])).toEqual([]);
    expect(codes(run([d("memory", { name: "n", description: "d", memory_store_id: "ki-nope" })]))).toEqual(["reference.unresolved memory:ki-nope/n"]);
    expect(codes(run([d("memory", { name: "n", description: "d" })]))).toEqual(["reference.missing memory:n"]);
    expect(codes(run([memory("n", "no-such-store")]))).toEqual(["reference.unresolved memory:no-such-store/n"]);
  });

  it("requires unique memory names per store, not across stores", () => {
    expect(codes(run([store("a"), store("b"), memory("x", "a"), memory("x", "b")]))).toEqual([]);
    expect(codes(run([store("a"), memory("x", "a"), memory("x", "a")]))).toEqual(["identity.duplicate memory:a/x", "identity.duplicate memory:a/x"]);
    // A live memory in the same store with the same name is the asset being updated
    expect(run([d("memory", { name: "overview", description: "d", memory_store_id: STORE_ID })])).toEqual([]);
  });

  it("allows one AGENTS.md per agent type", () => {
    const md = (t: string) => d("agents_md", { agent_type: t }, {}, "AGENTS.md");
    expect(codes(run([md("CHAT"), md("CHAT")]))).toEqual(["identity.duplicate agents_md:CHAT", "identity.duplicate agents_md:CHAT"]);
    // The live space has a GENERIC AGENTS.md: a new GENERIC draft updates it
    expect(run([md("GENERIC")])).toEqual([]);
  });

  it("checks custom agent skill and store references by ID and by name", () => {
    const agent = (metadata: Record<string, unknown>, refs?: DesiredAsset["refs"]) =>
      d("custom_agent", { name: "rds-firefighter", ...metadata }, refs ? { refs } : {}, "AGENT.md");
    expect(run([agent({ skills: [SKILL_ID], memory_stores: [STORE_ID] })])).toEqual([]);
    expect(run([skill("new-skill"), agent({}, { skills: ["new-skill", "verity"], memoryStores: ["verity"] })])).toEqual([]);
    expect(codes(run([agent({ skills: ["ki-nope"] }, { memoryStores: ["nope"] })]))).toEqual([
      "reference.unresolved custom_agent:rds-firefighter",
      "reference.unresolved custom_agent:rds-firefighter",
    ]);
  });

  it("counts user skills against the space limit, not learned ones", () => {
    // The live space has 2 user skills and 2 learned skills
    const many = (n: number) => Array.from({ length: n }, (_, i) => skill(`s-${i}`));
    expect(run(many(198), false)).toEqual([]);
    const over = run(many(199), false);
    expect(codes(over)).toEqual(["count.limit skill:s-0"]);
    expect(over[0]!.message).toBe("This change makes 201 skill assets in the space; the limit is 200.");
  });

  it("counts memories per store and stores per space", () => {
    const mems = (n: number) => Array.from({ length: n }, (_, i) => memory(`m-${i}`, "runbooks"));
    expect(run([store("runbooks"), ...mems(200)], false)).toEqual([]);
    const over = run([store("runbooks"), ...mems(201)], false);
    expect(over.map((r) => r.message)).toEqual(["This change makes 201 memory assets in runbooks; the limit is 200."]);
    const stores = Array.from({ length: 48 }, (_, i) => store(`st-${i}`));
    expect(codes(run(stores, false))).toEqual(["count.limit memory_store:st-0"]);
  });
});
