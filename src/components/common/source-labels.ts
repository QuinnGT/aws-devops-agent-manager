import type { ChangeSource } from "@/lib/assets/types";

/**
 * Source label lookup (policy/attribution.yaml `shortLabels` and `labels`).
 * Pure; SourceBadge and the change feed pass in the loaded policy section.
 */

export interface SourceLabelPolicy {
  labels: Record<ChangeSource, string>;
  shortLabels: Record<ChangeSource, string>;
  /** Tooltip sentence per source, shown in place of the principal */
  notes?: Partial<Record<ChangeSource, string>>;
}

/** The role's unique ID that CloudTrail puts in front of some session names ("AROA...-alex-Admin"). */
const ROLE_ID_PREFIX = /^AROA[A-Z0-9]{12,}[-:]/;

/**
 * A principal for display: "AROA<role ID>-alex-Admin" becomes
 * "alex-Admin". Keep the full value in a tooltip; the stored value is unchanged.
 */
export function displayPrincipal(principal: string): string {
  return principal.replace(ROLE_ID_PREFIX, "") || principal;
}

/** Chip text: "DevOps Agent", "Web app", "CLI or SDK", "This app", "Unknown". */
export function shortSourceLabel(source: ChangeSource, p: SourceLabelPolicy): string {
  return p.shortLabels[source] || p.labels[source] || source;
}

/**
 * Long form for tooltips and detail lines. The label recorded with the change
 * (for example a role pattern's "Operator Web App") wins over the policy default,
 * except for the agent, whose recorded label is the policy sentence itself.
 */
export function longSourceLabel(source: ChangeSource, p: SourceLabelPolicy, recorded?: string | null): string {
  if (recorded && source !== "agent" && source !== "unknown") return recorded;
  return p.labels[source] || p.shortLabels[source] || source;
}
