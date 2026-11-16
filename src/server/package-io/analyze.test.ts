import { describe, expect, it } from "vitest";
import { getLayout } from "@/server/packages/layout";
import { packageFromFiles } from "@/server/packages/read";
import { SHARED_BEGIN as BEGIN, SHARED_END as END, STRICT_SAFETY as SAFETY, testPolicy } from "@/server/packages/test-support/policy";
import { analyzeImport, planItemsFromAnalysis, type LiveIndexEntry } from "./analyze";
import type { ImportItem } from "./types";

// strict-shared (a test layout) lists learning.md and grader.md without an agent type, so they are skipped.
const policy = testPolicy();
const layout = getLayout(policy, "strict-shared");

const ID = {
  global: "ki-00000000-0000-4000-8000-000000000001",
  skill: "ki-00000000-0000-4000-8000-000000000002",
  store: "ki-00000000-0000-4000-8000-000000000003",
  first: "ki-00000000-0000-4000-8000-000000000004",
  stray: "ki-00000000-0000-4000-8000-000000000005",
  triage: "ki-00000000-0000-4000-8000-000000000006",
};

function demoPackage(overrides: Record<string, string> = {}) {
  return packageFromFiles("demo", {
    "README.md": "# Demo\n",
    "instructions/global.md": `# Global\n\n${SAFETY}`,
    "instructions/incident-triage.md": `# Triage\n\n${BEGIN}\nold\n${END}\n`,
    "instructions/incident-rca.md": `# RCA\n\n${BEGIN}\n${END}\nTail.\n`,
    "instructions/shared/common.md": "## Common rules\n\n- Delegate.\n\n",
    "instructions/learning.md": "# Learning\n",
    "instructions/grader.md": "# Grader\n",
    "skills/demo-skill/SKILL.md": "---\nname: demo-skill\ndescription: Use when testing.\n---\n# Demo\n",
    "memory/demo-store/STORE.md": "---\nstore: demo-store\ndescription: Demo notes. Read when testing.\nagent_types: Generic (all agents)\n---\n\nDemo store.\n",
    "memory/demo-store/notes/first.md": "---\nname: notes/first\ndescription: First note.\n---\n\n# First\n",
    ...overrides,
  });
}

const analyze = (live: LiveIndexEntry[], contents = demoPackage()) => analyzeImport({ contents, layout, policy, live, historyCommit: "c".repeat(40), now: new Date("2026-11-11T00:00:00Z") });

/** A live index whose committed state equals what the package maps to, so every item is unchanged. */
function liveMatching(): LiveIndexEntry[] {
  const fresh = analyze([]).results.items;
  const item = (assetType: string, key: string) => fresh.find((i) => i.assetType === assetType && i.key === key)!;
  const entry = (i: ImportItem, assetId: string, extra: Record<string, unknown> = {}, name = i.key): LiveIndexEntry => {
    const metadata = { ...i.metadata, status: "ACTIVE", ...extra };
    return { assetId, assetType: i.assetType, name, metadata, liveVersion: 3, committed: { metadata, files: i.files.map((f) => ({ path: f.path, sha256: f.sha256 })) } };
  };
  const store = item("memory_store", "demo-store");
  return [
    entry(item("agents_md", "GENERIC"), ID.global),
    entry(item("agents_md", "INCIDENT_TRIAGE"), ID.triage),
    entry(item("skill", "demo-skill"), ID.skill, { skill_type: "USER" }),
    // The service names a store's single file after the store, not README.md.
    { ...entry(store, ID.store), committed: { metadata: { ...store.metadata, status: "ACTIVE" }, files: [{ path: "demo-store.md", sha256: store.files[0]!.sha256 }] } },
    entry(item("memory", "demo-store/notes/first"), ID.first, { memory_store_id: ID.store }, "notes/first"),
  ];
}

const byKey = (items: ImportItem[], assetType: string, key: string) => items.find((i) => i.assetType === assetType && i.key === key)!;

