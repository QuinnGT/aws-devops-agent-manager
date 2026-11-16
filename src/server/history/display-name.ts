import type { Policy } from "@/server/policy";

/**
 * What the UI calls an asset. asset_index.name and assetDisplayName() stay
 * the identity used for history paths and matching (an instruction file's
 * agent type ID, "GENERIC"); these helpers turn it into words a reader
 * knows. Pure, and safe to import from client components.
 */

type LabelPolicy = Pick<Policy, "agentTypes"> & Partial<Pick<Policy, "historyLayout">>;

export interface LabelInput {
  assetType: string;
  /** The stored name (asset_index.name, a manifest or plan item name) */
  name: string;
  assetId?: string | null;
  metadata?: unknown;
}

function metaString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const v = (metadata as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** "Global", "Incident triage": an agent type's short label from policy, else its ID. */
export function agentTypeLabel(policy: Pick<Policy, "agentTypes">, id: string): string {
  const entry = policy.agentTypes.agentTypes.find((a) => a.id === id);
  return entry ? (entry.shortLabel ?? entry.label) : id;
}

/** The agent type ID of an instruction file: its metadata key, else the stored name. */
export function instructionAgentType(policy: LabelPolicy, a: Pick<LabelInput, "name" | "metadata">): string {
  const key = policy.historyLayout?.nameKeys.agents_md ?? "agent_type";
  return metaString(a.metadata, key) ?? a.name;
}

/**
 * "Global instructions" for the GENERIC instruction file, "<agent type>
 * instructions" for the others, an artifact's metadata.title when its stored
 * name is only its ID, else the stored name.
 */
export function assetLabel(policy: LabelPolicy, a: LabelInput): string {
  if (a.assetType === "agents_md") return `${agentTypeLabel(policy, instructionAgentType(policy, a))} instructions`;
  if (!a.name || (a.assetId && a.name === a.assetId)) return metaString(a.metadata, "title") ?? (a.name || a.assetId || "");
  return a.name;
}

/** The ID-like key to show in mono meta text beside a label, when the label hides it (an agent type ID). */
export function assetLabelKey(policy: LabelPolicy, a: LabelInput): string | null {
  return a.assetType === "agents_md" ? instructionAgentType(policy, a) : null;
}
