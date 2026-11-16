import type { Policy } from "@/server/policy";
import type { PackageLayout } from "@/server/policy/sections/package-layouts";
import { fill, matchesAny } from "./paths";

export type { PackageLayout };

/** A layout by name, or the policy's default layout. Throws for an unknown name. */
export function getLayout(policy: Pick<Policy, "packageLayouts">, name?: string): PackageLayout {
  const layoutName = name ?? policy.packageLayouts.defaultLayout;
  if (!layoutName) throw new Error("No package layout named and no defaultLayout in package-layouts.yaml");
  const layout = policy.packageLayouts.layouts[layoutName];
  if (!layout) throw new Error(`Unknown package layout ${layoutName}`);
  return layout;
}

export function listLayouts(policy: Pick<Policy, "packageLayouts">): { name: string; label: string; isDefault: boolean }[] {
  return Object.values(policy.packageLayouts.layouts).map((l) => ({
    name: l.name,
    label: l.label,
    isDefault: l.name === policy.packageLayouts.defaultLayout,
  }));
}

/**
 * Resolve an agent type written in a package ("Incident Triage",
 * "Generic (all agents)", "INCIDENT_TRIAGE") to its ID. Case-insensitive;
 * accepts IDs, the layout's agentTypeNames and the labels in agent-types.yaml.
 */
export function agentTypeResolver(policy: Pick<Policy, "agentTypes">, layout: PackageLayout): (token: string) => string | null {
  const map = new Map<string, string>();
  const add = (name: string, id: string) => map.set(name.trim().toLowerCase(), id);
  for (const a of policy.agentTypes.agentTypes) {
    add(a.id, a.id);
    add(a.label, a.id);
  }
  for (const [id, name] of Object.entries(layout.agentTypeNames)) add(name, id);
  return (token) => map.get(token.trim().toLowerCase()) ?? null;
}

/** Parse an agent_types value from frontmatter: a YAML list or a comma-separated string. */
export function parseAgentTypes(
  value: unknown,
  resolve: (token: string) => string | null,
): { ids: string[]; unknown: string[] } | null {
  let tokens: string[];
  if (Array.isArray(value)) tokens = value.map(String);
  else if (typeof value === "string") tokens = value.split(",");
  else return null;
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const t of tokens.map((x) => x.trim()).filter(Boolean)) {
    const id = resolve(t);
    if (id) {
      if (!ids.includes(id)) ids.push(id);
    } else unknown.push(t);
  }
  return { ids, unknown };
}

/** The name the layout writes for an agent type ID (falls back to the ID). */
export function agentTypeDisplayName(layout: PackageLayout, id: string): string {
  return layout.agentTypeNames[id] ?? id;
}

export function isIgnored(layout: PackageLayout, path: string): boolean {
  return matchesAny(path, layout.ignore);
}

export function isNonAsset(layout: PackageLayout, path: string): boolean {
  return matchesAny(path, layout.nonAssets);
}

/** Shared sections with {name} filled in. */
export function sharedSections(layout: PackageLayout): { name: string; source: string; targets: string[]; begin: string; end: string }[] {
  return layout.sharedSections.map((s) => ({
    name: s.name,
    source: fill(s.source, { name: s.name }),
    targets: s.targets,
    begin: fill(s.begin, { name: s.name }),
    end: fill(s.end, { name: s.name }),
  }));
}
