import { fillTemplate } from "@/server/history/layout";
import { planItemsFromAnalysis, type Analysis } from "@/server/package-io/analyze";
import type { CreatePlanInput, PlanItemInput } from "@/server/plans/contract";
import type { Policy } from "@/server/policy";
import type { ChangelogChange, ChangelogFinding } from "./changelog";
import { conflictSentence, leftAloneSentences, type PlannedAsset, type RevisionScope } from "./scope";

/**
 * The plan a revision becomes: the assets the revision changed against its
 * base (scope.ts), mapped against the live space with the package import
 * mapping (package-io analyzeImport), origin { kind: "revision" }, the policy
 * title and a prefilled reason that names the changes and the findings they
 * link. Pure.
 */

export interface RevisionPlanArgs {
  policy: Pick<Policy, "revisions" | "plans">;
  spaceId: string;
  spaceAlias: string;
  revision: { id: string; name: string };
  analysis: Pick<Analysis, "desired" | "results" | "summary"> & { check?: Pick<Analysis["check"], "results"> };
  /** Changes, oldest first */
  changes: readonly Pick<ChangelogChange, "message" | "findingIds">[];
  findings: ReadonlyMap<string, Pick<ChangelogFinding, "id" | "title" | "auditName" | "incidentId">>;
  /** Which assets the revision changed (scope.ts); null or missing: plan every create and update */
  scope?: RevisionScope | null;
  /** The revision's base, for the notes ("after v1.2") */
  base?: { kind: "live" | "release"; name?: string | null };
}

/** "INCIDENT-31495: anchored on a precedent (Late October audit)" */
export function findingLabel(f: Pick<ChangelogFinding, "title" | "auditName">): string {
  return `${f.title} (${f.auditName})`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…` : s;
}

/** The prefilled change reason: the change messages and every linked finding, within the plan reason limit. */
export function revisionPlanReason(args: Pick<RevisionPlanArgs, "policy" | "revision" | "changes" | "findings">): string {
  const cfg = args.policy.revisions.plan;
  const ids = [...new Set(args.changes.flatMap((c) => c.findingIds))];
  const labels = ids.map((id) => args.findings.get(id)).filter((f): f is NonNullable<typeof f> => Boolean(f)).map(findingLabel);
  const changes = args.changes.map((c) => c.message.replace(/\s+/g, " ").trim().replace(/\.$/, "")).filter(Boolean);
  const text = fillTemplate(cfg.reason, {
    name: args.revision.name,
    changes: changes.length ? changes.join("; ") : args.revision.name,
    findings: labels.length ? labels.join("; ") : cfg.noFindings,
  });
  return truncate(text.replace(/\.\.+$/, "."), args.policy.plans.limits.reasonMaxChars);
}

export function revisionPlanTitle(policy: Pick<Policy, "revisions" | "plans">, name: string, spaceAlias: string): string {
  return truncate(fillTemplate(policy.revisions.plan.title, { name, spaceAlias }), policy.plans.limits.titleMaxChars);
}

/** Plan notes name at most this many assets left as they are live; one more line counts the rest. */
export const MAX_LEFT_ALONE_NOTES = 10;

/**
 * createPlan input for a revision. With a scope (the normal case), the items
 * are the assets the revision changed against its base, each with the base
 * version so the plan check flags an asset that also moved live; assets that
 * differ only because the live space changed after the base are left out and
 * named in the notes. Without one, every create and update item of the
 * analysis. Unchanged assets are always left out.
 */
export function revisionPlanInput(args: RevisionPlanArgs): CreatePlanInput {
  const counts = args.analysis.summary.counts;
  const scope = args.scope ?? null;
  const base = args.base ?? { kind: "live" as const };
  const items = scope ? scope.planned.map((p) => scopedItem(args.analysis, p, base)) : planItemsFromAnalysis(args.analysis);
  const notes: string[] = [];
  if (counts.unchanged) notes.push(`${counts.unchanged} ${counts.unchanged === 1 ? "asset in the revision already matches" : "assets in the revision already match"} the space and ${counts.unchanged === 1 ? "is" : "are"} left out.`);
  if (scope) {
    notes.push(...leftAloneSentences(scope.leftAlone, base, "this plan", MAX_LEFT_ALONE_NOTES));
    for (const p of scope.planned) {
      const s = conflictSentence(p, base, "this plan");
      if (s) notes.push(s);
    }
  }
  if (counts.untouched) notes.push(`${counts.untouched} live ${counts.untouched === 1 ? "asset is" : "assets are"} not in the revision and ${counts.untouched === 1 ? "stays" : "stay"} as ${counts.untouched === 1 ? "it is" : "they are"}.`);
  return {
    spaceId: args.spaceId,
    title: revisionPlanTitle(args.policy, args.revision.name, args.spaceAlias),
    origin: { kind: "revision", revisionId: args.revision.id, name: args.revision.name },
    items,
    reason: revisionPlanReason(args),
    notes,
  };
}

/** The plan item of a planned asset: the analysis's item, with the base version and the conflict in its note. */
function scopedItem(analysis: RevisionPlanArgs["analysis"], p: PlannedAsset, base: { kind: "live" | "release"; name?: string | null }): PlanItemInput {
  const [item] = planItemsFromAnalysis({ desired: [analysis.desired[p.index]!], results: { ...analysis.results, items: [analysis.results.items[p.index]!] }, check: analysis.check });
  const conflict = conflictSentence(p, base, "this plan");
  return {
    ...item!,
    baseVersion: p.base?.version ?? null,
    baseUpdatedAt: p.base?.updatedAt ?? null,
    ...(conflict ? { note: item!.note ? `${conflict} ${item!.note}` : conflict } : {}),
  };
}
