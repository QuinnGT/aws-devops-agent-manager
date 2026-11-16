import type { Policy } from "@/server/policy";
import { ASSET_ID_PATTERN, SKILL_KEYS } from "./config";
import { displayValues } from "./frontmatter";

/**
 * View models for the asset browser: type tabs, Managed labels, instruction
 * slots per agent type, skill fields and custom agent references. Pure; the
 * caller supplies policy, index rows and live results.
 */

type AssetTypesPolicy = Policy["assetTypes"]["assetTypes"];

// ---------- asset type tabs ----------

export interface LiveAssetType {
  assetType: string;
  description?: string | null;
}

export interface AssetTypeTab {
  assetType: string;
  label: string;
  description: string | null;
  count: number;
  /** Has an entry in policy/asset-types.yaml */
  inPolicy: boolean;
}

/**
 * Tabs from ListAssetTypes when it answered, else from policy. Known types keep
 * policy order; types the service returns that policy doesn't know follow in
 * name order; indexed types missing from both are appended so no asset is hidden.
 */
export function resolveAssetTypeTabs(
  live: readonly LiveAssetType[] | null,
  policyTypes: AssetTypesPolicy,
  counts: Readonly<Record<string, number>>,
): { tabs: AssetTypeTab[]; source: "live" | "policy" } {
  const policyOrder = Object.keys(policyTypes);
  const liveMap = new Map((live ?? []).map((t) => [t.assetType, t.description ?? null]));
  const ids = live ? [...liveMap.keys()] : [...policyOrder];
  for (const t of Object.keys(counts)) if ((counts[t] ?? 0) > 0 && !ids.includes(t)) ids.push(t);
  const rank = (id: string) => {
    const i = policyOrder.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const tabs = ids.map((id) => ({
    assetType: id,
    label: policyTypes[id]?.label ?? id,
    description: liveMap.get(id) ?? null,
    count: counts[id] ?? 0,
    inPolicy: id in policyTypes,
  }));
  return { tabs, source: live ? "live" : "policy" };
}

// ---------- metadata helpers ----------

export function metaString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const v = (metadata as Record<string, unknown>)[key];
  return typeof v === "string" && v ? v : null;
}

export function metaList(metadata: unknown, key: string): string[] {
  if (!metadata || typeof metadata !== "object") return [];
  return displayValues((metadata as Record<string, unknown>)[key]);
}

export function assetStatus(metadata: unknown): string | null {
  return metaString(metadata, SKILL_KEYS.status);
}

// ---------- Managed labels ----------

export interface IndexedAssetLike {
  assetId: string;
  assetType: string;
  name: string;
  parentAssetId: string | null;
  metadata?: unknown;
}

export type ManagedLabel = { managed: false } | { managed: true; via: "self" | "store"; storeName?: string };

/**
 * Managed per policy assetTypes.<type>.managedNames. A memory is labeled when
 * its store is managed, because the service owns those stores' memories.
 */
export function managedLabel(
  policyTypes: AssetTypesPolicy,
  asset: IndexedAssetLike,
  storeById: ReadonlyMap<string, { name: string; assetType: string }>,
): ManagedLabel {
  if (policyTypes[asset.assetType]?.managedNames.includes(asset.name)) return { managed: true, via: "self" };
  if (asset.parentAssetId) {
    const store = storeById.get(asset.parentAssetId);
    if (store && policyTypes[store.assetType]?.managedNames.includes(store.name)) {
      return { managed: true, via: "store", storeName: store.name };
    }
  }
  return { managed: false };
}

// ---------- instructions per agent type ----------

export interface InstructionSlot<T> {
  agentType: string;
  label: string;
  primary: boolean;
  /** Policy lists this agent type */
  inPolicy: boolean;
  assets: T[];
}

/**
 * One slot per agent type, primary (GENERIC) first, then policy order, then
 * agent types found on assets that policy doesn't list.
 */
