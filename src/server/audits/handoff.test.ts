import { describe, expect, it } from "vitest";
import { filesEligible } from "./states";
import { folderAliases, folderNames, handoffManifestSchema, HANDOFF_FILE_NAMES, HANDOFF_FORMAT, noFilesReason, readmeFor } from "./handoff";
import { getAppPolicy, readPolicyFile } from "@/server/policy";

const SHA = "a".repeat(64);

describe("folder names", () => {
  it("names a folder for the incident ID, or the task ID without one, and keeps names unique", () => {
    const items = [
      { incidentId: "INCIDENT-1", taskId: "t1" },
      { incidentId: null, taskId: "task/2" },
      { incidentId: "INCIDENT-1", taskId: "t3" },
      { incidentId: "INCIDENT-1", taskId: "t3" },
    ];
    // A task ID with a path in it keeps only its last segment.
    expect(folderNames(items)).toEqual(["INCIDENT-1", "2", "INCIDENT-1_t3", "INCIDENT-1_2"]);
  });

  it("is safe as a path: no separators, no dots at the start", () => {
    const [n] = folderNames([{ incidentId: "../../etc/passwd", taskId: "t" }]);
    expect(n).toBe("passwd");
    expect(folderNames([{ incidentId: "..", taskId: "t" }])[0]).toBe("investigation");
  });

  it("accepts the plain IDs and the written names when a folder is matched", () => {
    const a = folderAliases({ incidentId: "INCIDENT-1", taskId: "t-1" });
    expect(a).toEqual(expect.arrayContaining(["INCIDENT-1", "t-1", "INCIDENT-1_t-1"]));
  });
});

describe("readmeFor", () => {
  const shipped = readPolicyFile(getAppPolicy().dirs, getAppPolicy().policy.audits.handoff.readme)!;
  const v = { incidentId: "INCIDENT-20101", taskId: "task-1", auditName: "Benchmark\nrun", profileLabel: "Benchmark against ground truth" };

  it("fills the shipped README: the names, the files, a ready prompt, the data warning and the import steps", () => {
    const text = readmeFor(shipped, v);
    expect(text).not.toContain("{{");
    expect(text).toContain("# Review files for INCIDENT-20101");
    expect(text).toContain('"Benchmark run"');
    for (const f of ["system.md", "brief.md", "records.md", "schema.json", "manifest.json", "review.json"]) expect(text).toContain(`\`${f}\``);
    expect(text).toMatch(/Kiro CLI or Claude Code/);
    expect(text).toMatch(/Read README\.md[^]*write[^]*review\.json/i);
    expect(text).toMatch(/journal text from your company's systems/);
    expect(text).toMatch(/approved/);
    expect(text).toMatch(/Import review/);
    expect(text).not.toContain("\u2014");
  });

  it("refuses a placeholder it does not know", () => {
    expect(() => readmeFor("Hello {{nobody}}", v)).toThrow("unknown placeholders");
  });
});

describe("manifest", () => {
  const ok = {
    format: HANDOFF_FORMAT,
    version: 1,
    auditId: "11111111-1111-4111-8111-111111111111",
    itemId: "22222222-2222-4222-8222-222222222222",
    taskId: "t",
    incidentId: null,
    journalSha256: SHA,
    promptDigest: SHA,
    profileId: "benchmark",
    runner: "handoff",
    createdAt: "2026-11-19T16:00:00.000Z",
  };
  it("accepts what the export writes and refuses anything else", () => {
    expect(handoffManifestSchema.safeParse(ok).success).toBe(true);
    expect(handoffManifestSchema.safeParse({ ...ok, journalSha256: "short" }).success).toBe(false);
    expect(handoffManifestSchema.safeParse({ ...ok, format: "x" }).success).toBe(false);
    expect(handoffManifestSchema.safeParse({ ...ok, itemId: "not-a-uuid" }).success).toBe(false);
  });
  it("lists the files a folder holds", () => {
    expect(Object.values(HANDOFF_FILE_NAMES).sort()).toEqual(["README.md", "brief.md", "manifest.json", "records.md", "review.json", "schema.json", "system.md"]);
  });
});

describe("which items take review files", () => {
  const base = { state: "pending" as const, analyzedAt: new Date(0), journalSha256: SHA };
  it("takes analyzed items that are waiting, reviewed or failed", () => {
    expect(filesEligible(base)).toBe(true);
    expect(filesEligible({ ...base, state: "reviewed" })).toBe(true);
    expect(filesEligible({ ...base, state: "failed" })).toBe(true);
  });
  it("leaves out skipped items and items the analyzers have not reached", () => {
    expect(filesEligible({ ...base, state: "skipped" })).toBe(false);
    expect(filesEligible({ ...base, state: "analyzing" })).toBe(false);
    expect(filesEligible({ ...base, analyzedAt: null })).toBe(false);
    expect(filesEligible({ ...base, journalSha256: null })).toBe(false);
  });
  it("says why one is left out", () => {
    expect(noFilesReason({ ...base, state: "skipped" })).toContain("skipped");
    expect(noFilesReason({ ...base, analyzedAt: null })).toContain("analyzers have not run");
  });
});