describe("analyzeImport: mapping a package against the space's index", () => {
  it("creates every asset in an empty space and gives each file a role", () => {
    const { results, summary, desired } = analyze([]);
    expect(results.items.every((i) => i.action === "create" && i.assetId === null)).toBe(true);
    expect(summary.counts).toMatchObject({ create: results.items.length, update: 0, unchanged: 0, untouched: 0 });
    expect(desired.every((d) => d.assetId === undefined)).toBe(true);
    const role = (p: string) => results.files.find((f) => f.path === p)?.role;
    expect(role("instructions/global.md")).toBe("asset");
    expect(role("README.md")).toBe("non-asset");
    expect(role("instructions/shared/common.md")).toBe("non-asset");
    expect(role("instructions/learning.md")).toBe("skipped");
    expect(role("skills/demo-skill.zip")).toBe("build-artifact");
    expect(results.files.find((f) => f.path === "skills/demo-skill.zip")?.build).toBe("created");
    expect(summary.roles.asset).toBeGreaterThan(0);
    expect(results.historyCommit).toBe("c".repeat(40));
  });

  it("marks assets whose content and metadata hashes equal the committed state as unchanged", () => {
    const { results, summary } = analyze(liveMatching());
    const notUnchanged = results.items.filter((i) => i.action !== "unchanged").map((i) => i.assetKey);
    // INCIDENT_RCA is not in the live index, so it is the one create.
    expect(notUnchanged).toEqual(["agents_md:INCIDENT_RCA"]);
    expect(summary.counts).toMatchObject({ create: 1, update: 0, unchanged: results.items.length - 1, untouched: 0 });
    const memory = byKey(results.items, "memory", "demo-store/notes/first");
    expect(memory).toMatchObject({ action: "unchanged", assetId: ID.first, liveVersion: 3, changes: null });
  });

  it("matches by identity and reports what changed for an update", () => {
    const live = liveMatching();
    const skill = live.find((l) => l.assetId === ID.skill)!;
    skill.committed = { ...skill.committed!, metadata: { ...skill.committed!.metadata, description: "Old description." } };
    const contents = demoPackage({ "memory/demo-store/notes/first.md": "---\nname: notes/first\ndescription: First note.\n---\n\n# First, edited\n" });
    const { results, desired } = analyze(live, contents);
    const s = byKey(results.items, "skill", "demo-skill");
    expect(s).toMatchObject({ action: "update", assetId: ID.skill, changes: { content: false, metadataKeys: ["description"], committed: true } });
    const m = byKey(results.items, "memory", "demo-store/notes/first");
    expect(m).toMatchObject({ action: "update", assetId: ID.first, changes: { content: true, metadataKeys: [], committed: true } });
    expect(desired[results.items.indexOf(m)]!.assetId).toBe(ID.first);
  });

  it("counts an asset with no committed state as an update", () => {
    const live = liveMatching().map((l) => (l.assetId === ID.global ? { ...l, committed: null } : l));
    const g = byKey(analyze(live).results.items, "agents_md", "GENERIC");
    expect(g).toMatchObject({ action: "update", assetId: ID.global, changes: { content: true, committed: false } });
  });

  it("lists live assets the package doesn't mention and leaves them out of the plan", () => {
    const live = [...liveMatching(), { assetId: ID.stray, assetType: "skill", name: "live-only", metadata: { name: "live-only", status: "ACTIVE" }, liveVersion: 1, committed: null }];
    const a = analyze(live);
    expect(a.results.untouched).toEqual([{ assetId: ID.stray, assetType: "skill", name: "live-only" }]);
    expect(a.summary.counts.untouched).toBe(1);
    const items = planItemsFromAnalysis(a);
    expect(items.map((i) => i.desired.assetId ?? null)).not.toContain(ID.stray);
  });

  it("matches memories through their store's name, not the store's ID", () => {
    const live = liveMatching();
    // Same memory name under another store: not a match.
    const first = live.find((l) => l.assetId === ID.first)!;
    first.metadata = { ...first.metadata, memory_store_id: "ki-99999999-0000-4000-8000-000000000000" };
    const m = byKey(analyze(live).results.items, "memory", "demo-store/notes/first");
    expect(m.action).toBe("create");
  });

  it("builds plan items from the create and update items only", () => {
    const live = liveMatching();
    const skill = live.find((l) => l.assetId === ID.skill)!;
    skill.committed = { ...skill.committed!, files: [{ path: "SKILL.md", sha256: "0".repeat(64) }] };
    const a = analyze(live);
    const items = planItemsFromAnalysis(a);
    expect(items.map((i) => `${i.desired.assetType}:${i.desired.key}:${i.desired.assetId ?? "new"}`)).toEqual(["agents_md:INCIDENT_RCA:new", `skill:demo-skill:${ID.skill}`]);
    expect(items.every((i) => i.baseVersion === null && i.baseUpdatedAt === null)).toBe(true);
    expect(items[1]!.note).toBe("From the package file skills/demo-skill.");
  });

  it("reports validation results per item and in the summary", () => {
    const contents = demoPackage({ "skills/demo-skill/SKILL.md": "---\nname: Demo Skill\ndescription: Use when testing.\n---\n# Demo\n" });
    const a = analyze([], contents);
    expect(a.summary.ok).toBe(false);
    expect(a.summary.counts.errors).toBeGreaterThan(0);
    expect(a.results.validation.some((r) => r.level === "error")).toBe(true);
  });
});
