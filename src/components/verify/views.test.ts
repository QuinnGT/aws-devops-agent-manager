import { describe, expect, it } from "vitest";
import type { ReadsFileView } from "@/server/verify/loaders";
import type { LiveCheckResult, ReadOutcome } from "@/server/verify/types";
import { READ_OUTCOMES } from "@/server/verify/types";
import { managedNote, notComparedNote } from "./words";
import { atApplyText, changedSummary, differences, fileRow, liveCounts, needsALook, orderRows, readCounts, recordText, skippedRow, visibleRows } from "./views";

const zero = () => Object.fromEntries(READ_OUTCOMES.map((o) => [o, 0])) as Record<ReadOutcome, number>;

function file(o: Partial<ReadsFileView> & Pick<ReadsFileView, "verdict">): ReadsFileView {
  return {
    rowKey: `memory:${o.assetName ?? "db/failover"}:x`,
    assetType: "memory",
    typeLabel: "Memory",
    assetId: "ki-1",
    releaseVersion: 3,
    assetName: "db/failover",
    store: "runbooks",
    filePath: "db/failover.md",
    deployedPath: "/aidevops/memory/runbooks/db/failover.md",
    counts: zero(),
    investigations: 14,
    requested: 3,
    matchedVersions: [],
    worstShares: null,
    releaseOnly: [],
    deployedOnly: [],
    examples: {},
    releaseStatus: "ACTIVE",
    ...o,
  };
}

const ctx = { live: null, stores: [{ store: "runbooks", referencedIn: 9 }] };
const link = (taskId: string, n: number | null, title: string | null = null) => ({ taskId, incidentId: `INC-${taskId}`, recordId: `${taskId}-r`, n, href: `/j/${taskId}`, title });

describe("fileRow", () => {
  it("names the older version the agent got, with the first record and how many more", () => {
    const counts = { ...zero(), "older-body": 3, "release-body": 11 };
    const r = fileRow(
      file({ verdict: "older-body", counts, matchedVersions: [{ version: 1, relation: "older", commit: "abc" }], examples: { "older-body": [link("t1", 18, "Testing MCP servers locally"), link("t2", 4)] } }),
      ctx,
    );
    expect(r).toMatchObject({
      name: "db/failover",
      typeLine: "Memory in runbooks",
      requested: "3 of 14",
      words: "Received an older body",
      tone: "warning",
      reason: "Matches v1; the release has v3",
      record: { href: "/j/t1", text: "Testing MCP servers locally · R18" },
      more: 2,
      needsLook: true,
    });
  });

  it("gives the line share for a different or near body, and the newer version for a newer one", () => {
    expect(fileRow(file({ verdict: "other-body", worstShares: { pkg: 0.426, ret: 0.3 } }), ctx).reason).toBe("43% of its lines matched");
    const near = fileRow(file({ verdict: "near-release", worstShares: { pkg: 0.95, ret: 0.97 } }), ctx);
    expect(near).toMatchObject({ words: "Received the release's body, almost exactly", tone: "success", reason: "95% of its lines matched", needsLook: false });
    expect(fileRow(file({ verdict: "newer-body", matchedVersions: [{ version: 4, relation: "newer", commit: "c" }] }), ctx).reason).toBe("Matches v4; the release has v3");
  });

  it("explains a request with nothing returned from the last live check", () => {
    const live = (outcome: "missing" | "changed", status: string | null) =>
      ({ rows: [{ release: { assetId: "ki-1" }, outcome, live: outcome === "missing" ? null : { status } }] }) as unknown as LiveCheckResult;
    expect(fileRow(file({ verdict: "requested-no-body" }), { ...ctx, live: live("missing", null) }).reason).toBe("Deleted from the live space since the release");
    expect(fileRow(file({ verdict: "requested-no-body" }), { ...ctx, live: live("changed", "INACTIVE") }).reason).toBe("Inactive in the live space");
    expect(fileRow(file({ verdict: "requested-no-body" }), ctx).reason).toBeNull();
  });

  it("says a never-requested memory's store was read, and has no records", () => {
    const r = fileRow(file({ verdict: "not-requested", requested: 0 }), ctx);
    expect(r).toMatchObject({ words: "Never requested", tone: "muted", reason: "Store runbooks was read in 9 investigations", record: null, more: 0, requested: "0 of 14", needsLook: true });
    // Inactive in the release: not offered, so it doesn't need a look
    expect(fileRow(file({ verdict: "not-requested", releaseStatus: "INACTIVE" }), ctx)).toMatchObject({ reason: "Inactive in this release, so it isn't offered", needsLook: false });
  });

  it("links a release-body row to any example of the release's body", () => {
    const r = fileRow(file({ verdict: "release-body", counts: { ...zero(), "release-body": 1, "near-release": 2 }, examples: { "near-release": [link("t9", null)] } }), ctx);
    expect(r).toMatchObject({ record: { text: "INC-t9" }, more: 2, needsLook: false });
  });
});

