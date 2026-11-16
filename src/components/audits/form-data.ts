import "server-only";
import { formatTime } from "@/components/common/time-format";
import { getViewerZone } from "@/components/common/viewer-zone";
import { inferenceRegion } from "@/server/ai/bedrock";
import { getAnalyzer } from "@/server/analyzers/registry";
import { getSyncState } from "@/server/assets/queries";
import type { Actor } from "@/server/aws/clients";
import { checkBedrock } from "@/server/audits/bedrock-check";
import { loadedPolicyForSpace } from "@/server/audits/profiles";
import { profileOf, readinessOf, type AuditRow } from "@/server/audits/store";
import { auditModels, defaultModels, loadDraftEvidence } from "@/server/audits/ui";
import { displayNames } from "@/server/drafts/loaders";
import { investigationFacets } from "@/server/journals/queries";
import type { Permission } from "@/server/policy";
import type { AuditProfile } from "@/server/policy/sections/audits";
import { listReleases } from "@/server/releases/queries";
import { connectionView } from "@/server/spaces/connection-state";
import type { Space } from "@/server/spaces/queries";
import type { AuditFormProps, DraftFormView, ProfileFormOption } from "./audit-form";
import { analyzerWords, formatAccount, profileNeeds } from "./words";

function analyzerLabels(ids: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const id of ids) {
    try {
      m.set(id, getAnalyzer(id).label);
    } catch {
      /* an analyzer the registry doesn't know keeps its ID */
    }
  }
  return m;
}

function profileOption(id: string, p: AuditProfile, isDefault: boolean, settings: Space["parsedSettings"]): ProfileFormOption {
  const d = defaultModels(p, settings);
  return {
    id,
    label: p.label,
    description: p.description,
    isDefault,
    needs: profileNeeds(p),
    incidentIdTemplate: p.incidentIdTemplate,
    inputs: p.inputs.map((i) => ({ kind: i.kind, label: i.label, required: i.required, example: i.fileNameExample ?? null, hasFields: Object.keys(i.fields).length > 0 })),
    cohorts: p.cohorts.map((c) => ({ id: c.id, label: c.label })),
    analyzers: { count: p.analyzers.length, words: analyzerWords(p.analyzers, analyzerLabels(p.analyzers)) },
    concurrency: p.review.concurrency,
    stepLimit: p.review.stepLimit,
    defaultReview: { id: d.review.id, sourceLabel: d.review.sourceLabel },
    defaultReport: { id: d.report.source === "review-model" ? null : d.report.id, sourceLabel: d.report.sourceLabel },
  };
}

/**
 * Everything New audit and a draft need (pages/audit-new.md, "Data"), with
 * the Bedrock check for the Readiness card: the model catalogue for the
 * space's inference Region, read as `actor` (cached by the catalogue).
 */
export async function auditFormProps(space: Space, perms: Set<Permission>, audit: AuditRow | null, actor: Actor): Promise<Omit<AuditFormProps, "connectionNextStep">> {
  const loaded = await loadedPolicyForSpace(space.id);
  const zone = await getViewerZone();
  const [facets, releases, sync, bedrock] = await Promise.all([investigationFacets(space.id), listReleases(space.id), getSyncState(space.id), checkBedrock(space, actor)]);
  const a = loaded.policy.audits;
  let profiles = Object.entries(a.profiles).map(([id, p]) => profileOption(id, p, id === a.defaultProfile, space.parsedSettings));

  let draft: DraftFormView | null = null;
  if (audit) {
    const snapshot = profileOf(audit);
    // A draft shows the profile it was saved with, even if the policy changed since.
    profiles = profiles.map((p) => (p.id === audit.profileId ? { ...profileOption(audit.profileId, snapshot, p.isDefault, space.parsedSettings), defaultReview: p.defaultReview, defaultReport: p.defaultReport } : p));
    if (!profiles.some((p) => p.id === audit.profileId)) profiles.push(profileOption(audit.profileId, snapshot, false, space.parsedSettings));
    const [rows, models] = await Promise.all([loadDraftEvidence(space.id, audit), auditModels(audit)]);
    const readiness = await readinessOf(
      space.id,
      rows.map((r) => ({ id: r.itemId, taskId: r.taskId, incidentId: r.incidentId })),
      snapshot,
    );
    const readyBy = new Map(readiness.map((r) => [r.itemId, r.ready]));
    const nameOf = await displayNames(rows.flatMap((r) => r.inputs.flatMap((i) => (i.doc ? [i.doc.uploadedBy] : []))));
    const names: Record<string, string> = {};
    for (const r of rows) for (const i of r.inputs) if (i.doc) names[i.doc.uploadedBy] = nameOf(i.doc.uploadedBy);
    draft = {
      id: audit.id,
      name: audit.name,
      profileId: audit.profileId,
      reviewModelId: models.review.source === "audit" ? (models.review.id ?? "") : "",
      reportModelId: models.report.source === "audit" ? (models.report.id ?? "") : "",
      reviewModel: models.review.id,
      names,
      items: rows.map((r) => ({
        itemId: r.itemId,
        taskId: r.taskId,
        incidentId: r.incidentId,
        title: r.title,
        cohort: r.cohort,
        cohortLabel: r.cohort ? (snapshot.cohorts.find((c) => c.id === r.cohort)?.label ?? r.cohort) : null,
        journalPresent: r.journalPresent,
        ready: readyBy.get(r.itemId) ?? false,
        inputs: r.inputs.map((i) => ({
          ...i,
          doc: i.doc ? { ...i.doc, uploadedAt: i.doc.uploadedAt.toISOString(), uploadedAtText: formatTime(i.doc.uploadedAt, "datetime", zone) } : null,
        })),
      })),
    };
  }

  const region = inferenceRegion(space, space.parsedSettings);
  return {
    alias: space.alias,
    profiles,
    draft,
    statuses: facets.statuses,
    releases: releases
      .slice()
      .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())
      .slice(0, 20)
      .map((r) => ({ name: r.name, at: r.createdAt.toISOString(), atText: formatTime(r.createdAt, "datetime", zone) })),
    runsIn: `This space's AWS account, ${formatAccount(space.accountId)}, through its read role. Inference runs in ${region} and is billed to that account.`,
    maxUploadMb: Math.floor(a.maxEvidenceUploadBytes / 1048576),
    canExportJournals: perms.has("journals.export"),
    canManageSpace: perms.has("spaces.manage"),
    connectionFailed: !!connectionView(space, sync).failedBy,
    bedrock: { kind: bedrock.kind, region: bedrock.region, detail: bedrock.catalog?.errorDetail ?? null },
    catalog: bedrock.catalog,
  };
}
