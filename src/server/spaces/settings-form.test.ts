import { describe, expect, it } from "vitest";
import { parseSettingsForm, parseSettingsSectionForm, SETTINGS_SECTIONS, settingsDiff, settingsSectionSchema } from "./settings-form";
import { parseSpaceSettings } from "./settings-schema";

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

describe("parseSettingsForm", () => {
  it("reads every settings field", () => {
    const r = parseSettingsForm(
      form({
        "incidentIdRule.enabled": "on",
        "incidentIdRule.regex": "\\[(INC-\\d+)\\]",
        "incidentIdRule.field": "title",
        syncIntervalMinutes: "30",
        "store.0.name": "understanding-agent-space",
        "store.0.policy": "daily",
        "store.1.name": "default-store",
        "store.1.policy": "",
        "store.2.name": "",
        "store.2.policy": "ignore",
        changeReasonRequired: "on",
        approvalRequired: "on",
        "inference.mode": "space",
        "inference.region": "us-east-1",
        "inference.reviewModelId": " us.anthropic.example-model-v1:0 ",
        "replays.enabled": "on",
        "replays.concurrency": "2",
        "replays.usageFloorHours": "10",
        environment: " Test ",
      }),
    );
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      environment: "Test",
      incidentIdRule: { regex: "\\[(INC-\\d+)\\]", field: "title" },
      syncIntervalMinutes: 30,
      storeCommitPolicies: { "understanding-agent-space": "daily" },
      changeReasonRequired: true,
      approvalRequired: true,
      deletesEnabled: false,
      inference: { mode: "space", region: "us-east-1", reviewModelId: "us.anthropic.example-model-v1:0", reportModelId: null },
      replays: { enabled: true, concurrency: 2, usageFloorHours: 10 },
    });
  });

  it("turns blanks into defaults and unchecked boxes into false", () => {
    const r = parseSettingsForm(form({ "incidentIdRule.regex": "ignored", syncIntervalMinutes: "", "replays.concurrency": "" }));
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      ...parseSpaceSettings({}),
      changeReasonRequired: false,
    });
  });

  it("rejects an incident pattern that does not compile", () => {
    const r = parseSettingsForm(form({ "incidentIdRule.enabled": "on", "incidentIdRule.regex": "(INC", "incidentIdRule.field": "title" }));
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["incidentIdRule", "regex"]);
  });

  it("rejects an unknown incident field, bad numbers and a bad Region", () => {
    expect(parseSettingsForm(form({ "incidentIdRule.enabled": "on", "incidentIdRule.regex": "x", "incidentIdRule.field": "raw" })).success).toBe(false);
    expect(parseSettingsForm(form({ syncIntervalMinutes: "0" })).success).toBe(false);
    expect(parseSettingsForm(form({ syncIntervalMinutes: "abc" })).success).toBe(false);
    expect(parseSettingsForm(form({ "inference.region": "Oregon" })).success).toBe(false);
    expect(parseSettingsForm(form({ "inference.reviewModelId": "not a model; rm -rf" })).success).toBe(false);
    expect(parseSettingsForm(form({ "store.0.name": "s", "store.0.policy": "hourly" })).success).toBe(false);
  });
});

describe("parseSettingsSectionForm", () => {
  const stored = parseSpaceSettings({
    environment: "Test",
    syncIntervalMinutes: 20,
    storeCommitPolicies: { notes: "daily" },
    approvalRequired: true,
    incidentIdRule: { regex: "(INC-\\d+)", field: "title" },
    replays: { enabled: true, concurrency: 2, usageFloorHours: 5 },
  });

  it("replaces only the section's keys and keeps every other stored setting", () => {
    const r = parseSettingsSectionForm("plans", form({ deletesEnabled: "on" }), stored);
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ ...stored, changeReasonRequired: false, approvalRequired: false, deletesEnabled: true });
  });

  it("does not reset other sections' checkboxes when their fields are not in the form", () => {
    const r = parseSettingsSectionForm("environment", form({ environment: " Production " }), stored);
    expect(r.data).toEqual({ ...stored, environment: "Production" });
    expect(r.data?.approvalRequired).toBe(true);
    expect(r.data?.replays.enabled).toBe(true);
  });

  it("reads the change capture section, dropping stores set back to the policy default", () => {
    const r = parseSettingsSectionForm(
      "capture",
      form({ syncIntervalMinutes: "", "store.0.name": "notes", "store.0.policy": "", "store.1.name": "runbooks", "store.1.policy": "ignore" }),
      stored,
    );
    expect(r.data).toEqual({ ...stored, syncIntervalMinutes: null, storeCommitPolicies: { runbooks: "ignore" } });
  });

  it("turns the incident rule off when its box is unchecked, and reports errors at the form's field names", () => {
    expect(parseSettingsSectionForm("incident", form({}), stored).data?.incidentIdRule).toBeNull();
    const bad = parseSettingsSectionForm("incident", form({ "incidentIdRule.enabled": "on", "incidentIdRule.regex": "(INC", "incidentIdRule.field": "title" }), stored);
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(["incidentIdRule", "regex"]);
    const replays = parseSettingsSectionForm("replays", form({ "replays.concurrency": "0" }), stored);
    expect(replays.error?.issues[0]?.path).toEqual(["replays", "concurrency"]);
    expect(replays.error?.issues[0]?.message).toBe("Enter 1 or more.");
    const interval = (v: string) => parseSettingsSectionForm("capture", form({ syncIntervalMinutes: v }), stored).error?.issues[0]?.message;
    expect(interval("0")).toMatch(/1 minute or more/);
    expect(interval("1.5")).toBe("Enter a whole number of minutes.");
    expect(interval("abc")).toMatch(/Enter a number of minutes/);
  });

  it("covers every settings key exactly once, and rejects unknown sections", () => {
    const keys = Object.values(SETTINGS_SECTIONS).flat();
    expect([...keys].sort()).toEqual(Object.keys(parseSpaceSettings({})).sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(settingsSectionSchema.safeParse("plans").success).toBe(true);
    expect(settingsSectionSchema.safeParse("everything").success).toBe(false);
  });
});

describe("settingsDiff", () => {
  it("lists changed top-level keys with before and after", () => {
    const a = parseSpaceSettings({});
    const b = { ...a, approvalRequired: true, incidentIdRule: { regex: "(x)", field: "title" as const } };
    expect(settingsDiff(a, b)).toEqual({
      approvalRequired: { from: false, to: true },
      incidentIdRule: { from: null, to: { regex: "(x)", field: "title" } },
    });
  });
});