describe("needsALook, orderRows and visibleRows", () => {
  it("puts files that need a look first and filters by view and type", () => {
    expect(needsALook({ verdict: "release-body" })).toBe(false);
    expect(needsALook({ verdict: "older-body" })).toBe(true);
    expect(needsALook({ verdict: "not-requested", releaseStatus: null })).toBe(true);
    const rows = [
      fileRow(file({ verdict: "release-body", assetName: "a", rowKey: "a" }), ctx),
      fileRow(file({ verdict: "older-body", assetName: "b", rowKey: "b" }), ctx),
      { ...fileRow(file({ verdict: "not-requested", assetName: "c", rowKey: "c" }), ctx), assetType: "skill" },
      skippedRow({ assetId: "ki-9", assetType: "skill", name: "off", reason: "inactive" }, "Skill", null)!,
    ];
    const ordered = orderRows(rows);
    expect(ordered.map((r) => r.name)).toEqual(["b", "c", "a", "off"]);
    expect(visibleRows(ordered, { show: "look", type: null }).map((r) => r.name)).toEqual(["b", "c"]);
    expect(visibleRows(ordered, { show: "all", type: "skill" }).map((r) => r.name)).toEqual(["c", "off"]);
  });

  it("shows skipped assets as rows the check didn't compare, except instructions and stores", () => {
    expect(skippedRow({ assetId: "ki-9", assetType: "skill", name: "off", reason: "inactive" }, "Skill", null)).toMatchObject({
      words: "Not offered",
      reason: "Inactive in this release, so it isn't offered",
      requested: null,
      needsLook: false,
    });
    expect(skippedRow({ assetId: "ki-8", assetType: "agents_md", name: "GENERIC", reason: "not-compared" }, "Instructions", null)).toBeNull();
    expect(skippedRow({ assetId: "ki-7", assetType: "memory", name: "overview", reason: "managed" }, "Memory", null)).toBeNull();
    expect(skippedRow({ assetId: "ki-6", assetType: "skill", name: "x", reason: "not-in-git" }, "Skill", null)).toMatchObject({ words: "Not compared", needsLook: false });
  });
});

describe("counts", () => {
  it("groups files by what the agent got, leaving out newer and different bodies at zero", () => {
    const files = [{ verdict: "release-body" as const }, { verdict: "near-release" as const }, { verdict: "older-body" as const }, { verdict: "not-requested" as const }];
    expect(readCounts(files).map((c) => [c.words, c.n])).toEqual([
      ["received the release's body", 2],
      ["received an older body", 1],
      ["requested, nothing returned", 0],
      ["never requested", 1],
    ]);
    expect(readCounts([{ verdict: "other-body" }]).map((c) => c.key)).toContain("other");
  });

  it("colors changed and missing only above zero, and adds up the differences", () => {
    const c = { matches: 16, changed: 4, missing: 0, added: 1 };
    expect(liveCounts(c).map((x) => [x.words, x.n, x.tone])).toEqual([
      ["match", 16, "default"],
      ["changed", 4, "warning"],
      ["missing", 0, "default"],
      ["added since", 1, "default"],
    ]);
    expect(differences(c)).toBe(5);
  });

  it("words the apply read-back", () => {
    expect(atApplyText({ total: 21, matched: 21 })).toEqual({ ok: true, lead: "At apply, all 21 assets matched." });
    expect(atApplyText({ total: 21, matched: 19 })).toEqual({ ok: false, lead: "At apply, 2 of 21 assets didn't match." });
    expect(atApplyText({ total: 1, matched: 1 }).lead).toBe("At apply, all 1 asset matched.");
  });

  it("titles a record by the investigation, falling back to the incident and task IDs", () => {
    expect(recordText({ title: "PrivateLink across Regions", incidentId: "INC-1", taskId: "t", n: 22 })).toBe("PrivateLink across Regions · R22");
    expect(recordText({ title: null, incidentId: null, taskId: "t-7", n: null })).toBe("t-7");
  });
});

