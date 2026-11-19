import "server-only";
import { cache } from "react";
import { getAnalyzer } from "@/server/analyzers/registry";
import type { AuditViewer } from "@/server/audits/actions";
import { checkBedrock } from "@/server/audits/bedrock-check";
import { reviewFailureKind } from "@/server/audits/failure";
import { loadAuditDetail } from "@/server/audits/loaders";
import { loadedPolicyForSpace } from "@/server/audits/profiles";
import { reviewerView } from "@/server/audits/reviewers";
import { getAudit, profileOf } from "@/server/audits/store";
import { auditEventTimes, auditModels, auditUsage } from "@/server/audits/ui";
import { displayNames } from "@/server/drafts/loaders";
import type { Permission } from "@/server/policy";
import { getHistoryRepoForSpace, type Space } from "@/server/spaces/queries";
import type { AuditHeaderData } from "./audit-header";
import { analyzerWords } from "./words";

/**
 * Request-scoped loads shared by the audit layout and its tab pages, so the
 * header and the Investigations tab read the audit once per request.
 */

export const getAuditCached = cache((spaceId: string, auditId: string) => getAudit(spaceId, auditId));

const detailCached = cache((spaceId: string, auditId: string, perms: string) => loadAuditDetail({ id: spaceId }, auditId, { permissions: perms.split(",") as Permission[] }));

export function auditDetail(spaceId: string, auditId: string, viewer: AuditViewer) {
  const perms = [...(viewer.permissions as Iterable<Permission>)].sort().join(",");
  return detailCached(spaceId, auditId, perms);
}

/**
 * The header's data. When a review failed for missing or expired credentials,
 * the space's Bedrock check runs again as `actorEmail`, so the header offers a
 * rerun only once the connection works.
 */
export const auditHeaderData = cache(async (space: Space, perms: Set<Permission>, auditId: string, actorEmail: string): Promise<AuditHeaderData | null> => {
  const audit = await getAuditCached(space.id, auditId);
  if (!audit) return null;
  const detail = await auditDetail(space.id, auditId, { permissions: perms });
  if (!detail) return null;
  const profile = profileOf(audit);
  const [models, events, usage, repo, loaded] = await Promise.all([
    auditModels(audit),
    auditEventTimes(audit.id, ["audit.start", "audit.cancel"]),
    auditUsage(audit.id),
    audit.state === "finalized" ? getHistoryRepoForSpace(space) : Promise.resolve(null),
    loadedPolicyForSpace(space.id),
  ]);
  const accessFailed = detail.items.some((i) => i.state === "failed" && ["no-credentials", "expired"].includes(reviewFailureKind(i.stateReason)));
  const accessWorksNow = accessFailed && perms.has("audits.run") ? (await checkBedrock(space, { email: actorEmail })).kind === null : false;
  const nameOf = await displayNames([audit.createdBy, events["audit.start"]?.by ?? "", events["audit.cancel"]?.by ?? "", audit.finalizedBy ?? ""].filter(Boolean));
  const labels = new Map<string, string>();
  for (const id of profile.analyzers) {
    try {
      labels.set(id, getAnalyzer(id).label);
    } catch {
      /* unknown analyzer keeps its ID */
    }
  }
  return {
    alias: space.alias,
    detail,
    models,
    reviewer: reviewerView(loaded.policy, profile.review),
    events: { started: events["audit.start"] ?? null, cancelled: events["audit.cancel"] ?? null },
    usage,
    analyzers: { count: profile.analyzers.length, words: analyzerWords(profile.analyzers, labels) },
    stepLimit: profile.review.stepLimit,
    repository: repo?.name ?? null,
    nameOf,
    can: { run: perms.has("audits.run"), review: perms.has("findings.review"), manage: perms.has("spaces.manage") },
    accessWorksNow,
  };
});
