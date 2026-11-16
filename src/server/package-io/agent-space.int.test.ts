import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useTempDataDir } from "@/server/assets/test-support/history-fixture";
import { db } from "@/server/db/client";
import { agentSpaces, assetIndex, auditEvents } from "@/server/db/schema";
import { zipPackage } from "@/server/packages/build";
import { packageToDesiredAssets } from "@/server/packages/desired";
import { getLayout } from "@/server/packages/layout";
import { readPackageFolder } from "@/server/packages/read";
import { agentSpacePackage, SPACE_IDS as I } from "@/server/packages/test-support/agent-space";
import { addOverlays } from "@/server/packages/test-support/policy";
import type { CreatePlanInput } from "@/server/plans/contract";
import { getAppPolicy } from "@/server/policy";
import { getSpaceById, type Space } from "@/server/spaces/queries";
import { truncateAll } from "../../../test/helpers/db";
import { SAMPLE_DATA_DIR, sampleAgentSpaceExportDir } from "../../../test/helpers/fixtures";
import { loadImportDetail } from "./loaders";
import { createPlanFromImport, getImportRow, importPackage, remapImport } from "./service";
import type { ImportResults } from "./types";

/**
 * The import service with the Agent Space folder layout, on a synthetic space
 * whose live index holds some of the package's asset IDs: detection, the
 * layout override, and a plan with updates by asset ID, creates, a left-out
 * duplicate and types left out by choice. createPlan is mocked, as in
 * package-io.int.test.ts; nothing calls AWS.
 */

const plans = vi.hoisted(() => ({ calls: [] as CreatePlanInput[] }));
vi.mock("@/server/plans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/plans")>();
  return {
    ...actual,
    createPlan: vi.fn(async (input: CreatePlanInput) => {
      plans.calls.push(input);
      return { planId: `00000000-0000-4000-8000-${String(plans.calls.length).padStart(12, "0")}`, checkRunId: "00000000-0000-4000-9000-000000000001" };
    }),
  };
});

// The sample policy overlay adds the layout anycompany-folders, used by the last test.
const restoreOverlay = addOverlays([path.join(SAMPLE_DATA_DIR, "policy")]);
const policy = getAppPolicy().policy;
const actor = { email: "editor@example.com", name: "Editor" };
const PROBE_LIVE = "ki-b0000000-0000-4000-8000-000000000001";

let tmp: Awaited<ReturnType<typeof useTempDataDir>>;
let space: Space;

async function newSpace(alias: string, assets: { assetId: string; assetType: string; name: string; metadata: Record<string, unknown> }[]): Promise<Space> {
  const [row] = await db().insert(agentSpaces).values({ alias, region: "us-west-2", accountId: "111122223333", agentSpaceId: `${alias}-id` }).returning();
  for (const a of assets) {
    await db()
      .insert(assetIndex)
      .values({ spaceId: row!.id, ...a, liveVersion: 2, liveUpdatedAt: new Date("2026-11-10T05:00:00Z"), lastSyncedVersion: 2, createdAt: new Date("2026-10-21T22:00:00Z") });
  }
  return (await getSpaceById(row!.id))!;
}

const audits = (action: string, spaceId: string) => db().select().from(auditEvents).where(and(eq(auditEvents.action, action), eq(auditEvents.spaceId, spaceId)));

beforeAll(async () => {
  await truncateAll();
  tmp = await useTempDataDir();
  // The space the package came from holds GENERIC, verity (not its older copy) and the store the custom agent uses;
  // a skill named probe lives there under another ID.
  space = await newSpace("folders-space", [
    { assetId: I.global, assetType: "agents_md", name: "GENERIC", metadata: { agent_type: "GENERIC", status: "ACTIVE" } },
    { assetId: I.verity, assetType: "skill", name: "verity", metadata: { name: "verity", description: "Use when checking a claim.", agent_types: ["GENERIC"], status: "ACTIVE", skill_type: "USER" } },
    { assetId: PROBE_LIVE, assetType: "skill", name: "probe", metadata: { name: "probe", description: "Old.", agent_types: ["INCIDENT_RCA"], status: "ACTIVE", skill_type: "USER" } },
    { assetId: I.liveStore, assetType: "memory_store", name: "patterns", metadata: { name: "patterns", description: "Patterns.", agent_types: ["GENERIC"] } },
  ]);
});

afterAll(async () => {
  await tmp.cleanup();
  restoreOverlay();
});

beforeEach(() => {
  plans.calls.length = 0;
});

