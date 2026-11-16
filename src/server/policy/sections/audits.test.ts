import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPolicyFromDirs } from "../loader";

const policyDir = path.resolve(__dirname, "../../../../policy");

describe("audits policy", () => {
  const { policy } = loadPolicyFromDirs([policyDir]);

  it("loads the default profile", () => {
    expect(policy.audits.profiles[policy.audits.defaultProfile]).toBeDefined();
  });

  it("labels every failure mode and fix owner the benchmark output schema allows", () => {
    const profile = policy.audits.profiles.benchmark!;
    const schema = JSON.parse(readFileSync(path.join(policyDir, profile.review.outputSchema), "utf8"));
    const modes: string[] = schema.properties.primary_failure_mode.enum;
    const owners: string[] = schema.properties.fixes.items.properties.owner.enum;
    expect(new Set(profile.failureModes.map((m) => m.id))).toEqual(new Set(modes));
    expect(new Set(profile.fixOwners.map((o) => o.id))).toEqual(new Set(owners));
    expect(schema.properties.failure_modes.items.enum).toEqual(modes);
  });

  it("extracts findings only from fields the output schema has", () => {
    const profile = policy.audits.profiles.benchmark!;
    const schema = JSON.parse(readFileSync(path.join(policyDir, profile.review.outputSchema), "utf8"));
    for (const f of profile.findings) {
      const props = f.from === "$" ? schema.properties : schema.properties[f.from].items.properties;
      for (const field of [...f.fields, ...f.editable]) expect(props, `${f.kind}.${field}`).toHaveProperty(field);
    }
  });
});
