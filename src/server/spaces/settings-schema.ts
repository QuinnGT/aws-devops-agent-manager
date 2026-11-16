import { z } from "zod";
import { MODEL_ID_PATTERN } from "@/server/ai/models";

/**
 * Per-space settings stored in agent_spaces.settings.
 * Missing keys fall back to policy defaults where a policy default exists.
 */
export const incidentIdRuleSchema = z.object({
  /** Regex with one capture group (or a named group `id`) that extracts the incident ID */
  regex: z.string(),
  /** Task field to search: "title", "description" or "reference.referenceId" */
  field: z.enum(["title", "description", "reference.referenceId", "reference.title"]),
});

export const spaceSettingsSchema = z.object({
  /** Free-text environment label such as "Test" or "Production", shown next to the space name; null shows only the Region */
  environment: z.string().trim().max(40, "Use at most 40 characters.").nullable().default(null),
  incidentIdRule: incidentIdRuleSchema.nullable().default(null),
  /** Overrides policy sync.intervalMinutes */
  syncIntervalMinutes: z
    .number({ error: "Enter a number of minutes, or leave it empty for the policy default." })
    .int("Enter a whole number of minutes.")
    .min(1, "Enter 1 minute or more, or leave it empty for the policy default.")
    .nullable()
    .default(null),
  /** Per memory store name: commit policy override */
  storeCommitPolicies: z.record(z.string(), z.enum(["every-version", "daily", "ignore"])).default({}),
  changeReasonRequired: z.boolean().default(true),
  approvalRequired: z.boolean().default(false),
  /** Deletes stay off unless an Admin turns them on */
  deletesEnabled: z.boolean().default(false),
  /**
   * Bedrock inference: "space" uses the space's read role. `region` overrides the space Region.
   * reviewModelId and reportModelId are the space defaults for audits (src/server/ai/models.ts);
   * an audit can choose its own. No model is set until an Admin or the audit picks one.
   */
  inference: z
    .object({
      mode: z.enum(["space"]).default("space"),
      region: z.string().nullable().default(null),
      reviewModelId: z.string().trim().regex(MODEL_ID_PATTERN, "Enter a Bedrock model ID or inference profile ID.").nullable().default(null),
      reportModelId: z.string().trim().regex(MODEL_ID_PATTERN, "Enter a Bedrock model ID or inference profile ID.").nullable().default(null),
    })
    .default({ mode: "space", region: null, reviewModelId: null, reportModelId: null }),
  replays: z
    .object({
      concurrency: z.number({ error: "Enter a number of replays." }).int("Enter a whole number.").min(1, "Enter 1 or more.").default(1),
      usageFloorHours: z.number({ error: "Enter a number of hours, or leave it empty." }).nullable().default(null),
      enabled: z.boolean().default(false),
    })
    .default({ concurrency: 1, usageFloorHours: null, enabled: false }),
});

export type SpaceSettings = z.output<typeof spaceSettingsSchema>;
export type IncidentIdRule = z.output<typeof incidentIdRuleSchema>;
export type IncidentIdField = IncidentIdRule["field"];

/** Task fields an incident ID rule can read, with labels for the settings UI. */
export const INCIDENT_ID_FIELDS: { value: IncidentIdField; label: string }[] = [
  { value: "title", label: "Task title" },
  { value: "description", label: "Task description" },
  { value: "reference.referenceId", label: "Reference ID (reference.referenceId)" },
  { value: "reference.title", label: "Reference title (reference.title)" },
];

export function parseSpaceSettings(raw: unknown): SpaceSettings {
  return spaceSettingsSchema.parse(raw ?? {});
}