describe("import of an Agent Space folder package", () => {
  let importId: string;
  const zip = zipPackage(agentSpacePackage());

  it("detects the layout and maps against the live index by asset ID, then by name", async () => {
    const r = await importPackage(space, { upload: { kind: "zip", fileName: "space-folders.zip", bytes: zip } }, actor);
    expect(r).toMatchObject({ status: "analyzed", layout: "agent-space-folders", layoutChoice: "detected" });
    importId = r.importId;
    const row = (await getImportRow(space.id, importId))!;
    expect(row.layout).toBe("agent-space-folders");
    const results = row.results as ImportResults;
    expect(results.layoutChoice).toBe("detected");
    expect(results.layouts!.map((l) => l.layout)[0]).toBe("agent-space-folders");
    expect(r.summary.counts).toMatchObject({ update: 3, create: 4, leftOut: 1, errors: 0, untouched: 1 });
    const by = (key: string) => results.items.find((i) => i.key === key)!;
    expect(by("GENERIC")).toMatchObject({ action: "update", assetId: I.global, matchedBy: "asset-id" });
    expect(by("verity")).toMatchObject({ action: "update", assetId: I.verity, matchedBy: "asset-id" });
    expect(by("probe")).toMatchObject({ action: "update", assetId: PROBE_LIVE, matchedBy: "identity" });
    expect(by("reviewer")).toMatchObject({ action: "create", refs: { skills: ["verity", "probe"] }, metadata: { memory_stores: [I.liveStore] } });

    const detail = (await loadImportDetail(space, importId))!;
    expect(detail.layouts).toMatchObject({ choice: "detected", canChange: true });
    expect(detail.leftOut.map((l) => l.source)).toEqual(["skill/verity.v1"]);
    expect(detail.planTypes.types.map((t) => t.assetType)).toEqual(["agents_md", "skill", "memory_store", "memory", "custom_agent"]);
    expect((await audits("package.import", space.id)).find((e) => e.targetId === importId)?.details).toMatchObject({ layout: "agent-space-folders", layoutChoice: "detected" });
  });

  it("reads the stored upload again with another layout, and back", async () => {
    const folders = await remapImport(space, importId, "instruction-folders", actor);
    expect(folders.summary.assets).toBe(2); // only memory/ maps in the instruction-folders layout
    const row = (await getImportRow(space.id, importId))!;
    expect(row.layout).toBe("instruction-folders");
    expect((row.results as ImportResults).layoutChoice).toBe("chosen");
    expect((await audits("package.import.layout", space.id)).map((e) => e.details)).toContainEqual(expect.objectContaining({ from: "agent-space-folders", layout: "instruction-folders" }));
    await remapImport(space, importId, "agent-space-folders", actor);
    expect((await getImportRow(space.id, importId))!.layout).toBe("agent-space-folders");
    await expect(remapImport(space, importId, "no-such-layout", actor)).rejects.toMatchObject({ code: "unknown-layout" });
  });

  it("creates a plan with the chosen types: updates by asset ID, creates, and notes for what was left out", async () => {
    await expect(createPlanFromImport(space, importId, actor, { includeTypes: ["not_a_type"] })).rejects.toMatchObject({ code: "bad-request" });
    const r = await createPlanFromImport(space, importId, actor, { includeTypes: ["agents_md", "skill"], reason: "v2 instructions and skills" });
    expect(plans.calls).toHaveLength(1);
    const input = plans.calls[0]!;
    expect(input.items.map((i) => [i.desired.assetType, i.desired.key, i.desired.assetId ?? null])).toEqual([
      ["agents_md", "GENERIC", I.global],
      ["agents_md", "INCIDENT_TRIAGE", null],
      ["skill", "probe", PROBE_LIVE],
      ["skill", "verity", I.verity],
    ]);
    expect(input.items[0]!.note).toBe("From the package folder agents_md/global, matched by its asset ID.");
    // No descriptor bookkeeping and no descriptor file reach the plan.
    for (const i of input.items) {
      expect(i.desired.files.some((f) => f.path.endsWith("_asset.json"))).toBe(false);
      expect(i.desired.metadata).not.toHaveProperty("version");
    }
    expect(input.notes).toEqual([
      // Counted from the stored mapping, as the type checkboxes counted them
      "Left out of this import by choice: memory stores (1 change), memories (1 change) and custom agents (1 change) from the package.",
      "skill/verity.v1 is left out: skill/verity has the same name, verity, and has status ACTIVE. Assets that share a name are all imported only into a space that holds each of their asset IDs.",
    ]);
    expect(r.notes).toEqual(input.notes);
    const row = (await getImportRow(space.id, importId))!;
    expect(row.status).toBe("planned");
    // The plan keeps the stored layout facts (chosen, after the override above).
    expect((row.results as ImportResults).layoutChoice).toBe("chosen");
    expect((row.results as ImportResults).layouts).toHaveLength(Object.keys(policy.packageLayouts.layouts).length);
    expect((await audits("package.plan", space.id)).find((e) => e.targetId === importId)?.details).toMatchObject({ includeTypes: ["agents_md", "skill"], items: 4 });
    await expect(remapImport(space, importId, "instruction-folders", actor)).rejects.toMatchObject({ code: "already-planned" });
  });

  it("plans every type when none is chosen, with the references by name and by live ID", async () => {
    const r = await importPackage(space, { upload: { kind: "zip", fileName: "again.zip", bytes: zip } }, actor);
    await createPlanFromImport(space, r.importId, actor);
    const input = plans.calls[0]!;
    expect(input.items).toHaveLength(7);
    const reviewer = input.items.find((i) => i.desired.assetType === "custom_agent")!;
    expect(reviewer.desired).toMatchObject({ refs: { skills: ["verity", "probe"] }, metadata: { memory_stores: [I.liveStore] } });
    expect(reviewer.desired.assetId).toBeUndefined();
    expect(input.notes).toEqual([expect.stringMatching(/^skill\/verity\.v1 is left out/)]);
  });

  it("keeps the type choice from hiding errors in the chosen types", async () => {
    const other = await newSpace("folders-elsewhere", []);
    const r = await importPackage(other, { upload: { kind: "zip", fileName: "elsewhere.zip", bytes: zip } }, actor);
    // Nowhere in that space: the custom agent's store ID is an error, so the whole package is blocked...
    expect(r.summary.ok).toBe(false);
    await expect(createPlanFromImport(other, r.importId, actor)).rejects.toMatchObject({ code: "not-plannable" });
    await expect(createPlanFromImport(other, r.importId, actor, { includeTypes: ["custom_agent", "skill"] })).rejects.toMatchObject({
      code: "not-plannable",
      results: [expect.objectContaining({ code: "reference.not-in-package", assetKey: "custom_agent:reviewer" })],
    });
    // ...and leaving custom agents out makes the rest plannable.
    await createPlanFromImport(other, r.importId, actor, { includeTypes: ["agents_md", "skill", "memory_store", "memory"] });
    expect(plans.calls[0]!.items.every((i) => !i.desired.assetId)).toBe(true);
    expect(plans.calls[0]!.notes![0]).toBe("Left out of this import by choice: custom agents (1 change) from the package.");
  });
});

