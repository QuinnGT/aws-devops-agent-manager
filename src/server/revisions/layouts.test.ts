import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { chooseUsualLayout } from "./layouts";

const policy = getAppPolicy().policy;
const at = (d: string) => new Date(`2026-11-${d}T01:00:00.000Z`);

describe("the layout a new revision starts with", () => {
  it("is the layout of the newer of the last import and the last revision release", () => {
    expect(chooseUsualLayout(policy, { layout: "agent-space-folders", at: at("12") }, { layout: "instruction-folders", at: at("10"), release: "v1.2" })).toEqual({ name: "agent-space-folders", source: "import", at: at("12") });
    expect(chooseUsualLayout(policy, { layout: "agent-space-folders", at: at("09") }, { layout: "instruction-folders", at: at("10"), release: "v1.2" })).toEqual({ name: "instruction-folders", source: "release", at: at("10"), release: "v1.2" });
  });

  it("falls back to the policy default when neither is known or the layout is gone", () => {
    expect(chooseUsualLayout(policy, null, null)).toEqual({ name: policy.packageLayouts.defaultLayout, source: "default", at: null });
    expect(chooseUsualLayout(policy, { layout: "removed-layout", at: at("12") }, null).source).toBe("default");
  });

  it("has a description for every shipped layout", () => {
    for (const [name, l] of Object.entries(policy.packageLayouts.layouts)) expect(l.description, name).toMatch(/^For /);
  });
});