describe("footer notes", () => {
  it("counts managed memories and lists the types the check never compares", () => {
    expect(managedNote(0)).toBeNull();
    expect(managedNote(1)).toBe("1 memory in managed stores isn't compared: the agent keeps it up to date, so it changes without a release.");
    expect(managedNote(8)).toBe("8 memories in managed stores aren't compared: the agent keeps them up to date, so they change without a release.");
    expect(notComparedNote([])).toBeNull();
    expect(notComparedNote(["instruction files", "artifacts", "memory stores"])).toBe("Not compared: instruction files, artifacts and memory stores. The agent doesn't read them from a deployed file path.");
  });

  it("says the memories inside memory stores are compared, so the note names stores, not memories", () => {
    expect(notComparedNote(["instruction files", "memory stores"], { inside: { items: "memories", containers: "memory stores" } })).toBe(
      "Not compared: instruction files and memory stores. The agent doesn't read them from a deployed file path. The memories inside those memory stores are compared: each one is a row of its own.",
    );
  });
});

describe("the release's changed assets", () => {
  const changed = new Set(["ki-mem", "ki-skill"]);
  const v12 = [
    file({ verdict: "older-body", assetId: "ki-mem", assetName: "change-feed-windows", rowKey: "m" }),
    file({ verdict: "release-body", assetId: "ki-skill", assetName: "bounded-log-query", rowKey: "s", assetType: "skill" }),
    file({ verdict: "newer-body", assetId: "ki-other", assetName: "consumer-lag-check", rowKey: "t", assetType: "skill" }),
    file({ verdict: "not-requested", assetId: "ki-never", assetName: "token-signing-check", rowKey: "n", assetType: "skill" }),
  ];
  const noun = (t: string) => ({ agents_md: "instruction files", memory_store: "memory stores" })[t] ?? `${t}s`;

  it("answers the question for the assets this release changed", () => {
    expect(changedSummary({ changes: { previous: "v1.1", assetIds: [...changed] }, files: v12, skipped: [], investigations: 5, typeNoun: noun })).toBe(
      "Of the 2 assets this release changed since v1.1, the agent read 1 as released and 1 as an older version; 0 were never requested in 5 investigations.",
    );
  });

  it("counts never-requested, nothing-returned, switched-off and uncompared changed assets on their own", () => {
    const files = [
      file({ verdict: "not-requested", assetId: "a" }),
      file({ verdict: "not-requested", assetId: "b" }),
      file({ verdict: "requested-no-body", assetId: "c" }),
      file({ verdict: "other-body", assetId: "d" }),
    ];
    const skipped = [
      { assetId: "e", assetType: "agents_md", reason: "not-compared" as const },
      { assetId: "f", assetType: "skill", reason: "inactive" as const },
      { assetId: "z", assetType: "agents_md", reason: "not-compared" as const },
    ];
    expect(changedSummary({ changes: { previous: "v1", assetIds: ["a", "b", "c", "d", "e", "f", "g"] }, files, skipped, investigations: 1, typeNoun: noun })).toBe(
      "Of the 7 assets this release changed since v1, the agent read 0 as released, 0 as an older version and 1 as a different version; 2 were never requested in 1 investigation. The agent asked for 1 more and got nothing back. 1 is switched off in this release, so the agent isn't offered it. 1 isn't compared (instruction files). 1 isn't in the last check; run it again.",
    );
    expect(changedSummary({ changes: null, files, skipped, investigations: 1, typeNoun: noun })).toBeNull();
    expect(changedSummary({ changes: { previous: "v1", assetIds: [] }, files, skipped, investigations: 1, typeNoun: noun })).toBe(
      "This release changed no assets since v1, so there is nothing new for the agent to read.",
    );
    expect(changedSummary({ changes: { previous: null, assetIds: ["a"] }, files, skipped, investigations: 3, typeNoun: noun })).toMatch(/^Of the 1 asset in this release \(the space's first\), /);
  });

  it("lists the changed assets first, then other files that need a look; never-requested files the release didn't change aren't in the default view", () => {
    expect(needsALook({ verdict: "not-requested", releaseStatus: "ACTIVE" }, false)).toBe(false);
    expect(needsALook({ verdict: "not-requested", releaseStatus: "ACTIVE" }, true)).toBe(true);
    expect(needsALook({ verdict: "older-body" }, false)).toBe(true);
    const rows = orderRows(v12.map((f) => fileRow(f, { ...ctx, changed })));
    expect(rows.map((r) => [r.name, r.changed, r.needsLook])).toEqual([
      ["change-feed-windows", true, true],
      ["bounded-log-query", true, false],
      ["consumer-lag-check", false, true],
      ["token-signing-check", false, false],
    ]);
    expect(visibleRows(rows, { show: "look", type: null }).map((r) => r.name)).toEqual(["change-feed-windows", "bounded-log-query", "consumer-lag-check"]);
    expect(visibleRows(rows, { show: "all", type: null })).toHaveLength(4);
  });
});
