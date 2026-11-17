import { describe, expect, it } from "vitest";
import { packageToDesiredAssets } from "@/server/packages/desired";
import { exportPackageZip } from "@/server/packages/export";
import { getLayout } from "@/server/packages/layout";
import { agentSpacePackage, descriptor, SPACE_IDS as I } from "@/server/packages/test-support/agent-space";
import type { DesiredAsset } from "@/server/packages/types";
import { getAppPolicy } from "@/server/policy";
import { importOverlayEdits } from "./import-overlay";

const policy = getAppPolicy().policy;
const layout = getLayout(policy, "agent-space-folders");

describe("laying an import over a revision's base", () => {
  // The base: the space exported in the layout (folders named by asset, the older verity as verity__<id>), plus a skill the package doesn't have.
  const assets = packageToDesiredAssets(agentSpacePackage(), layout, { policy }).assets.map((a) => (a.sourceAssetId ? { ...a, assetId: a.sourceAssetId } : a));
  const extra: DesiredAsset = { assetType: "skill", key: "untouched", assetId: "ki-a0000000-0000-4000-8000-000000000009", metadata: { name: "untouched", description: "Stays.", agent_types: ["GENERIC"], status: "ACTIVE", skill_type: "USER" }, files: [{ path: "SKILL.md", encoding: "utf8", content: "---\nname: untouched\ndescription: Stays.\n---\n# Untouched\n" }] };
  const base = exportPackageZip([...assets, extra], layout, { policy, packageName: "space" }).contents;

  it("replaces each matched asset's files wherever the base keeps them, and keeps assets the package doesn't mention", () => {
    const upload = agentSpacePackage({ "skill/probe/SKILL.md": "---\nname: probe\ndescription: Use when probing.\n---\n# Probe, revised\n" });
    expect(base.files.has(`skill/verity__${I.verityOld}/SKILL.md`)).toBe(true);
    const edits = importOverlayEdits(base, upload, layout, policy);
    const byPath = new Map(edits.map((e) => [e.path, e]));
    // The older verity is the package's skill/verity.v1 (same source ID): the base folder goes, the package folder comes.
    expect(byPath.get(`skill/verity__${I.verityOld}/SKILL.md`)).toMatchObject({ content: null });
    expect(byPath.get("skill/verity.v1/SKILL.md")?.content).toContain("Verity (old)");
    expect(byPath.get("skill/probe/SKILL.md")?.content).toContain("Probe, revised");
    // Nothing of the skill the package doesn't have is touched, and the folder index still lists it.
    expect(edits.some((e) => e.path.startsWith("skill/untouched/"))).toBe(false);
    const index = JSON.parse(byPath.get("INDEX.json")!.content!) as { assets: { dir: string }[] };
    expect(index.assets.map((a) => a.dir)).toEqual(expect.arrayContaining(["skill/untouched", "skill/verity.v1", "skill/probe"]));
    expect(index.assets.map((a) => a.dir)).not.toContain(`skill/verity__${I.verityOld}`);
  });

  it("matches by type and key when the source IDs are another space's, and changes nothing for an identical package", () => {
    const elsewhere = agentSpacePackage({
      "skill/probe/_asset.json": descriptor("ki-c0000000-0000-4000-8000-000000000001", "skill", { name: "probe", description: "Use when probing.", agent_types: ["INCIDENT_RCA"], status: "ACTIVE", skill_type: "USER" }),
    });
    const edits = importOverlayEdits(base, elsewhere, layout, policy);
    // Same folder, new descriptor: only the descriptor differs.
    expect(edits.filter((e) => e.path.startsWith("skill/probe/")).map((e) => e.path)).toEqual(["skill/probe/_asset.json"]);
    const same = exportPackageZip([...assets, extra], layout, { policy, packageName: "space" }).contents;
    expect(importOverlayEdits(base, same, layout, policy)).toEqual([]);
  });
});