export function instructionSlots<T extends { metadata?: unknown; assetId: string }>(
  agentTypes: Policy["agentTypes"]["agentTypes"],
  assets: readonly T[],
  agentTypeKey = "agent_type",
): InstructionSlot<T>[] {
  const ordered = [...agentTypes.filter((a) => a.primary), ...agentTypes.filter((a) => !a.primary)];
  const slots: InstructionSlot<T>[] = ordered.map((a) => ({ agentType: a.id, label: a.label, primary: a.primary, inPolicy: true, assets: [] }));
  const byId = new Map(slots.map((s) => [s.agentType, s]));
  for (const asset of assets) {
    const at = metaString(asset.metadata, agentTypeKey) ?? "(none)";
    let slot = byId.get(at);
    if (!slot) {
      slot = { agentType: at, label: at, primary: false, inPolicy: false, assets: [] };
      byId.set(at, slot);
      slots.push(slot);
    }
    slot.assets.push(asset);
  }
  return slots;
}

// ---------- custom agent references ----------

export interface AssetRef {
  /** Metadata key path where the ID was found, e.g. "skills" or "memory.store_ids" */
  key: string;
  assetId: string;
  name: string | null;
  assetType: string | null;
  deleted: boolean;
}

/**
 * Asset IDs referenced from a custom agent's metadata, resolved to names
 * through asset_index. The metadata keys are not hardcoded: any string that is
 * a known asset ID, or looks like one, is a reference.
 */
export function collectAssetReferences(
  metadata: unknown,
  index: ReadonlyMap<string, { name: string; assetType: string; deletedAt?: Date | string | null }>,
  selfId?: string,
): AssetRef[] {
  const out: AssetRef[] = [];
  const seen = new Set<string>();
  const visit = (v: unknown, key: string, depth: number) => {
    if (depth > 6 || v === null || v === undefined) return;
    if (typeof v === "string") {
      const id = v.trim();
      if (id === selfId || !(index.has(id) || ASSET_ID_PATTERN.test(id))) return;
      const dedupe = `${key}|${id}`;
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      const hit = index.get(id);
      out.push({ key, assetId: id, name: hit?.name ?? null, assetType: hit?.assetType ?? null, deleted: Boolean(hit?.deletedAt) });
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x, key, depth + 1);
      return;
    }
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) visit(x, key ? `${key}.${k}` : k, depth + 1);
    }
  };
  visit(metadata, "", 0);
  return out;
}

/** Group references by asset type for display ("skill", "memory_store", then others, unknown last). */
export function groupReferences(refs: readonly AssetRef[]): { assetType: string | null; refs: AssetRef[] }[] {
  const groups = new Map<string | null, AssetRef[]>();
  for (const r of refs) {
    const g = groups.get(r.assetType) ?? [];
    g.push(r);
    groups.set(r.assetType, g);
  }
  const order = (t: string | null) => (t === "skill" ? 0 : t === "memory_store" ? 1 : t === null ? 3 : 2);
  return [...groups.entries()]
    .sort(([a], [b]) => order(a) - order(b) || String(a).localeCompare(String(b)))
    .map(([assetType, rs]) => ({ assetType, refs: rs.sort((x, y) => (x.name ?? x.assetId).localeCompare(y.name ?? y.assetId)) }));
}

// ---------- skills ----------

export interface SkillFields {
  agentTypes: string[];
  enableTools: string[];
  /** Where enable_tools came from */
  enableToolsFrom: "metadata" | "frontmatter" | null;
  skillType: string | null;
  status: string | null;
}

export function skillFields(metadata: unknown, frontmatter: Record<string, unknown> | null): SkillFields {
  const metaTools = metaList(metadata, SKILL_KEYS.enableTools);
  const fmTools = frontmatter ? displayValues(frontmatter[SKILL_KEYS.enableTools]) : [];
  const agentTypes = metaList(metadata, SKILL_KEYS.agentTypes);
  return {
    agentTypes: agentTypes.length ? agentTypes : frontmatter ? displayValues(frontmatter[SKILL_KEYS.agentTypes]) : [],
    enableTools: metaTools.length ? metaTools : fmTools,
    enableToolsFrom: metaTools.length ? "metadata" : fmTools.length ? "frontmatter" : null,
    skillType: metaString(metadata, SKILL_KEYS.skillType),
    status: assetStatus(metadata),
  };
}
