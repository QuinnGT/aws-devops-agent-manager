import { describe, expect, it } from "vitest";
import type { ModelOption } from "@/server/ai/models";
import { checkModelId, groupByProvider, typedModelId } from "./model-picker";

const opt = (id: string, provider: string | null): ModelOption => ({ id, label: id, kind: "foundation-model", provider, status: "ACTIVE" });

describe("model picker helpers", () => {
  it("groups models by provider in the catalogue's order", () => {
    const groups = groupByProvider([opt("a.1", "Alpha"), opt("a.2", "Alpha"), opt("z.1", "Zeta"), opt("x", null)]);
    expect(groups.map((g) => [g.provider, g.models.map((m) => m.id)])).toEqual([
      ["Alpha", ["a.1", "a.2"]],
      ["Zeta", ["z.1"]],
      ["Other", ["x"]],
    ]);
  });

  it("offers a typed ID only when it has the shape of a model ID and isn't in the list", () => {
    const list = [opt("alpha.chat-v1", "Alpha")];
    expect(typedModelId("  us.alpha.chat-v2:0 ", list)).toBe("us.alpha.chat-v2:0");
    expect(typedModelId("arn:aws:bedrock:us-west-2:111122223333:inference-profile/us.alpha.chat-v2", list)).toBe("arn:aws:bedrock:us-west-2:111122223333:inference-profile/us.alpha.chat-v2");
    expect(typedModelId("alpha.chat-v1", list)).toBeNull();
    expect(typedModelId("chat model", list)).toBeNull();
    expect(typedModelId("", list)).toBeNull();
  });

  it("checks a chosen ID against the list once it is loaded", () => {
    const ready = (models: ModelOption[], error: string | null = null) => ({ status: "ready" as const, catalog: { models, error } });
    const list = [opt("us.alpha.chat-v1", "Alpha")];
    expect(checkModelId("us.alpha.chat-v1", ready(list))).toBeNull();
    expect(checkModelId("claude", ready(list))).toEqual({ tone: "warning", text: "Not in the models this space can use. It is used as typed; check the ID before you start." });
    expect(checkModelId("claude", ready([], "AWS refused the request"))?.text).toMatch(/^Can't check this ID/);
    expect(checkModelId("us.alpha.chat-v1", ready(list, "one list was refused"))).toBeNull();
    expect(checkModelId("claude", { status: "failed" })?.tone).toBe("muted");
    expect(checkModelId("claude", { status: "idle" })).toBeNull();
    expect(checkModelId("", ready(list))).toBeNull();
  });
});
