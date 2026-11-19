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

/**
 * Who writes each review. "ai-sdk": a model in Amazon Bedrock, through the AI SDK, with
 * tools over the records. "handoff": review files a person runs with an agent of their
 * choice and imports back. "devops-agent-chat": a DevOps Agent chat in the space, with
 * the review files attached. The audit's choice is stored in its profile snapshot.
 */
export const REVIEW_RUNNERS = ["ai-sdk", "handoff", "devops-agent-chat"] as const;
export type ReviewRunner = (typeof REVIEW_RUNNERS)[number];

/** A choice the app offers for a runner, for example the chat's model tier. */
const runnerOption = z.object({
  label: z.string(),
  description: z.string().default(""),
  default: z.string(),
  values: z.array(labeled).min(1),
});

/** How a runner is shown on the audit form, and the options it offers. */
const runnerEntry = z
  .object({
    label: z.string(),
    description: z.string().default(""),
    options: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/), runnerOption).default({}),
  })
  .refine((r) => Object.values(r.options).every((o) => o.values.some((v) => v.id === o.default)), "each option's default must be one of its values");

/** Settings for reviews written from files (hand-off and chat): every record in one file instead of tools. */
const filesReviewConfig = z.object({
  /** Reviewer system prompt for a review that reads records.md instead of calling tools */
  systemPrompt: policyPath.optional(),
  /** Text for {{record_access}} in the brief when the review reads records.md */
  recordAccessPrompt: policyPath.optional(),
  /** Longest record text in records.md, in characters; longer records are cut with a note */
  recordCharsCap: z.number().int().positive().optional(),
});

const reviewConfig = z.object({
  /** The profile's default runner; the audit form can choose another */
  runner: z.enum(REVIEW_RUNNERS).default("ai-sdk"),
  /** The chosen runner's option values (see reviewers.<runner>.options), set in the app */
  runnerOptions: z.record(z.string(), z.string()).optional(),
  /** Text for {{record_access}} in the brief when the review uses tools */
  recordAccessPrompt: policyPath.optional(),
  /** Reviews written from files: hand-off and chat */
  files: filesReviewConfig.optional(),
  /** Reviews run as a DevOps Agent chat in the space (runner "devops-agent-chat") */
  chat: z
    .object({
      /** Message sent to the chat: the reviewer system prompt, the output schema and the reply rules ({{placeholders}} filled by the app) */
      messageTemplate: policyPath.optional(),
      /** Message sent in the same chat when the first reply is not a JSON object */
      repairPrompt: policyPath.optional(),
      /** Longest message the chat accepts, in characters (the service refuses more) */
      messageCharsCap: z.number().int().positive().optional(),
      /** Largest total size of the attached review files, in bytes; a larger review fails before any call */
      attachmentBytesCap: z.number().int().positive().optional(),
      /**
       * Start of the file name of each attached review file. The sync leaves attachments with this
       * start out of history (sync.yaml ignoredAttachmentPrefixes), so keep the two in step.
       */
      attachmentPrefix: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/)
        .optional(),
      /** Seconds between checks whether the audit was cancelled while the chat answers */
      cancelCheckSeconds: z.number().min(0).optional(),
    })
    .optional(),
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

const MIB = 1024 * 1024;

/**
 * Hand-off audits (runner "handoff"): the review files written for each investigation
 * and the limits on the reviews imported back. Every size is a cap, so an upload that is
 * too large or unpacks to too much is refused before it is read.
 */
const handoffConfig = z.object({
  /** Text written beside each investigation's review files; {{placeholders}} are filled in */
  readme: policyPath.default("prompts/handoff-readme.md"),
  import: z
    .object({
      /** Largest upload, a zip or one review file, in bytes */
      maxUploadBytes: z.number().int().positive().default(25 * MIB),
      /** Most entries in an uploaded zip */
      maxZipEntries: z.number().int().positive().default(2000),
      /** Largest file inside an uploaded zip, in bytes (a zip of the review folders holds records.md beside review.json) */
      maxEntryBytes: z.number().int().positive().default(16 * MIB),
      /** Largest total of an uploaded zip's files once unzipped, in bytes */
      maxUncompressedBytes: z.number().int().positive().default(512 * MIB),
      /** Largest review.json or manifest.json, in bytes */
      maxReviewBytes: z.number().int().positive().default(2 * MIB),
      /** Longest reviewer label, in characters */
      maxLabelChars: z.number().int().positive().default(80),
    })
    .prefault({}),
});

export const auditsSection = defineSection(
  "audits.yaml",
  z.object({
    /** Most investigations in one audit */
    maxItemsPerAudit: z.number().int().positive().default(500),
    /** Largest ground-truth upload (one zip or several files), in bytes */
    maxEvidenceUploadBytes: z.number().int().positive().default(50 * 1024 * 1024),
    /** Default profile for a new audit */
    defaultProfile: z.string(),
    /** The review runners the audit form offers, with their labels and options; a runner left out is not offered */
    reviewers: z
      .object({ "ai-sdk": runnerEntry.optional(), handoff: runnerEntry.optional(), "devops-agent-chat": runnerEntry.optional() } satisfies Record<ReviewRunner, unknown>)
      .default({}),
    profiles: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), auditProfileSchema).refine((p) => Object.keys(p).length > 0, "at least one profile"),
    /** Review files and review import for hand-off audits */
    handoff: handoffConfig.prefault({}),
  }),
);
