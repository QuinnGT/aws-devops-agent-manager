import { z } from "zod";
import { defineSection } from "./define";

/**
 * Audit profiles. A profile names its inputs, analyzers,
 * review prompt and output schema, failure modes, fix owners, finding
 * extractors and report. Prompts, schemas and templates are files under the
 * policy directory, referenced by path and read with readPolicyFile.
 *
 * A new field on a profile's `inputs`, `cohorts`, `findings`, `review` or
 * `report` should be OPTIONAL, so a profile written before it existed still loads.
 */

const policyPath = z
  .string()
  .min(1)
  .refine((p) => !p.includes("..") && !p.startsWith("/"), "a path inside the policy directory");

/** A ground-truth document the profile needs per incident. */
const groundTruthInput = z.object({
  /** Stored as evidence_docs.kind */
  kind: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  label: z.string(),
  /** Regex on the uploaded file name. Group `id` (or group 1) captures the incident number. */
  fileNamePattern: z.string(),
  /** A file name the pattern takes, shown in the upload help, e.g. "INCIDENT-20101_scorecard.md" */
  fileNameExample: z.string().optional(),
  required: z.boolean().default(true),
  /** Fields read from the document body: a regex whose group `value` (or group 1) is the value */
  fields: z
    .record(
      z.string(),
      z.object({
        label: z.string(),
        pattern: z.string(),
        /** (audits-core) Shown as a column in the audit's item list, e.g. the benchmark score */
        column: z.boolean().default(false),
        /** What the value means, shown as help next to it on the review pages */
        description: z.string().optional(),
      }),
    )
    .default({}),
});

const labeled = z.object({ id: z.string(), label: z.string(), description: z.string().default("") });

const reviewConfig = z.object({
  /** "ai-sdk": AI SDK + Bedrock Converse. The Claude Agent SDK runner is a later addition. */
  runner: z.enum(["ai-sdk"]).default("ai-sdk"),
  /**
   * Optional fallback only. The review model is chosen in the app (the audit, then the
   * space default in Space settings); see src/server/ai/models.ts. The shipped policy sets none.
   */
  modelId: z.string().min(1).optional(),
  /** Hard cap on model steps (tool round trips) per review */
  stepLimit: z.number().int().min(1).max(200).default(40),
  maxOutputTokens: z.number().int().positive().default(16000),
  /** Reviews running at once for one audit */
  concurrency: z.number().int().min(1).max(32).default(4),
  timeoutSeconds: z.number().int().positive().default(900),
  systemPrompt: policyPath.default("prompts/reviewer-system.md"),
  /** Per-incident prompt template ({{placeholders}} filled by the reviewer) */
  promptTemplate: policyPath,
  /** JSON Schema (draft 2020-12) the review output must pass */
  outputSchema: policyPath,
  /** Characters of the condensed trace put in the prompt; the full journal is reachable through the tools */
  traceCharsInPrompt: z.number().int().positive().default(120_000),
  /** Cap on one tool result, in characters */
  toolOutputCapChars: z.number().int().positive().default(8_000),
  // Optional reviewer settings. Defaults live in src/server/review/settings.ts,
  // so profiles written before these fields existed keep the same type.
  /** Message sent with the last step, when the tools are withdrawn so the model writes its output */
  finalStepPrompt: policyPath.optional(),
  /** Characters of each analyzer output put in the prompt (default 12000) */
  analyzerCharsInPrompt: z.number().int().positive().optional(),
  /** Characters of each ground-truth document put in the prompt (default 40000) */
  groundTruthCharsInPrompt: z.number().int().positive().optional(),
  /** Bedrock prompt cache point after the brief, so later steps reuse it (default off) */
  promptCache: z.boolean().optional(),
  /** How Bedrock produces structured output for Anthropic models (provider default "auto") */
  structuredOutputMode: z.enum(["auto", "outputFormat", "jsonTool"]).optional(),
});

/** Turns review output into findings a person accepts or rejects. */
const findingExtractor = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  label: z.string(),
  /** "$" for the review object itself, or a top-level array key of the output (one finding per element) */
  from: z.string().default("$"),
  /** Title template: {field} from the item, plus {incidentId} */
  title: z.string(),
  /** Fields copied into the finding; summary tables group by these */
  fields: z.array(z.string()).min(1),
  /** Fields a reviewer may edit before accepting */
  editable: z.array(z.string()).default([]),
  /** Accepted findings of this kind can be linked from a revision */
  linkable: z.boolean().default(false),
  /**
   * (audits-core) The field shown as the item's diagnosis in the audit's item
   * list, e.g. primary_failure_mode. The first extractor that sets it is the
   * item's primary finding. Use it on a "$" extractor.
   */
  summaryField: z.string().optional(),
  /** Labels for the fields on the review pages, e.g. { near_miss: "Near miss" }; default: the key in words */
  fieldLabels: z.record(z.string(), z.string()).optional(),
  /**
   * Labels for the values of enum fields that are not failure
   * modes or fix owners, e.g. { reachability: { reachable: "Reachable" } }
   */
  valueLabels: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  /** Fields the finding card leaves out because the incident page shows them elsewhere (the title, the ground truth) */
  cardHidden: z.array(z.string()).optional(),
});

