import type { NormBundle } from "@/server/analyzers/normalize";
import type { Actor, SpaceAwsConfig } from "@/server/aws/clients";
import type { AuditProfile } from "@/server/policy/sections/audits";

/**
 * CONTRACT. Shared by the audits, review, audit-reports and revisions modules.
 * Do not change these exported shapes; add optional fields or new exports only.
 *
 *   audits         implements extractFindings in src/server/audits/findings.ts and
 *                  owns the audit lifecycle, inputs, jobs and finding review.
 *   review         implements runReview in src/server/review/index.ts.
 *   audit-reports  implements the report view, export and finalize in src/server/audit-reports/.
 *   revisions      reads accepted, linkable findings through listLinkableFindings (audits).
 */

export type { AuditProfile };

/** Field values of a finding, from the review output (untrusted). */
export type FindingValues = Record<string, unknown>;

/** One record citation in a review, after the check. Record numbers are NormRecord.n (1-based, ascending). */
export interface Citation {
  record: number;
  /** Text the review quotes from the record, if any */
  quote: string | null;
  /** JSON path of the review field that cites it, e.g. "near_miss" or "fixes[0].evidence[1]" */
  field: string;
  /** For entries of a top-level `citations` array: the output key the review says the record supports */
  supports?: string;
  ok: boolean;
  problem?: "missing-record" | "quote-not-found";
  /**
   * A reviewer read the record and says the finding holds anyway. The
   * check's result (`ok: false`, `problem`) is kept as it was; this records who
   * looked, when, and what they found.
   */
  checked?: { by: string; at: string; note: string };
}

/** Result of checking every record a review cites. */
export interface CitationCheck {
  ok: boolean;
  checked: number;
  failed: number;
  citations: Citation[];
}

/** Ground truth handed to the reviewer, from evidence_docs. Untrusted text. */
export interface GroundTruthDoc {
  kind: string;
  label: string;
  fileName: string;
  body: string;
  fields: Record<string, string | null>;
}

/** One model call, persisted to model_calls by the caller. */
export interface ModelCallRecord {
  purpose: "review" | "report-narrative";
  runner: string;
  modelId: string;
  region: string;
  steps: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  error: string | null;
}

export interface ReviewRunInput {
  space: SpaceAwsConfig;
  /** Bedrock region: the space's inference setting, else the space Region */
  region: string;
  /** The user who started the audit (STS source identity for Bedrock calls) */
  actor: Actor;
  profile: AuditProfile;
  /** Policy directories, lowest precedence first (LoadedPolicy.dirs), for readPolicyFile */
  policyDirs: string[];
  incidentId: string | null;
  /** The item's cohort for profiles that compare groups ({ id, label } from profile.cohorts); null otherwise */
  cohort?: { id: string; label: string } | null;
  /** The investigation's normalized records: the only data the review tools can read */
  bundle: NormBundle;
  /** Stored analyzer output for this investigation, by analyzer ID */
  analyzerOutputs: Record<string, unknown>;
  groundTruth: GroundTruthDoc[];
  /** Checked between steps; the run stops early when true */
  cancelled?: () => Promise<boolean>;
}

export interface ReviewRunResult {
  state: "succeeded" | "failed";
  runner: string;
  modelId: string;
  /** SHA-256 over the system prompt, filled prompt and output schema */
  promptDigest: string;
  /** Structured output, or null when the model returned none */
  output: unknown;
  schemaValid: boolean;
  schemaErrors: string[];
  citationCheck: CitationCheck | null;
  steps: number;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  error: string | null;
  /** Every model call made, for model_calls */
  modelCalls: ModelCallRecord[];
}

/** Implemented in src/server/review/index.ts. Never throws for a model failure: returns state "failed". */
export type RunReview = (input: ReviewRunInput, deps?: { model?: unknown }) => Promise<ReviewRunResult>;

/** A finding to insert, produced by extractFindings from one review's output. */
export interface FindingInput {
  kind: string;
  ordinal: number;
  title: string;
  values: FindingValues;
  /** The citations from the review's citation check that belong to this finding */
  citations: Citation[];
}

/** Implemented by audits-core in src/server/audits/findings.ts. Pure. */
export type ExtractFindings = (profile: AuditProfile, output: unknown, ctx: { incidentId: string | null; citationCheck: CitationCheck | null }) => FindingInput[];

/** An accepted finding that a revision may link to (extractor marked linkable). */
export interface LinkableFinding {
  id: string;
  auditId: string;
  auditName: string;
  incidentId: string | null;
  kind: string;
  title: string;
  values: FindingValues;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

/** Report edits stored in audits.report. */
export interface ReportDraft {
  /** When the computed sections were last rebuilt from accepted findings */
  builtAt: string;
  sections: {
    id: string;
    /** Narrative text (markdown) for narrative sections: model draft, then a person's edits */
    narrative?: string | null;
    narrativeSource?: "model" | "person" | null;
    /** A person can leave a section out of every export */
    hidden?: boolean;
    /** Who last changed this section and when (ISO) */
    updatedBy?: string | null;
    updatedAt?: string | null;
    /** Model text: the findings it was drafted from were current at this time (ISO) */
    draftedAt?: string | null;
    /** Model text: the person who checked it and approved it for sharing, and when (ISO) */
    approvedBy?: string | null;
    approvedAt?: string | null;
  }[];
}
