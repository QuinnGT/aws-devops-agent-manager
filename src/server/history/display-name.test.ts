import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { agentTypeLabel, assetLabel, assetLabelKey } from "./display-name";

const policy = getAppPolicy().policy;

describe("asset display names", () => {
  it("names instruction files by agent type, with the ID kept as the key", () => {
    expect(assetLabel(policy, { assetType: "agents_md", name: "GENERIC" })).toBe("Global instructions");
    expect(assetLabel(policy, { assetType: "agents_md", name: "x", metadata: { agent_type: "INCIDENT_TRIAGE" } })).toBe("Incident triage instructions");
    expect(assetLabel(policy, { assetType: "agents_md", name: "NEW_TYPE" })).toBe("NEW_TYPE instructions");
    expect(assetLabelKey(policy, { assetType: "agents_md", name: "GENERIC" })).toBe("GENERIC");
    expect(assetLabelKey(policy, { assetType: "skill", name: "verity" })).toBeNull();
  });

  it("uses an artifact's title when its name is only its ID, and keeps other names", () => {
    const id = "ki-83909e28-f98d-4d39-8179-02ca7555b4d4";
    expect(assetLabel(policy, { assetType: "artifact", name: id, assetId: id, metadata: { title: "Agent Space Summary Report" } })).toBe("Agent Space Summary Report");
    expect(assetLabel(policy, { assetType: "artifact", name: id, assetId: id, metadata: {} })).toBe(id);
    expect(assetLabel(policy, { assetType: "skill", name: "verity", assetId: "ki-1", metadata: { title: "ignored" } })).toBe("verity");
    expect(assetLabel(policy, { assetType: "memory", name: "databases/rds-failover" })).toBe("databases/rds-failover");
  });

  it("gives agent types their short label for chips", () => {
    expect(agentTypeLabel(policy, "GENERIC")).toBe("Global");
    expect(agentTypeLabel(policy, "INCIDENT_RCA")).toBe("Incident RCA");
    expect(agentTypeLabel(policy, "UNKNOWN")).toBe("UNKNOWN");
  });
});