const reportSection = z.object({
  id: z.string(),
  title: z.string(),
  /** Internal sections are left out of the shareable export */
  audience: z.enum(["internal", "shareable"]).default("internal"),
  /**
   * narrative: drafted by the model from `prompt`, then edited by a person.
   * count-table: accepted findings of `findingKind` counted by `field` (labels from `labels`).
   * findings-table: accepted findings of `findingKind`, one row each, `columns` from their fields.
   * metrics-table: analyzer output per incident (`analyzer`, `columns` as dotted paths).
   * incident-list: one block per incident with its diagnosis.
   */
  kind: z.enum(["narrative", "count-table", "findings-table", "metrics-table", "incident-list"]),
  prompt: policyPath.optional(),
  findingKind: z.string().optional(),
  field: z.string().optional(),
  /** "failureModes" or "fixOwners", for readable labels in count tables */
  labels: z.enum(["failureModes", "fixOwners"]).optional(),
  analyzer: z.string().optional(),
  columns: z.array(z.string()).optional(),
  // Optional report fields:
  /** Readable labels for the values of `field` in a count table, in the order to list them (when `labels` is not set) */
  valueLabels: z.record(z.string(), z.string()).optional(),
  /** Column and field headings, by column ID or dotted path (default: the ID) */
  headers: z.record(z.string(), z.string()).optional(),
  /** Readable value labels per column or field: the profile's failureModes or fixOwners, or a map of value to label */
  columnLabels: z.record(z.string(), z.union([z.enum(["failureModes", "fixOwners"]), z.record(z.string(), z.string())])).optional(),
  /** incident-list: evidence_docs fields to show per incident (default: every field the profile's inputs define) */
  evidenceFields: z.array(z.string()).optional(),
});

const committerDefault = { name: "DevOps Agent Manager", email: "audits@devops-agent-manager.invalid" };

/** The report: sections plus the narrative model settings and the finalize commit. */
const reportConfig = z.object({
  title: z.string(),
  sections: z.array(reportSection).min(1),
  /** Model for narrative sections; defaults to review.modelId. Never in code. */
  modelId: z.string().min(1).optional(),
  /** System prompt for narrative drafts, a file under the policy directory */
  systemPrompt: policyPath.optional(),
  maxOutputTokens: z.number().int().positive().default(4000),
  /** Time limit for one narrative draft */
  timeoutSeconds: z.number().int().positive().default(300),
  /** Longest narrative a draft or a person may store, in characters */
  narrativeMaxChars: z.number().int().positive().default(20_000),
  /** Cap on the accepted findings put in a narrative prompt, in characters */
  narrativeInputCapChars: z.number().int().positive().default(150_000),
  /** Cap on one finding value in a narrative prompt, in characters */
  narrativeValueCapChars: z.number().int().positive().default(1_000),
  /** Count-table row label for findings without a value */
  missingValueLabel: z.string().default("Not set"),
  /** Output rule severities that refuse an export */
  exportBlockOn: z.array(z.enum(["error", "warning"])).default(["error"]),
  /** Finalize commit subject; placeholders {auditName}, {spaceAlias}, {auditId} */
  commitMessage: z.string().default("Finalize audit {auditName} of {spaceAlias}"),
  committer: z.object({ name: z.string().min(1), email: z.string().min(1) }).default(committerDefault),
});

export const auditProfileSchema = z.object({
  label: z.string(),
  description: z.string().default(""),
  /** Turns a captured incident number into the incident ID the space's rule produces, e.g. "INCIDENT-{id}" */
  incidentIdTemplate: z.string().default("{id}"),
  inputs: z.array(groundTruthInput).default([]),
  /** Groups compared by the profile (before and after a revision); empty for a single group */
  cohorts: z.array(labeled.pick({ id: true, label: true })).default([]),
  /** Analyzer IDs run before the review (analyzers registry) */
  analyzers: z.array(z.string()).min(1),
  review: reviewConfig,
  failureModes: z.array(labeled).default([]),
  fixOwners: z.array(labeled).default([]),
  findings: z.array(findingExtractor).min(1),
  report: reportConfig,
});

export type AuditProfile = z.output<typeof auditProfileSchema>;

export const auditsSection = defineSection(
  "audits.yaml",
  z.object({
    /** Most investigations in one audit */
    maxItemsPerAudit: z.number().int().positive().default(500),
    /** Largest ground-truth upload (one zip or several files), in bytes */
    maxEvidenceUploadBytes: z.number().int().positive().default(50 * 1024 * 1024),
    /** Default profile for a new audit */
    defaultProfile: z.string(),
    profiles: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), auditProfileSchema).refine((p) => Object.keys(p).length > 0, "at least one profile"),
  }),
);
