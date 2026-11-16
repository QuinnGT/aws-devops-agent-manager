import { z } from "zod";
import { defineSection } from "./define";

/**
 * Journal export, import and markdown rendering.
 *
 * Markdown templates live in `templatesDir` (relative to a policy directory).
 * They are logic-less: `{{path}}` placeholders with an optional filter chain
 * (`{{part.input|json-ascii}}`), no conditionals, loops or code. See
 * src/server/journals/templates/engine.ts for the placeholder and filter list.
 */

const recordTypeName = z.string().regex(/^[A-Za-z0-9_-]+$/, "record types use letters, digits, '_' and '-'");

export const journalsSection = defineSection(
  "journals.yaml",
  z.object({
    /** Investigations walked in parallel during an export */
    exportConcurrency: z.number().int().min(1).max(16).default(3),
    /** Executions of one investigation walked in parallel */
    executionConcurrency: z.number().int().min(1).max(8).default(2),
    /** Export zip files are deleted this many days after they are created */
    exportRetentionDays: z.number().int().min(1).default(14),
    /** Cron (UTC) for the job that deletes expired export files */
    expireCron: z.string().default("17 3 * * *"),
    /**
     * Execution statuses after which no more records are written. A cached
     * execution in one of these states, with an unchanged updatedAt, is not fetched again.
     */
    terminalExecutionStatuses: z.array(z.string()).default(["STOPPED", "FAILED", "CANCELED", "TIMED_OUT"]),

    /** Directory (relative to the policy dir) holding the markdown templates */
    templatesDir: z.string().default("journal-templates"),
    /** Whole-document template; `{{records}}` is replaced by the rendered records */
    documentTemplate: z.string().default("_document.md"),
    /** Frame around each record; `{{body}}` is replaced by the record's body template */
    recordTemplate: z.string().default("_record.md"),
    /**
     * Body template used when no per-type template exists. Lookup order for a record:
     * `<type>.<kind>.md`, `<type>.md`, `_default.<kind>.md`, then this file.
     * `kind` is `json`, `text` or `markdown` (see RecordContent).
     */
    fallbackTemplate: z.string().default("_default.md"),
    /** Message content parts use `_part.<partType>.md`, then this file */
    fallbackPartTemplate: z.string().default("_part.default.md"),

    markdown: z
      .object({
        /** Record order in the markdown file. The record-created exports are newest first. */
        order: z.enum(["asc", "desc"]).default("desc"),
        /** Record types left out of the markdown (they stay in the raw JSON) */
        skipRecordTypes: z.array(recordTypeName).default(["utilization", "investigation_summary", "mitigation_summary"]),
        /** Joins the rendered parts of one message record (`{{parts}}`) */
        partSeparator: z.string().default("\n\n"),
        /** Appended by the `truncate` filter; `{{total}}` is the full length in characters */
        truncationNotice: z.string().default("\n... (truncated, {{total}} total chars)"),
        /** Markdown file name inside the zip; `{{name}}` is the incident ID, or the task ID */
        fileName: z.string().default("{{name}}-journal.md"),
        /** Raw JSON file name inside the zip */
        rawFileName: z.string().default("{{name}}.json"),
      })
      .prefault({}),

    /**
     * Rendering of `ui_investigation_summary` trees (the `ui-tree` filter):
     * each node that has text becomes one block, in document order.
     */
    uiTree: z
      .object({
        separator: z.string().default("\n\n"),
        /** Per node type; placeholders: `{{text}}`, `{{type}}`, `{{props.<name>}}` */
        nodes: z.record(z.string(), z.string()).default({
          title: "{{props.level|hashes}} {{text}}",
          "card-title": "### {{text}}",
          badge: "[{{text}}]",
          "list-item": "- {{text}}",
        }),
        default: z.string().default("{{text}}"),
      })
      .prefault({}),

    /** Choices offered by the export form. The API accepts other values too. */
    selection: z
      .object({
        taskTypes: z.array(z.string()).default(["INVESTIGATION", "EVALUATION", "RELEASE_READINESS_REVIEW", "RELEASE_TESTING", "SYSTEM_LEARNING"]),
        statuses: z
          .array(z.string())
          .default([
            "COMPLETED",
            "IN_PROGRESS",
            "FAILED",
            "TIMED_OUT",
            "CANCELED",
            "SKIPPED",
            "LINKED",
            "WAITING",
            "PENDING_START",
            "PENDING_TRIAGE",
            "PENDING_CUSTOMER_APPROVAL",
          ]),
        priorities: z.array(z.string()).default(["CRITICAL", "HIGH", "MEDIUM", "LOW", "MINIMAL"]),
        /** Most task IDs or incident IDs accepted in one export */
        maxIds: z.number().int().min(1).max(5000).default(500),
      })
      .prefault({}),

    import: z
      .object({
        /** Largest upload accepted (bytes). Keep at or below the Server Action body limit in next.config.ts. */
        maxUploadBytes: z.number().int().min(1).default(50 * 1024 * 1024),
        /** Zip limits, checked before anything is decompressed and again while reading */
        maxZipEntries: z.number().int().min(1).default(5000),
        maxUncompressedBytes: z.number().int().min(1).default(1024 * 1024 * 1024),
        maxEntryBytes: z.number().int().min(1).default(64 * 1024 * 1024),
        /** Markdown files inside a zip that are journals (glob on the file name) */
        journalFilePatterns: z.array(z.string()).default(["*_full_journal.md", "*-journal.md"]),
        /** Files kept as ground truth for audits; listed in the report, not imported */
        groundTruthFilePatterns: z.array(z.string()).default(["*_actual_rca.md", "*_scorecard.md"]),
        /** Regex on the file path that yields an incident ID hint (first group, or the named group `id`) */
        incidentIdFromPath: z.string().default("(INCIDENT-\\d+)"),
      })
      .prefault({}),

    ui: z
      .object({
        investigationsPageSize: z.number().int().min(5).max(500).default(50),
        recordsPageSize: z.number().int().min(5).max(500).default(50),
        /** Record types whose rendered body is shown as markdown next to the raw JSON */
        renderedRecordTypes: z.array(recordTypeName).default(["message", "ui_investigation_summary", "finding", "symptom"]),
        /** Plain-text records whose type matches one of these globs are shown as markdown; other text is shown as-is */
        markdownTextRecordTypes: z.array(z.string()).default(["*_md"]),
        /** Longest raw record shown on the page (characters); the export has the full record */
        maxRawChars: z.number().int().min(1000).default(200_000),
      })
      .prefault({}),
  }),
);
