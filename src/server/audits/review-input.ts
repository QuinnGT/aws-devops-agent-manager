import { inferenceRegion } from "@/server/ai/bedrock";
import { normalizeBundle } from "@/server/analyzers/normalize";
import { latestRunsForTask, loadJournalBundle } from "@/server/analyzers/store";
import type { Actor } from "@/server/aws/clients";
import type { LoadedPolicy } from "@/server/policy";
import { toAwsConfig, type Space } from "@/server/spaces/queries";
import type { ReviewRunInput } from "./contract";
import { currentEvidenceDocs, profileOf, type AuditItemRow, type AuditRow } from "./store";

/**
 * What a review of one audit item reads: its journal, the stored analyzer
 * output and the ground truth, built the same way for a model review (run.ts)
 * and for review files (handoff.ts). Returns null when the journal is not in the
 * journal cache. The item's own investigation is the only journal read.
 */
export async function buildReviewInput(args: {
  audit: AuditRow;
  item: AuditItemRow;
  space: Space;
  loaded: Pick<LoadedPolicy, "dirs">;
  actor: Actor;
  cancelled?: () => Promise<boolean>;
}): Promise<ReviewRunInput | null> {
  const { audit, item, space, loaded } = args;
  const profile = profileOf(audit);
  const bundle = await loadJournalBundle(space.id, item.taskId);
  if (!bundle) return null;
  const norm = normalizeBundle(bundle);
  const runs = await latestRunsForTask(space.id, item.taskId);
  const analyzerOutputs = Object.fromEntries(runs.filter((r) => profile.analyzers.includes(r.analyzer)).map((r) => [r.analyzer, r.output]));
  const docs = item.incidentId
    ? await currentEvidenceDocs(
        space.id,
        [item.incidentId],
        profile.inputs.map((i) => i.kind),
      )
    : [];
  const groundTruth = docs.map((d) => ({
    kind: d.kind,
    label: profile.inputs.find((i) => i.kind === d.kind)?.label ?? d.kind,
    fileName: d.fileName,
    body: d.body,
    fields: d.fields,
  }));
  return {
    space: toAwsConfig(space),
    region: inferenceRegion(space, space.parsedSettings),
    actor: args.actor,
    profile,
    policyDirs: loaded.dirs,
    incidentId: item.incidentId,
    cohort: item.cohort ? { id: item.cohort, label: profile.cohorts.find((c) => c.id === item.cohort)?.label ?? item.cohort } : null,
    bundle: norm,
    analyzerOutputs,
    groundTruth,
    ...(args.cancelled ? { cancelled: args.cancelled } : {}),
  };
}