describe("import of the sample Agent Space export into the space it came from", () => {
  const LAYOUT = "anycompany-folders";

  it("updates the instructions by asset ID and leaves the other types out", async () => {
    const layout = getLayout(policy, LAYOUT);
    const contents = await readPackageFolder(sampleAgentSpaceExportDir(), { policy, layout });
    const mapped = packageToDesiredAssets(contents, layout, { policy }).assets;
    // The live index of the source space: every asset of the export with its source ID.
    const home = await newSpace(
      "sample-home",
      mapped.filter((a) => a.sourceAssetId).map((a) => ({ assetId: a.sourceAssetId!, assetType: a.assetType, name: String(a.metadata.name ?? a.metadata.agent_type), metadata: a.metadata })),
    );
    const bytes = zipPackage(contents, "agent-space-export");
    const r = await importPackage(home, { upload: { kind: "zip", fileName: "agent-space-export.zip", bytes }, layout: LAYOUT }, actor);
    expect(r).toMatchObject({ status: "analyzed", layout: LAYOUT });
    // The older cache-path-check skill and the active one both update their own assets here.
    expect(r.summary.counts.leftOut).toBe(0);
    expect(r.summary.counts.errors).toBe(0);

    const detail = (await loadImportDetail(home, r.importId))!;
    expect(detail.planTypes.types.filter((t) => t.errors > 0)).toEqual([]);

    await createPlanFromImport(home, r.importId, actor, { includeTypes: ["agents_md"] });
    const input = plans.calls[0]!;
    expect(input.items).toHaveLength(5);
    expect(input.items.every((i) => i.desired.assetType === "agents_md" && i.desired.assetId === i.desired.sourceAssetId)).toBe(true);
    expect(input.notes).toEqual(["Left out of this import by choice: skills (9 changes), memory stores (3 changes), memories (10 changes) and custom agents (2 changes) from the package."]);
  });
});
