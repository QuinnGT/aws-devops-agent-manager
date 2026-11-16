import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { analyzeImport, type LiveIndexEntry } from "@/server/package-io/analyze";
import { getLayout } from "@/server/packages/layout";
import { getAppPolicy } from "@/server/policy";
import { findingLabel, revisionPlanInput, revisionPlanReason, revisionPlanTitle } from "./plan-input";
import { GLOBAL_MD, syntheticPackage } from "./test-support";

const policy = getAppPolicy().policy;
const layout = getLayout(policy, "instruction-folders");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const live: LiveIndexEntry[] = [
  {
    assetId: "ki-generic",
    assetType: "agents_md",
    name: "GENERIC",
    metadata: { agent_type: "GENERIC", status: "ACTIVE" },
    liveVersion: 3,
    committed: { metadata: { agent_type: "GENERIC", status: "ACTIVE" }, files: [{ path: "AGENTS.md", sha256: sha(GLOBAL_MD) }] },
  },
  {
    assetId: "ki-rca",
    assetType: "agents_md",
    name: "INCIDENT_RCA",
    metadata: { agent_type: "INCIDENT_RCA", status: "ACTIVE" },
    liveVersion: 1,
    committed: { metadata: { agent_type: "INCIDENT_RCA", status: "ACTIVE" }, files: [{ path: "AGENTS.md", sha256: sha("rca\n") }] },
  },
];

const findings = new Map([
  ["f1", { id: "f1", title: "INCIDENT-31495: anchored on a precedent", auditName: "Late October audit", incidentId: "INCIDENT-31495" }],
  ["f2", { id: "f2", title: "Retire resolved gaps", auditName: "Late October audit", incidentId: "INCIDENT-31499" }],
]);

describe("plan input from a revision", () => {
  it("plans the package's create and update items with the revision origin, title and reason", () => {
    const contents = syntheticPackage("v2.4", { "instructions/global.md": `${GLOBAL_MD}\nNew rule.\n` });
    const analysis = analyzeImport({ contents, layout, policy, live });
    const input = revisionPlanInput({
      policy,
      spaceId: "00000000-0000-4000-8000-000000000001",
      spaceAlias: "anycompany",
      revision: { id: "00000000-0000-4000-8000-0000000000aa", name: "v2.4" },
      analysis,
      changes: [
        { message: "Record precedents as hypotheses.", findingIds: ["f1"] },
        { message: "Retire resolved gaps", findingIds: ["f2", "f1"] },
      ],
      findings,
    });
    expect(input.origin).toEqual({ kind: "revision", revisionId: "00000000-0000-4000-8000-0000000000aa", name: "v2.4" });
    expect(input.title).toBe("Apply revision v2.4");
    expect(input.reason).toBe("Revision v2.4: Record precedents as hypotheses; Retire resolved gaps. Findings: INCIDENT-31495: anchored on a precedent (Late October audit); Retire resolved gaps (Late October audit).");
    const byKey = new Map(input.items.map((i) => [`${i.desired.assetType}:${i.desired.key}`, i]));
    // GENERIC changed: an update of the live asset. The rest are new: creates without an asset ID.
    expect(byKey.get("agents_md:GENERIC")!.desired.assetId).toBe("ki-generic");
    expect(byKey.get("agents_md:GENERIC")!.desired.files[0]!.content).toContain("New rule.");
    expect(byKey.get("skill:triage")!.desired.assetId).toBeUndefined();
    expect(byKey.get("memory:runbooks/failover")!.desired.refs).toEqual({ memoryStore: "runbooks" });
    expect(input.items.every((i) => i.baseVersion === null)).toBe(true);
    // The live RCA file is not in the package: left alone, and the plan says so.
    expect(byKey.has("agents_md:INCIDENT_RCA")).toBe(false);
    expect(input.notes).toEqual(["1 live asset is not in the revision and stays as it is."]);
  });

  it("leaves out assets that already match the space", () => {
    const analysis = analyzeImport({ contents: syntheticPackage("v2.4"), layout, policy, live });
    const input = revisionPlanInput({ policy, spaceId: "s", spaceAlias: "anycompany", revision: { id: "r", name: "v2.4" }, analysis, changes: [], findings: new Map() });
    expect(input.items.map((i) => i.desired.key)).not.toContain("GENERIC");
    expect(input.notes?.[0]).toBe("1 asset in the revision already matches the space and is left out.");
    expect(input.reason).toBe("Revision v2.4: v2.4. Findings: none linked.");
  });

  it("keeps the reason and title within the plan limits", () => {
    const tight = { ...policy, plans: { ...policy.plans, limits: { ...policy.plans.limits, reasonMaxChars: 40, titleMaxChars: 10 } } };
    const reason = revisionPlanReason({ policy: tight, revision: { id: "r", name: "v2.4" }, changes: [{ message: "x".repeat(100), findingIds: [] }], findings: new Map() });
    expect(reason).toHaveLength(40);
    expect(reason.endsWith("…")).toBe(true);
    expect(revisionPlanTitle(tight, "v2.4", "anycompany")).toHaveLength(10);
    expect(findingLabel({ title: "T", auditName: "A" })).toBe("T (A)");
  });
});
