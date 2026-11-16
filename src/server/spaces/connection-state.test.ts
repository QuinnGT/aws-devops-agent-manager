import { describe, expect, it } from "vitest";
import { connectionView } from "./connection-state";

const checked = new Date("2026-11-11T22:15:00Z");
const before = new Date("2026-11-11T22:00:00Z");
const after = new Date("2026-11-11T22:30:00Z");
const ok = { connectionStatus: "ok", connectionCheckedAt: checked, connectionDetail: {} };
const noCreds = "Could not load credentials from any providers";

describe("connection view", () => {
  it("shows a later sync that failed for a settings cause as not connected, with the cause", () => {
    expect(connectionView(ok, { status: "error", error: noCreds, lastSyncCompletedAt: after })).toEqual({
      status: "failed",
      failedBy: "sync",
      at: after,
      cause: "This app has no AWS credentials for this space, so it can't reach AWS.",
      needsSettings: true,
    });
    expect(connectionView({ ...ok, connectionStatus: "unknown", connectionCheckedAt: null }, { status: "error", error: noCreds, lastSyncCompletedAt: after }).status).toBe("failed");
  });

  it("stays connected when the sync failure is older than the test or isn't a settings cause", () => {
    expect(connectionView(ok, { status: "error", error: noCreds, lastSyncCompletedAt: before }).status).toBe("ok");
    expect(connectionView(ok, { status: "error", error: "Rate exceeded", lastSyncCompletedAt: after }).status).toBe("ok");
    expect(connectionView(ok, { status: "succeeded", error: null, lastSyncCompletedAt: after })).toMatchObject({ status: "ok", cause: null });
    expect(connectionView({ ...ok, connectionStatus: "unknown", connectionCheckedAt: null }, null).status).toBe("unknown");
  });

  it("uses the failed test's error as a plain sentence, with its period", () => {
    const failed = { connectionStatus: "failed", connectionCheckedAt: checked, connectionDetail: { failedStep: "GetAgentSpace", error: { name: "CredentialsProviderError", message: noCreds } } };
    expect(connectionView(failed, null)).toMatchObject({
      status: "failed",
      failedBy: "test",
      cause: "This app has no AWS credentials for this space, so it can't reach AWS.",
      needsSettings: true,
    });
    const throttled = { ...failed, connectionDetail: { error: { name: "ThrottlingException", message: "Rate exceeded" } } };
    expect(connectionView(throttled, null)).toMatchObject({ status: "failed", needsSettings: false, cause: "AWS is limiting requests right now. Try again in a minute." });
    const rejected = { ...failed, connectionStatus: "rejected", connectionDetail: { error: { name: "ExternalIdNotEnforced", message: "These roles can be assumed without the external ID: r." } } };
    expect(connectionView(rejected, null)).toMatchObject({ status: "rejected", cause: "These roles can be assumed without the external ID: r.", needsSettings: true });
  });
});
