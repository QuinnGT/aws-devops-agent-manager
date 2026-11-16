import { packageFromFiles } from "../read";
import type { PackageContents } from "../types";
import { STRICT_SAFETY } from "./policy";

/**
 * Test support for the Agent Space folder layout (agent-space-folders): a
 * small synthetic package in that layout.
 */

/** The safety responses the strict test layouts require (test-support/policy). */
export const SAFETY = STRICT_SAFETY;

/** Source asset IDs of the synthetic package (and the live IDs of the space it came from). */
export const SPACE_IDS = {
  global: "ki-a0000000-0000-4000-8000-000000000001",
  triage: "ki-a0000000-0000-4000-8000-000000000002",
  verity: "ki-a0000000-0000-4000-8000-000000000003",
  verityOld: "ki-a0000000-0000-4000-8000-000000000004",
  probe: "ki-a0000000-0000-4000-8000-000000000005",
  reviewer: "ki-a0000000-0000-4000-8000-000000000006",
  /** A memory store of the source space that is not in the package */
  liveStore: "ki-a0000000-0000-4000-8000-000000000007",
} as const;

/** An Agent Space descriptor with the service's bookkeeping keys, as the export writes it. */
export function descriptor(assetId: string, assetType: string, metadata: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify(
    {
      assetId,
      assetType,
      metadata,
      version: 3,
      createdAt: "2026-10-21 22:58:09+00:00",
      updatedAt: "2026-11-10 05:04:05+00:00",
      creator: { uid: "00000000-0000-4000-8000-0000000000aa", displayName: "example-role" },
      ...extra,
    },
    null,
    2,
  )}\n`;
}

/**
 * A package in the Agent Space folder layout: GENERIC and INCIDENT_TRIAGE
 * instructions, skill verity (a bundle with a reference file) and its older
 * INACTIVE copy verity.v1, skill probe, custom agent reviewer (skills verity
 * and probe, the source space's store liveStore), and one memory store in the
 * instruction folders STORE.md layout. `overrides` replaces files; null removes one.
 */
export function agentSpacePackage(overrides: Record<string, string | Buffer | null> = {}): PackageContents {
  const I = SPACE_IDS;
  const files: Record<string, string | Buffer | null> = {
    "README.md": "# Space\n",
    ".gitignore": "__pycache__/\n",
    "reference/DEPLOY.md": "# Deploy\n",
    "agents_md/global/_asset.json": descriptor(I.global, "agents_md", { status: "ACTIVE", agent_type: "GENERIC" }),
    "agents_md/global/AGENTS.md": `# Global\n\n${SAFETY}`,
    "agents_md/incident-triage/_asset.json": descriptor(I.triage, "agents_md", { agent_type: "INCIDENT_TRIAGE", status: "ACTIVE" }),
    "agents_md/incident-triage/AGENTS.md": "# Triage\n\nMeasure the onset.\n",
    "skill/verity/_asset.json": descriptor(I.verity, "skill", { name: "verity", description: "Use when checking a claim.", agent_types: ["GENERIC"], status: "ACTIVE", skill_type: "USER" }),
    "skill/verity/SKILL.md": "---\nname: verity\ndescription: Use when checking a claim.\n---\n# Verity\n",
    "skill/verity/references/sources.md": "# Sources\n",
    "skill/verity.v1/_asset.json": descriptor(I.verityOld, "skill", { name: "verity", description: "Older procedure.", agent_types: ["GENERIC"], status: "INACTIVE", skill_type: "USER" }),
    "skill/verity.v1/SKILL.md": "---\nname: verity\ndescription: Older procedure.\n---\n# Verity (old)\n",
    "skill/probe/_asset.json": descriptor(I.probe, "skill", { name: "probe", description: "Use when probing.", agent_types: ["INCIDENT_RCA"], status: "ACTIVE", skill_type: "USER" }),
    "skill/probe/SKILL.md": "---\nname: probe\ndescription: Use when probing.\n---\n# Probe\n",
    "custom_agent/reviewer/_asset.json": descriptor(I.reviewer, "custom_agent", { name: "reviewer", skills: [I.verity, I.probe], memory_stores: [I.liveStore], tools: ["anyco_changes_list"] }),
    "custom_agent/reviewer/reviewer.md": "You review pull requests.\n",
    "memory/notes/STORE.md": "---\nstore: notes\ndescription: Demo notes. Read when testing.\nagent_types: Generic (all agents)\n---\n\nDemo store.\n",
    "memory/notes/first.md": "---\nname: first\ndescription: First note.\n---\n\n# First\n",
    "memory/notes/INDEX.md": "# notes\n\nLinks are relative to this index. This is the validated local index preview.\n\n- [first](./first.md): First note.\n",
    ...overrides,
  };
  const present = Object.fromEntries(Object.entries(files).filter((e): e is [string, string | Buffer] => e[1] !== null));
  if (!("INDEX.json" in overrides)) present["INDEX.json"] = folderIndex(present);
  return packageFromFiles("space-folders", present);
}

/** INDEX.json for the descriptor folders of a file set, as a package build writes it. */
export function folderIndex(files: Record<string, string | Buffer>): string {
  const assets = Object.keys(files)
    .filter((p) => p.endsWith("/_asset.json") && p.split("/").length === 3)
    .sort()
    .flatMap((p) => {
      let d: { assetId: string; assetType: string; metadata: Record<string, unknown> };
      try {
        d = JSON.parse(String(files[p]));
      } catch {
        return [];
      }
      const dir = p.slice(0, -"/_asset.json".length);
      return [{
        dir,
        type: d.assetType,
        name: d.assetType === "agents_md" ? d.metadata.agent_type : d.metadata.name,
        assetId: d.assetId,
        version: 3,
        status: d.metadata.status ?? "ACTIVE",
        files: Object.keys(files)
          .filter((f) => f.startsWith(`${dir}/`) && f !== p)
          .map((f) => f.slice(dir.length + 1))
          .sort(),
      }];
    });
  return `${JSON.stringify({ server: "example-space", assets }, null, 2)}\n`;
}
