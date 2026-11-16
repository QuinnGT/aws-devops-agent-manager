/**
 * Which incident needs a decision next (pages/audit-detail.md "Review next
 * incident", audit-item.md after the last decision). Pure; unit-tested.
 *
 * Only incidents with proposed findings count. Those with a proposed finding
 * whose failed citation nobody has checked come first, because they need the
 * most care; then the rest, in the Investigations table's order (incident ID,
 * numbers compared as numbers). The incident open now is never chosen.
 */

export interface NextIncidentItem {
  id: string;
  incidentId: string | null;
  taskId: string;
  findings: { proposed: number };
  /** Proposed findings with a failed citation no reviewer has checked */
  flaggedProposed: number;
}

const name = (i: Pick<NextIncidentItem, "incidentId" | "taskId">) => i.incidentId ?? i.taskId;

export function nextIncidentToReview<T extends NextIncidentItem>(items: readonly T[], currentId?: string | null): T | null {
  const open = items.filter((i) => i.findings.proposed > 0 && i.id !== currentId);
  open.sort((a, b) => Number(b.flaggedProposed > 0) - Number(a.flaggedProposed > 0) || name(a).localeCompare(name(b), undefined, { numeric: true }));
  return open[0] ?? null;
}
