import type { AuditProfile } from "@/server/policy/sections/audits";

/**
 * Whether an audit item can run. Pure. An item is
 * ready when its journal is in the cache and every required ground-truth
 * document of the profile is stored for its incident.
 */

export interface ItemReadiness {
  itemId: string;
  taskId: string;
  incidentId: string | null;
  journalPresent: boolean;
  /** Required inputs with no current document for the incident */
  missing: { kind: string; label: string }[];
  /** Optional inputs that are present, for the page */
  present: { kind: string; label: string }[];
  ready: boolean;
  /** Why the item is not ready, in words; null when ready */
  reason: string | null;
}

export function itemReadiness(
  item: { id: string; taskId: string; incidentId: string | null },
  ctx: { journalPresent: boolean; docKinds: ReadonlySet<string> },
  profile: Pick<AuditProfile, "inputs">,
): ItemReadiness {
  const required = profile.inputs.filter((i) => i.required);
  const missing = required.filter((i) => !ctx.docKinds.has(i.kind)).map((i) => ({ kind: i.kind, label: i.label }));
  const present = profile.inputs.filter((i) => ctx.docKinds.has(i.kind)).map((i) => ({ kind: i.kind, label: i.label }));
  const reasons: string[] = [];
  if (!ctx.journalPresent) reasons.push("The journal is not in the journal cache.");
  if (missing.length) {
    reasons.push(
      item.incidentId
        ? `Missing ${missing.map((m) => m.label).join(" and ")}.`
        : `The investigation has no incident ID, so its ${missing.map((m) => m.label).join(" and ")} can't be matched.`,
    );
  }
  return {
    itemId: item.id,
    taskId: item.taskId,
    incidentId: item.incidentId,
    journalPresent: ctx.journalPresent,
    missing,
    present,
    ready: reasons.length === 0,
    reason: reasons.length ? reasons.join(" ") : null,
  };
}

export interface ReadinessSummary {
  total: number;
  ready: number;
  notReady: number;
  missingJournal: number;
  /** Required inputs by kind: how many items lack each */
  missingByKind: { kind: string; label: string; items: number }[];
}

export function summarizeReadiness(items: readonly ItemReadiness[], profile: Pick<AuditProfile, "inputs">): ReadinessSummary {
  return {
    total: items.length,
    ready: items.filter((i) => i.ready).length,
    notReady: items.filter((i) => !i.ready).length,
    missingJournal: items.filter((i) => !i.journalPresent).length,
    missingByKind: profile.inputs
      .filter((i) => i.required)
      .map((i) => ({ kind: i.kind, label: i.label, items: items.filter((r) => r.missing.some((m) => m.kind === i.kind)).length })),
  };
}
