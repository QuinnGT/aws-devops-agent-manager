import { failureDetail, rerunCanHelp, reviewFailureKind, reviewFailureText, type ReviewFailureKind } from "@/server/audits/failure";

/**
 * The failed-reviews callout (audit header and incident page): failures
 * grouped by cause, each with one plain sentence, whether a rerun can fix it,
 * and the stored error for a Details disclosure. Pure; unit-tested.
 */

export interface FailedItemLike {
  id: string;
  incidentId: string | null;
  taskId: string;
  stateReason: string | null;
}

export interface FailureGroup {
  kind: ReviewFailureKind;
  /** Incident IDs (or task IDs) in the Investigations table order */
  incidents: string[];
  itemIds: string[];
  /** The plain sentence, without the incident */
  text: string;
  /** A rerun can fix this cause now */
  rerun: boolean;
  /** Stored errors for support, one per incident, never the main text */
  details: { incident: string; reason: string }[];
}

/** "INCIDENT-1", "INCIDENT-1 and INCIDENT-2", "INCIDENT-1, INCIDENT-2 and 3 more". */
export function incidentList(names: readonly string[], max = 3): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= max) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

export function failureGroups(items: readonly FailedItemLike[], o: { canManage: boolean; stepLimit: number; accessWorksNow: boolean }): FailureGroup[] {
  const by = new Map<ReviewFailureKind, FailureGroup>();
  for (const i of items) {
    const kind = reviewFailureKind(i.stateReason);
    const incident = i.incidentId ?? i.taskId;
    const g = by.get(kind) ?? { kind, incidents: [], itemIds: [], text: reviewFailureText(kind, { canManage: o.canManage, stepLimit: o.stepLimit, reason: i.stateReason }), rerun: rerunCanHelp(kind, o.accessWorksNow), details: [] };
    g.incidents.push(incident);
    g.itemIds.push(i.id);
    const d = failureDetail(kind, i.stateReason);
    if (d) g.details.push({ incident, reason: d });
    by.set(kind, g);
  }
  return [...by.values()];
}

/** The callout's closing line: what to do next, from the groups. */
export function failureNextStep(groups: readonly FailureGroup[], canRun: boolean): string | null {
  const rerunnable = groups.filter((g) => g.rerun).reduce((n, g) => n + g.incidents.length, 0);
  const total = groups.reduce((n, g) => n + g.incidents.length, 0);
  if (!total) return null;
  if (rerunnable === total) return canRun ? `Rerun ${total === 1 ? "it" : "them"}, or leave ${total === 1 ? "it" : "them"} out: the report counts only accepted findings.` : "Someone who can run audits can rerun them.";
  if (rerunnable === 0) return "A rerun would fail the same way until that is fixed. The report counts only accepted findings.";
  return canRun ? `Rerun the ${rerunnable === 1 ? "one" : rerunnable} a rerun can fix; the others need the cause fixed first.` : "Someone who can run audits can rerun the ones a rerun can fix.";
}
