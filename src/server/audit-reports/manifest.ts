import { createHash } from "node:crypto";
import type { ReportDraft } from "@/server/audits/contract";
import type { AuditProfile } from "@/server/policy/sections/audits";
import { compareIncidents, incidentName } from "./sections";
import type { ReportCounts, ReportFinding, ReportItem } from "./types";

/**
 * audit.json and findings.json for the history repository: audit.json holds
 * the profile, journal SHA-256s, analyzer and model versions; findings.json
 * the accepted findings with record citations. The journals themselves stay
 * in Postgres. Pure.
 */

export const AUDIT_MANIFEST_VERSION = 1;

/** JSON with object keys sorted at every level, for digests that don't depend on key order. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface ManifestReview {
  id: string;
  auditItemId: string;
  runner: string;
  modelId: string;
  promptDigest: string;
  state: string;
  schemaValid: boolean | null;
  citationCheck: { checked: number; failed: number; ok: boolean } | null;
  startedAt: Date;
}

export interface ManifestAnalyzerRun {
  taskId: string;
  analyzer: string;
  version: string;
  createdAt: Date;
}

/** The review an item's findings came from: current_review_id, else its latest review. */
export function reviewForItem(item: ReportItem, reviews: ManifestReview[]): ManifestReview | null {
  if (item.currentReviewId) return reviews.find((r) => r.id === item.currentReviewId) ?? null;
  return reviews.filter((r) => r.auditItemId === item.id).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] ?? null;
}

/** Analyzer versions an item's review read: per analyzer of the profile, the latest run made before the review started (the latest run when there is no review). */
export function analyzersForItem(item: ReportItem, review: ManifestReview | null, runs: ManifestAnalyzerRun[], analyzerIds: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of analyzerIds) {
    const candidates = runs
      .filter((r) => r.taskId === item.taskId && r.analyzer === id && (!review || r.createdAt <= review.startedAt))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    if (candidates[0]) out[id] = candidates[0].version;
  }
  return out;
}

const uniqueSorted = (xs: string[]) => [...new Set(xs)].sort();

/** Who wrote a narrative section, and for model text who approved it and when. */
function narrativeRecord(s: ReportDraft["sections"][number] | undefined): Record<string, unknown> {
  const source = s?.narrativeSource ?? null;
  if (source !== "model") return { narrativeSource: source };
  return { narrativeSource: source, draftedAt: s?.draftedAt ?? null, approvedBy: s?.approvedBy ?? null, approvedAt: s?.approvedAt ?? null };
}

export interface AuditManifestInput {
  audit: { id: string; name: string; note: string | null; profileId: string; profileSnapshot: unknown; policyDigest: string; createdBy: string; createdAt: Date };
  spaceAlias: string;
  profile: AuditProfile;
  items: ReportItem[];
  reviews: ManifestReview[];
  analyzerRuns: ManifestAnalyzerRun[];
  counts: ReportCounts;
  draft: ReportDraft | null;
  stale: boolean;
  narrativeModelIds: string[];
  finalizedBy: string;
  finalizedAt: Date;
  files: { auditJson: string; findingsJson: string; reportMd: string };
}

export function buildAuditManifest(m: AuditManifestInput): Record<string, unknown> {
  const items = [...m.items]
    .sort((a, b) => compareIncidents(incidentName(a), incidentName(b)))
    .map((i) => {
      const review = reviewForItem(i, m.reviews);
      return {
        taskId: i.taskId,
        incidentId: i.incidentId,
        cohort: i.cohort,
        state: i.state,
        stateReason: i.stateReason,
        journalSha256: i.journalSha256,
        analyzers: analyzersForItem(i, review, m.analyzerRuns, m.profile.analyzers),
        review: review
          ? { id: review.id, runner: review.runner, modelId: review.modelId, promptDigest: review.promptDigest, state: review.state, schemaValid: review.schemaValid, citationCheck: review.citationCheck }
          : null,
      };
    });
  const analyzers = m.profile.analyzers.map((id) => ({ id, versions: uniqueSorted(items.map((i) => i.analyzers[id]).filter((v): v is string => !!v)) }));
  const used = items.map((i) => i.review).filter((r): r is NonNullable<typeof r> => r !== null);
  const draftSections = new Map((m.draft?.sections ?? []).map((s) => [s.id, s]));
  return {
    manifestVersion: AUDIT_MANIFEST_VERSION,
    auditId: m.audit.id,
    name: m.audit.name,
    note: m.audit.note,
    spaceAlias: m.spaceAlias,
    profile: { id: m.audit.profileId, label: m.profile.label, snapshotSha256: sha256(canonicalJson(m.audit.profileSnapshot)) },
    policyDigest: m.audit.policyDigest,
    createdBy: m.audit.createdBy,
    createdAt: m.audit.createdAt.toISOString(),
    finalizedBy: m.finalizedBy,
    finalizedAt: m.finalizedAt.toISOString(),
    reviews: { runners: uniqueSorted(used.map((r) => r.runner)), modelIds: uniqueSorted(used.map((r) => r.modelId)) },
    narrative: { modelIds: uniqueSorted(m.narrativeModelIds) },
    analyzers,
    counts: m.counts,
    report: {
      title: m.profile.report.title,
      builtAt: m.draft?.builtAt ?? null,
      stale: m.stale,
      sections: m.profile.report.sections.map((s) => ({
        id: s.id,
        kind: s.kind,
        audience: s.audience,
        hidden: draftSections.get(s.id)?.hidden === true,
        ...(s.kind === "narrative" ? narrativeRecord(draftSections.get(s.id)) : {}),
      })),
    },
    files: m.files,
    items,
  };
}

export interface FindingsJsonFinding extends ReportFinding {
  proposed?: Record<string, unknown>;
  reviewNote?: string | null;
}

export function buildFindingsJson(auditId: string, findings: FindingsJsonFinding[]): Record<string, unknown> {
  const sorted = [...findings].sort((a, b) => compareIncidents(incidentName(a), incidentName(b)) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || a.ordinal - b.ordinal);
  return {
    manifestVersion: AUDIT_MANIFEST_VERSION,
    auditId,
    count: sorted.length,
    findings: sorted.map((f) => ({
      id: f.id,
      incidentId: f.incidentId,
      taskId: f.taskId,
      kind: f.kind,
      ordinal: f.ordinal,
      title: f.title,
      values: f.values,
      edited: f.edited,
      ...(f.edited && f.proposed ? { proposed: f.proposed } : {}),
      reviewNote: f.reviewNote ?? null,
      reviewedBy: f.reviewedBy,
      reviewedAt: f.reviewedAt,
      reviewId: f.reviewId,
      citations: f.citations,
    })),
  };
}

export const toFileJson = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
