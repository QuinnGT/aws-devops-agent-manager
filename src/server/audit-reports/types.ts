import type { Citation } from "@/server/audits/contract";
import type { AuditProfile } from "@/server/policy/sections/audits";

/**
 * Shapes of the audit report. Computed sections are built
 * in code from accepted findings and analyzer output; narrative sections hold
 * text a model drafted and a person edited (stored in audits.report).
 */

export type ReportSectionConfig = AuditProfile["report"]["sections"][number];
export type ReportSectionKind = ReportSectionConfig["kind"];
export type Audience = "internal" | "shareable";
export const AUDIENCES = ["internal", "shareable"] as const satisfies readonly Audience[];

/** An audit item as the report reads it. */
export interface ReportItem {
  id: string;
  taskId: string;
  incidentId: string | null;
  cohort: string | null;
  state: string;
  stateReason: string | null;
  journalSha256: string | null;
  currentReviewId: string | null;
}

/** A finding that counts in the report: accepted, from the current review of an item that was not skipped. */
export interface ReportFinding {
  id: string;
  auditItemId: string;
  reviewId: string;
  taskId: string;
  incidentId: string | null;
  kind: string;
  ordinal: number;
  title: string;
  /** Current values (after a person's edits); untrusted model output */
  values: Record<string, unknown>;
  citations: Citation[];
  edited: boolean;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

/** Latest analyzer output for one investigation. */
export interface ReportAnalyzerRun {
  analyzer: string;
  version: string;
  output: unknown;
  createdAt: string;
}

/** Everything the computed sections read. Pure data; built by the loader. */
export interface ReportInputs {
  profile: AuditProfile;
  items: ReportItem[];
  /** Counted findings only (see ReportFinding) */
  findings: ReportFinding[];
  /** Evidence document fields per incident ID, merged over the current documents */
  evidence: Record<string, Record<string, string | null>>;
  /** Latest analyzer run per task ID and analyzer ID */
  analyzerRuns: Record<string, Record<string, ReportAnalyzerRun>>;
  /** The profile's review output schema (JSON Schema), for the known values of enum fields; null when it can't be read */
  outputSchema: unknown;
}

export interface CountRow {
  /** The field value, or null for findings without one */
  value: string | null;
  label: string;
  count: number;
  /** Listed by the profile (labels, valueLabels or the output schema's enum) */
  known: boolean;
}

export interface CountTableContent {
  type: "count-table";
  findingKind: string;
  field: string;
  header: string;
  /** Findings counted */
  total: number;
  rows: CountRow[];
}

export interface ColumnHead {
  id: string;
  header: string;
}

export interface FindingsTableContent {
  type: "findings-table";
  findingKind: string;
  columns: ColumnHead[];
  rows: { findingId: string; incident: string; title: string; cells: string[] }[];
}

export interface LabeledValue {
  id: string;
  label: string;
  value: string;
}

export interface IncidentBlock {
  incident: string;
  taskId: string;
  findingId: string;
  title: string;
  /** Fields read from the ground-truth documents, e.g. the benchmark score */
  evidence: LabeledValue[];
  /** The diagnosis fields the section shows */
  fields: LabeledValue[];
}

export interface IncidentListContent {
  type: "incident-list";
  findingKind: string;
  incidents: IncidentBlock[];
}

export interface MetricsTableContent {
  type: "metrics-table";
  analyzer: string;
  columns: ColumnHead[];
  rows: { incident: string; taskId: string; analyzerVersion: string | null; cells: (string | null)[]; missing: boolean }[];
  /** Median of each column over the rows with a number, or null when the column has none */
  medians: (string | null)[];
}

export interface NarrativeContent {
  type: "narrative";
  text: string | null;
  source: "model" | "person" | null;
  /** The section names a prompt file, so the model can draft it */
  canDraft: boolean;
  /** Model text: when it was drafted (the findings it read were current then); null otherwise */
  draftedAt: string | null;
  /** Model text a person approved after the latest finding decision: who and when; null otherwise */
  approved: { by: string; at: string } | null;
  /** Model text nobody has approved since the latest finding decision: check it before it is shared */
  needsApproval: boolean;
  /** Model text drafted before the latest finding decision and not approved since */
  draftedBeforeDecisions: boolean;
}

export type ComputedContent = CountTableContent | FindingsTableContent | IncidentListContent | MetricsTableContent;
export type SectionContent = ComputedContent | NarrativeContent;

export interface ReportSectionView {
  id: string;
  title: string;
  kind: ReportSectionKind;
  audience: Audience;
  hidden: boolean;
  /** Narrative text written before the findings last changed */
  stale: boolean;
  /** Who last edited, drafted, hid or showed the section, and when */
  updatedBy: string | null;
  updatedAt: string | null;
  content: SectionContent;
}

/** One export attempt, from the audit log. */
export interface ExportRecord {
  at: string;
  actor: string;
  audience: Audience;
  result: "ok" | "denied" | "error";
  fileName: string | null;
  /** Output rule IDs that refused the export (never the excerpts) */
  ruleIds: string[];
  /** Output-rule matches that refused the export, and the warnings reported with it */
  errorCount?: number;
  warningCount?: number;
}

/** One reason the audit can't be finalized yet, with what a page needs to link to it. */
export interface FinalizeIssue {
  code: "finalized" | "cancelled" | "no-items" | "items-open" | "proposed" | "unapproved-narrative";
  message: string;
  /** Investigations (items-open), findings (proposed) or sections (unapproved-narrative) the issue is about */
  count: number;
  /** Incident names of the open investigations (items-open) */
  incidents: string[];
  /** Shareable narrative sections with model text nobody approved (unapproved-narrative) */
  sections?: { id: string; title: string }[];
}

export interface ReportCounts {
  items: number;
  itemsByState: Record<string, number>;
  findings: { accepted: number; rejected: number; proposed: number };
  acceptedByKind: Record<string, number>;
}

export interface ReportView {
  audit: {
    id: string;
    spaceId: string;
    name: string;
    state: string;
    profileId: string;
    profileLabel: string;
    createdBy: string;
    createdAt: string;
    finalizedCommit: string | null;
    finalizedBy: string | null;
    finalizedAt: string | null;
  };
  title: string;
  /** ReportDraft.builtAt, or null before the report is first built */
  builtAt: string | null;
  /** Latest change to the audit's findings or items */
  inputsChangedAt: string | null;
  /** Findings or items changed after builtAt */
  stale: boolean;
  /** Findings created, decided or edited after builtAt (0 before the first build) */
  changedSinceBuilt: number;
  /** The latest export attempt per audience */
  lastExports: Record<Audience, ExportRecord | null>;
  /** The latest export per audience that produced a file */
  lastSuccessfulExports: Record<Audience, ExportRecord | null>;
  /** A finalized audit's report can't be edited */
  readOnly: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
  counts: ReportCounts;
  finalize: { allowed: boolean; problems: string[]; issues: FinalizeIssue[] };
  sections: ReportSectionView[];
}
