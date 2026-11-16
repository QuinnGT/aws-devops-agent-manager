import { describe, expect, it } from "vitest";
import { analyzeImport, type LiveIndexEntry } from "@/server/package-io/analyze";
import { packageToDesiredAssets } from "@/server/packages/desired";
import { getLayout } from "@/server/packages/layout";
import type { DesiredAsset, PackageContents } from "@/server/packages/types";
import { checkItem } from "@/server/plans/decide";
import { getAppPolicy } from "@/server/policy";
import { sha256Hex } from "@/server/sync/content";
import { revisionPlanInput } from "./plan-input";
import { conflictSentence, desiredSignature, leftAloneSentences, revisionScope, scopeAfter, type BaseAssetState } from "./scope";
import { syntheticPackage } from "./test-support";

/**
 * A revision from release
 * v1.2 edits one instruction file; after v1.2 a skill was deleted in the live
 * space and another was updated there. The plan must hold only the edited
 * file, and name the two live changes it leaves alone.
 */

const policy = getAppPolicy().policy;
const layout = getLayout(policy, "instruction-folders");

const SKILL = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} steps\n---\n${body}\n`;
const V12: Record<string, string | null> = {
  "skills/low-sample-size-check/SKILL.md": SKILL("low-sample-size-check", "Check the denominator."),
  "skills/token-signing-check/SKILL.md": SKILL("token-signing-check", "Compare with the day before."),
  // Memory is not part of this story.
  "memory/runbooks/STORE.md": null,
  "memory/runbooks/failover.md": null,
};

const mapped = (c: PackageContents) => packageToDesiredAssets(c, layout, { policy }).assets;
const idOf = (d: Pick<DesiredAsset, "assetType" | "key">) => `ki-${d.assetType}-${d.key}`.replace(/[^\w-]/g, "-");
const fileSha = (f: DesiredAsset["files"][number]) => sha256Hex(f.encoding === "utf8" ? Buffer.from(f.content, "utf8") : Buffer.from(f.content, "base64"));

/** Every asset of release v1.2 at version 4, live and in the history repository. */
const base = syntheticPackage("v1.2", V12);
const baseDesired = mapped(base);
const baseAssets: BaseAssetState[] = baseDesired.map((d) => ({ assetId: idOf(d), assetType: d.assetType, metadata: d.metadata, version: 4, updatedAt: "2026-11-10T01:00:00.000Z" }));
const liveAt = (d: DesiredAsset, version: number, files = d.files): LiveIndexEntry => ({
  assetId: idOf(d),
  assetType: d.assetType,
  name: d.key,
  metadata: d.metadata,
  liveVersion: version,
  committed: { metadata: d.metadata, files: files.map((f) => ({ path: f.path, sha256: fileSha(f) })) },
});

/** After v1.2: low-sample-size-check deleted live, token-signing-check updated live (v4 to v5). */
const live: LiveIndexEntry[] = baseDesired.flatMap((d) => {
  if (d.key === "low-sample-size-check") return [];
  if (d.key === "token-signing-check") return [liveAt(d, 5, [{ path: "SKILL.md", encoding: "utf8", content: SKILL("token-signing-check", "Compare with the same weekday a week earlier.") }])];
  return [liveAt(d, 4)];
});

function planFor(head: PackageContents) {
  const analysis = analyzeImport({ contents: head, layout, policy, live });
  const scope = revisionScope({ policy, head: mapped(head), base: baseDesired, baseAssets, live, analysis });
  const input = revisionPlanInput({ policy, spaceId: "s", spaceAlias: "customer-demo-space", revision: { id: "r", name: "cart-selection-fix" }, analysis, changes: [], findings: new Map(), scope, base: { kind: "release", name: "v1.2" } });
  return { analysis, scope, input };
}

describe("what a plan from a revision holds", () => {
  it("holds only the edited instruction file and names the live changes it leaves alone", () => {
    const head = syntheticPackage("v1.2", { ...V12, "instructions/incident-triage.md": "# Triage\n\nTriage rules.\n\n## Fast-fail 5xx\n\nTest the client-input hypothesis first.\n" });
    const { analysis, scope, input } = planFor(head);
    // Without the scope the mapping alone would also re-create the deleted skill and roll back the updated one.
    expect(analysis.results.items.filter((i) => i.action !== "unchanged").map((i) => i.assetKey).sort()).toEqual(["agents_md:INCIDENT_TRIAGE", "skill:low-sample-size-check", "skill:token-signing-check"]);

    expect(scope.changed.map((c) => c.assetKey)).toEqual(["agents_md:INCIDENT_TRIAGE"]);
    expect(input.items.map((i) => `${i.desired.assetType}:${i.desired.key}`)).toEqual(["agents_md:INCIDENT_TRIAGE"]);
    // The item carries the base version, so the plan check flags it if live moves before apply.
    expect(input.items[0]).toMatchObject({ baseVersion: 4, baseUpdatedAt: "2026-11-10T01:00:00.000Z" });
    expect(input.items[0]!.desired.assetId).toBe(idOf({ assetType: "agents_md", key: "INCIDENT_TRIAGE" }));
    expect(input.notes).toEqual([
      "2 assets in the revision already match the space and are left out.",
      "Skill low-sample-size-check changed in the live space after v1.2; this plan leaves it as it is.",
      "Skill token-signing-check changed in the live space after v1.2; this plan leaves it as it is.",
    ]);
    expect(scope.leftAlone).toEqual([
      { assetKey: "skill:low-sample-size-check", label: "Skill low-sample-size-check", deleted: true },
      { assetKey: "skill:token-signing-check", label: "Skill token-signing-check", deleted: false },
    ]);
  });

  it("shows an asset the revision and the live space both changed as a conflict with both versions", () => {
    const head = syntheticPackage("v1.2", {
      ...V12,
      "skills/token-signing-check/SKILL.md": SKILL("token-signing-check", "Compare with the day before and the hour before."),
      "skills/low-sample-size-check/SKILL.md": SKILL("low-sample-size-check", "Check the denominator and say how many samples."),
    });
    const { scope, input } = planFor(head);
    expect(scope.leftAlone).toEqual([]);
    const surge = input.items.find((i) => i.desired.key === "token-signing-check")!;
    const sample = input.items.find((i) => i.desired.key === "low-sample-size-check")!;
    expect(surge).toMatchObject({ baseVersion: 4 });
    expect(surge.note).toMatch(/^Skill token-signing-check changed in this revision and in the live space after v1\.2 \(v4 in v1\.2, v5 live\)\. Apply skips it/);
    // The deleted skill comes back as a create, and the plan says so.
    expect(sample).toMatchObject({ baseVersion: null });
    expect(sample.desired.assetId).toBeUndefined();
    expect(input.notes).toContain("Skill low-sample-size-check changed in this revision but was deleted from the live space after v1.2. This plan creates it again; discard the plan if it should stay deleted.");

    // The plan check treats the base version the way it treats a draft's: live at v5 is a conflict, so apply skips it.
    const result = checkItem(
      { kind: "upsert", assetType: "skill", assetKey: "token-signing-check", assetId: surge.desired.assetId!, desired: surge.desired, baseVersion: surge.baseVersion!, baseUpdatedAt: new Date(surge.baseUpdatedAt!), removeMetadataKeys: [] },
      { assetId: surge.desired.assetId!, version: 5, updatedAt: new Date("2026-11-12T01:00:00.000Z"), metadata: surge.desired.metadata, files: [] },
      { policy, deletesEnabled: false, managed: false },
    );
    expect(result.conflict).toMatchObject({ kind: "moved", baseVersion: 4, liveVersion: 5 });
  });

  it("plans nothing when the saves changed no asset", () => {
    const readmeOnly = planFor(syntheticPackage("v1.2", { ...V12, "README.md": "# Notes\n" }));
    expect(readmeOnly.scope.changed).toEqual([]);
    expect(readmeOnly.input.items).toEqual([]);
    // The comparison ignores source paths and metadata key order, and sees any change of content.
    expect(desiredSignature({ files: [{ path: "a.md", encoding: "utf8", content: "x" }], metadata: { b: 1, a: 2 } })).toBe(desiredSignature({ files: [{ path: "a.md", encoding: "utf8", content: "x", sourcePath: "p/a.md" }], metadata: { a: 2, b: 1 } }));
    expect(desiredSignature({ files: [{ path: "a.md", encoding: "utf8", content: "x" }], metadata: {} })).not.toBe(desiredSignature({ files: [{ path: "a.md", encoding: "utf8", content: "y" }], metadata: {} }));
  });

  it("words the notes for a live base and caps the list", () => {
    const live = { kind: "live" as const };
    expect(scopeAfter(live)).toBe("this revision started");
    expect(conflictSentence({ label: "Skill a", conflict: { kind: "changed-live", baseVersion: 2, liveVersion: 3 } }, live, "this plan")).toBe(
      "Skill a changed in this revision and in the live space after this revision started (v2 when this revision started, v3 live). Apply skips it until you compare both versions and re-check the plan.",
    );
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `Skill s${i}` }));
    const lines = leftAloneSentences(many, { kind: "release", name: "v1.2" }, "a plan from this revision", 10);
    expect(lines).toHaveLength(11);
    expect(lines.at(-1)).toBe("2 more assets changed in the live space after v1.2; a plan from this revision leaves them as they are.");
  });
});
