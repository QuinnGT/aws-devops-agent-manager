import type { Policy } from "@/server/policy";
import type { TestAsset } from "@/server/releases/test-support";
import type { FakeSpace } from "@/server/sync/testing/fake-space";
import { packageAssets, type SamplePackages } from "./content";
import { byName, type VerifyStory } from "./verify";

/**
 * The Verification story for the sample dataset (see parts/verify.ts for what
 * it builds). The space starts on package v1. A plan brings two of the audit's
 * fixes in from package v2 (the seat-map-service memory and the
 * change-window-search skill), and release v1.1 is tagged after it. Then, in
 * the live space: feature-flag-audit is edited, legacy-dashboard-links (gone in
 * v2) is deleted and consumer-lag-check (new in v2) is added.
 *
 * The revisions edit other files (the RCA instructions, cache-path-check,
 * vendor-status-check, pricing-mismatch), so the two stories don't touch the
 * same asset.
 */

export const STORY = {
  firstRelease: "v1",
  release: "v1.1",
  planMemory: "services/seat-map-service",
  planSkill: "change-window-search",
  changedSkill: "feature-flag-audit",
  deletedSkill: "legacy-dashboard-links",
  addedSkill: "consumer-lag-check",
  /** The five investigations after the release */
  investigations: [
    { incident: "INCIDENT-20301", title: "Seat holds lost again during a second on-sale" },
    { incident: "INCIDENT-20302", title: "Card declines for one acquirer after a certificate change" },
    { incident: "INCIDENT-20303", title: "Price differs between the event page and checkout for a share of users" },
    { incident: "INCIDENT-20304", title: "Confirmation emails late for tickets on one partition" },
    { incident: "INCIDENT-20305", title: "New events missing from search after a mapping change" },
  ],
} as const;

/** The asset of the type and name in a v2 asset list, or throws. */
function v2Asset(v2: TestAsset[], type: string, name: string): TestAsset {
  const a = v2.find((x) => x.assetType === type && x.metadata.name === name);
  if (!a) throw new Error(`sample package v2 has no ${type} ${name}`);
  return a;
}

/** The text of an asset's main file: SKILL.md for a skill, the one markdown file of a memory. */
function mainText(a: TestAsset): string {
  const entry = Object.entries(a.files).find(([p]) => (a.assetType === "skill" ? p === "SKILL.md" : p.endsWith(".md")));
  if (!entry) throw new Error(`${String(a.metadata.name)} has no main file`);
  return entry[1].toString();
}

/** The verification story over the mocked Agent Space `fake` (which serves package v1). */
export function verifyStory(fake: FakeSpace, packages: SamplePackages, policy: Policy): VerifyStory {
  const id = (type: string, name: string) => {
    const a = byName(fake, type, name);
    if (!a) throw new Error(`the demo space has no ${type} ${name}`);
    return a.assetId;
  };
  const v2 = packageAssets(packages.v2, policy);
  const added = v2Asset(v2, "skill", STORY.addedSkill);
  const lastSegment = (name: string) => name.split("/").pop()!;
  return {
    planMemoryId: id("memory", STORY.planMemory),
    planSkillId: id("skill", STORY.planSkill),
    changedSkillId: id("skill", STORY.changedSkill),
    deletedSkillId: id("skill", STORY.deletedSkill),
    firstReleaseName: STORY.firstRelease,
    releaseName: STORY.release,
    memoryText: mainText(v2Asset(v2, "memory", STORY.planMemory)),
    skillText: mainText(v2Asset(v2, "skill", STORY.planSkill)),
    skillDescription: String(v2Asset(v2, "skill", STORY.planSkill).metadata.description),
    changedNote: "\nInclude flags served to a share of the traffic, not only flags turned on for everyone.\n",
    planTitle: `Apply the cache audit fixes to ${lastSegment(STORY.planMemory)} and ${STORY.planSkill}`,
    planReason: "Accepted fixes from the late October audit (INCIDENT-20101)",
    releaseNote: `The ${lastSegment(STORY.planMemory)} memory and the ${STORY.planSkill} skill after the late October audit.`,
    added: {
      name: STORY.addedSkill,
      description: String(added.metadata.description),
      agentTypes: added.metadata.agent_types as string[],
      text: mainText(added),
    },
    investigations: [...STORY.investigations],
  };
}
