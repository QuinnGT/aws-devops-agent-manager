import { z } from "zod";
import { compileIncidentRegex } from "./incident-id";
import { type SpaceSettings, spaceSettingsSchema } from "./settings-schema";

/**
 * Turns the space settings form into SpaceSettings. Pure; unit-tested.
 *
 * Form field names:
 *   environment                             blank = not set
 *   incidentIdRule.enabled, incidentIdRule.regex, incidentIdRule.field
 *   syncIntervalMinutes                     blank = policy default
 *   store.<n>.name, store.<n>.policy        policy blank = policy default (row dropped)
 *   changeReasonRequired, approvalRequired, deletesEnabled
 *   inference.mode, inference.region        region blank = the space's Region
 *   inference.reviewModelId, inference.reportModelId   blank = no space default
 *   replays.enabled, replays.concurrency, replays.usageFloorHours
 */

function text(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function flag(form: FormData, key: string): boolean {
  const v = form.get(key);
  return v === "on" || v === "true" || v === "1";
}

/** Blank becomes null; anything else becomes a number (NaN fails the schema). */
function numberOrNull(form: FormData, key: string): number | null {
  const v = text(form, key);
  return v === "" ? null : Number(v);
}

export function settingsFromForm(form: FormData): unknown {
  const storeCommitPolicies: Record<string, string> = {};
  const storeIndexes = new Set<string>();
  for (const key of form.keys()) {
    const m = /^store\.(\d{1,4})\.name$/.exec(key);
    if (m?.[1]) storeIndexes.add(m[1]);
  }
  for (const i of storeIndexes) {
    const name = text(form, `store.${i}.name`);
    const policy = text(form, `store.${i}.policy`);
    if (name && policy) storeCommitPolicies[name] = policy;
  }

  const ruleEnabled = flag(form, "incidentIdRule.enabled");
  const inferenceRegion = text(form, "inference.region");
  return {
    environment: text(form, "environment") || null,
    incidentIdRule: ruleEnabled ? { regex: text(form, "incidentIdRule.regex"), field: text(form, "incidentIdRule.field") } : null,
    syncIntervalMinutes: numberOrNull(form, "syncIntervalMinutes"),
    storeCommitPolicies,
    changeReasonRequired: flag(form, "changeReasonRequired"),
    approvalRequired: flag(form, "approvalRequired"),
    deletesEnabled: flag(form, "deletesEnabled"),
    inference: {
      mode: text(form, "inference.mode") || "space",
      region: inferenceRegion === "" ? null : inferenceRegion,
      reviewModelId: text(form, "inference.reviewModelId") || null,
      reportModelId: text(form, "inference.reportModelId") || null,
    },
    replays: {
      enabled: flag(form, "replays.enabled"),
      concurrency: numberOrNull(form, "replays.concurrency") ?? 1,
      usageFloorHours: numberOrNull(form, "replays.usageFloorHours"),
    },
  };
}

const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;

/** spaceSettingsSchema plus checks that only apply when an Admin saves settings. */
export const spaceSettingsUpdateSchema = spaceSettingsSchema.superRefine((s, ctx) => {
  if (s.incidentIdRule) {
    const c = compileIncidentRegex(s.incidentIdRule.regex);
    if (!c.ok) ctx.addIssue({ code: "custom", path: ["incidentIdRule", "regex"], message: c.error });
  }
  if (s.inference.region !== null && !REGION_RE.test(s.inference.region)) {
    ctx.addIssue({ code: "custom", path: ["inference", "region"], message: "Enter a Region code such as us-west-2." });
  }
  for (const name of Object.keys(s.storeCommitPolicies)) {
    if (name.length > 200) ctx.addIssue({ code: "custom", path: ["storeCommitPolicies"], message: "Store names are at most 200 characters." });
  }
  if (s.replays.usageFloorHours !== null && !(s.replays.usageFloorHours >= 0)) {
    ctx.addIssue({ code: "custom", path: ["replays", "usageFloorHours"], message: "Enter zero or more hours." });
  }
});

export function parseSettingsForm(form: FormData): z.ZodSafeParseResult<SpaceSettings> {
  return spaceSettingsUpdateSchema.safeParse(settingsFromForm(form));
}

/**
 * The settings page saves one section at a time. Each section's form holds
 * only its own fields, so the other keys keep their stored values.
 */
export const SETTINGS_SECTIONS = {
  environment: ["environment"],
  capture: ["syncIntervalMinutes", "storeCommitPolicies"],
  incident: ["incidentIdRule"],
  plans: ["changeReasonRequired", "approvalRequired", "deletesEnabled"],
  inference: ["inference"],
  replays: ["replays"],
} as const satisfies Record<string, readonly (keyof SpaceSettings)[]>;

export type SettingsSection = keyof typeof SETTINGS_SECTIONS;

export const settingsSectionSchema = z.enum(Object.keys(SETTINGS_SECTIONS) as [SettingsSection, ...SettingsSection[]]);

/** The stored settings with one section's keys replaced by the form's values (not yet validated). */
export function settingsSectionFromForm(section: SettingsSection, form: FormData, current: SpaceSettings): unknown {
  const fromForm = settingsFromForm(form) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };
  for (const key of SETTINGS_SECTIONS[section]) next[key] = fromForm[key];
  return next;
}

export function parseSettingsSectionForm(section: SettingsSection, form: FormData, current: SpaceSettings): z.ZodSafeParseResult<SpaceSettings> {
  return spaceSettingsUpdateSchema.safeParse(settingsSectionFromForm(section, form, current));
}

/** Top-level settings keys whose values differ, with before and after, for the audit log. */
export function settingsDiff(before: SpaceSettings, after: SpaceSettings): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after) as (keyof SpaceSettings)[]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) out[key] = { from: before[key], to: after[key] };
  }
  return out;
}
