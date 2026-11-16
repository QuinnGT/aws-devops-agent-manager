import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPolicyFromDirs, PolicyError, policySections } from "@/server/policy";

const APP_POLICY = path.resolve(__dirname, "../../../policy");

describe("attribution policy", () => {
  it("ships the documented defaults and the console role pattern", () => {
    const p = loadPolicyFromDirs([APP_POLICY]).policy.attribution;
    expect(p.lookupEvents.requestsPerSecond).toBeLessThanOrEqual(2);
    expect(p.events.writeEventNames).toEqual(["CreateAsset", "UpdateAsset", "CreateAssetFile", "UpdateAssetFile", "DeleteAssetFile", "DeleteAsset"]);
    expect(p.rolePatterns[0]).toEqual({ pattern: "DevOpsAgentRole-WebappAdmin-*", match: "roleName", source: "console", label: "Operator Web App" });
    expect(p.labels.agent).toBe("DevOps Agent");
    // The chip agrees with the long label "Operator Web App" in the detail line.
    expect(p.shortLabels.console).toBe("Web app");
    expect(p.notes.agent).toBe("No AWS API call was recorded for this change, so it's shown as made by the DevOps Agent.");
  });

  it("fills nested defaults when the attribution file is empty", () => {
    const fromDefaults = policySections.attribution.schema.parse({});
    const shipped = loadPolicyFromDirs([APP_POLICY]).policy.attribution;
    expect({ ...fromDefaults, rolePatterns: shipped.rolePatterns }).toEqual(shipped);
  });

  it("lets a history repo override one nested value", () => {
    const over = mkdtempSync(path.join(tmpdir(), "dam-attr-"));
    writeFileSync(path.join(over, "attribution.yaml"), "lookupEvents: { requestsPerSecond: 0.5 }\nnoEventSourceByAssetType: { agents_md: unknown }\n");
    const p = loadPolicyFromDirs([APP_POLICY, over]).policy.attribution;
    expect(p.lookupEvents).toMatchObject({ requestsPerSecond: 0.5, maxResults: 50 });
    expect(p.noEventSourceByAssetType).toEqual({ agents_md: "unknown" });
  });

  it("rejects an app source in a role pattern (app needs a clientToken match)", () => {
    const over = mkdtempSync(path.join(tmpdir(), "dam-attr-"));
    writeFileSync(path.join(over, "attribution.yaml"), 'rolePatterns: [{ pattern: "X*", source: app, label: X }]\n');
    expect(() => loadPolicyFromDirs([APP_POLICY, over])).toThrow(PolicyError);
  });
});
