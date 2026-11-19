import { describe, expect, it } from "vitest";
import { getLayout } from "@/server/packages/layout";
import { getAppPolicy } from "@/server/policy";
import { auditHref, capDiffLines, citedRecords, diffTotals, errorsByFile, fileDiffOf, findingHref, isGeneratedFile, notAcceptedReason, packageFolders, rebuiltLine, resultFile, sourceAuditsOf, splitBuiltFiles, toAddressViews } from "./views";

const policy = getAppPolicy().policy;
const v23 = getLayout(policy, "instruction-folders-shared");

const tree = [
  { path: "README.md", role: "non-asset" as const, assetKey: null },
  { path: "instructions/global.md", role: "asset" as const, assetKey: "agents_md:GENERIC" },
  { path: "skills/triage/SKILL.md", role: "asset" as const, assetKey: "skill:triage" },
  { path: "skills/triage/references/steps.md", role: "asset" as const, assetKey: "skill:triage" },
  { path: "skills/triage.zip", role: "build-artifact" as const, assetKey: "skill:triage" },
  { path: "memory/runbooks/INDEX.md", role: "build-artifact" as const, assetKey: null },
  { path: "reference/CHANGELOG.md", role: "non-asset" as const, assetKey: null },
  { path: "reference/VALIDATION.json", role: "non-asset" as const, assetKey: null },
];

describe("tree marks", () => {
  it("treats build outputs, the change record and the validation summary as built", () => {
    const opts = { changelogPath: "reference/CHANGELOG.md", validationPath: "reference/VALIDATION.json" };
    expect(tree.filter((f) => isGeneratedFile(f, opts)).map((f) => f.path)).toEqual(["skills/triage.zip", "memory/runbooks/INDEX.md", "reference/CHANGELOG.md", "reference/VALIDATION.json"]);
    expect(isGeneratedFile({ path: "reference/CHANGELOG.md", role: "non-asset" }, { changelogPath: null, validationPath: null })).toBe(false);
    // An Agent Space folder's descriptor is the asset's metadata: editable. The folder index stays built.
    const folders = { ...opts, descriptor: "_asset.json" };
    expect(isGeneratedFile({ path: "skill/triage/_asset.json", role: "manifest" }, folders)).toBe(false);
    expect(isGeneratedFile({ path: "INDEX.json", role: "manifest" }, folders)).toBe(true);
  });

  it("finds the file a result is about: its package path, the path inside the asset, then the asset's main file", () => {
    expect(resultFile({ path: "instructions/global.md" }, tree)).toBe("instructions/global.md");
    expect(resultFile({ path: "references/steps.md", assetKey: "skill:triage" }, tree)).toBe("skills/triage/references/steps.md");
    expect(resultFile({ assetKey: "skill:triage" }, tree)).toBe("skills/triage/SKILL.md");
    expect(resultFile({ path: "instructions/learning.md" }, tree)).toBeNull();
    expect(resultFile({ assetKey: "skill:other" }, tree)).toBeNull();
  });

  it("counts errors per file and leaves warnings out", () => {
    const counts = errorsByFile(
      [
        { level: "error", code: "a", message: "x", path: "instructions/global.md" },
        { level: "error", code: "b", message: "y", path: "instructions/global.md" },
        { level: "warning", code: "c", message: "z", path: "README.md" },
        { level: "error", code: "d", message: "w", assetKey: "skill:triage" },
      ],
      tree,
    );
    expect(Object.fromEntries(counts)).toEqual({ "instructions/global.md": 2, "skills/triage/SKILL.md": 1 });
  });
});

describe("packageFolders", () => {
  it("puts root files first, then the layout's folders in its order, then the rest by name", () => {
    const folders = packageFolders(["reference/a.md", "zzz/b.md", "README.md", "memory/x/STORE.md", "instructions/global.md", "skills/s/SKILL.md", "evaluation/c.md", "instructions/shared/lead.md"], v23);
    expect(folders.map((f) => f.name)).toEqual([null, "instructions", "skills", "memory", "evaluation", "reference", "zzz"]);
    expect(folders[1]!.files).toEqual(["instructions/global.md", "instructions/shared/lead.md"]);
  });
});

describe("rebuiltLine", () => {
  it("names the skill zips and memory indexes in the package, and shared sections when the layout has them", () => {
    const paths = ["skills/a.zip", "skills/b.zip", "skills/a/SKILL.md", "memory/x/INDEX.md", "README.md"];
    expect(rebuiltLine(paths, v23)).toBe("2 skill zips and 1 memory index rebuilt, shared sections copied");
    expect(rebuiltLine(["skills/a.zip"], getLayout(policy, "instruction-folders"))).toBe("1 skill zip rebuilt");
    expect(rebuiltLine([], getLayout(policy, "instruction-folders"))).toBeNull();
  });
});

describe("diffs", () => {
  it("counts added and removed lines of a text change", () => {
    const d = fileDiffOf("a.md", Buffer.from("one\ntwo\nthree\n"), Buffer.from("one\n2\nthree\nfour\n"), 10_000);
    expect(d).toMatchObject({ status: "modified", added: 2, removed: 1 });
    expect(fileDiffOf("a.md", null, Buffer.from("x\n"), 10_000)).toMatchObject({ status: "added", added: 1, removed: 0 });
    expect(fileDiffOf("a.md", Buffer.from("x\n"), null, 10_000)).toMatchObject({ status: "removed", added: 0, removed: 1 });
    expect(fileDiffOf("a.md", Buffer.from("x\n"), Buffer.from("x\n"), 10_000)).toMatchObject({ status: "unchanged", hunks: [] });
  });

  it("gives binary and too-large files a reason instead of lines", () => {
    expect(fileDiffOf("a.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0xfe]), 10_000)).toMatchObject({ status: "not-comparable", reason: "Binary content" });
    expect(fileDiffOf("a.md", Buffer.from("a".repeat(50)), Buffer.from("b".repeat(50)), 10)).toMatchObject({ reason: "Too large to compare line by line" });
  });

  it("keeps hunks until the line budget is used, and the counts after it", () => {
    const a = fileDiffOf("a.md", Buffer.from("1\n2\n"), Buffer.from("1\n3\n"), 10_000);
    const b = fileDiffOf("b.md", Buffer.from("x\n"), Buffer.from("y\n"), 10_000);
    const lines = a.hunks.reduce((n, h) => n + h.lines.length, 0);
    const capped = capDiffLines([a, b], lines);
    expect(capped[0]!.hunks.length).toBe(1);
    expect(capped[1]).toMatchObject({ hunks: [], added: 1, removed: 1 });
    expect(capped[1]!.reason).toMatch(/^Too large to show here/);
    expect(diffTotals(capped)).toEqual({ added: 2, removed: 2 });
  });

  it("lists the records a finding's checked citations confirm, once each", () => {
    expect(
      citedRecords([
        { record: 114, ok: true },
        { record: 121, ok: true },
        { record: 114, ok: true },
        { record: 9, ok: false },
      ]),
    ).toEqual([114, 121]);
  });
});

describe("diff totals for the Diff tab", () => {
  it("counts the edited files apart from the built files, so a 4-line edit reads +4", () => {
    const files = [
      { path: "instructions/incident-rca.md", added: 4, removed: 0 },
      { path: "reference/CHANGELOG.md", added: 9, removed: 0 },
      { path: "reference/VALIDATION.json", added: 2, removed: 2 },
    ];
    const marks = { "reference/CHANGELOG.md": { generated: true }, "reference/VALIDATION.json": { generated: true } };
    expect(splitBuiltFiles(files, ["instructions/incident-rca.md"], marks)).toEqual({
      edited: { added: 4, removed: 0 },
      built: { added: 11, removed: 2 },
      builtPaths: ["reference/CHANGELOG.md", "reference/VALIDATION.json"],
    });
    // A generated file counts as built even when a save named it; a file no save named was written by the build.
    expect(splitBuiltFiles(files, ["reference/CHANGELOG.md", "instructions/incident-rca.md"], marks).builtPaths).toEqual(["reference/CHANGELOG.md", "reference/VALIDATION.json"]);
    expect(splitBuiltFiles(files, [], {}).edited).toEqual({ added: 0, removed: 0 });
  });
});

describe("to-address words and links", () => {
  it("links a finding to its audit's page and escapes the parts", () => {
    expect(findingHref("prod space", "a1", "f1")).toBe("/spaces/prod%20space/audits/a1/findings?finding=f1");
    expect(auditHref("prod", "a1")).toBe("/spaces/prod/audits/a1");
  });

  it("says why a finding can't be linked, and nothing while it is accepted", () => {
    expect(notAcceptedReason("accepted")).toBeNull();
    expect(notAcceptedReason("proposed")).toBe("Reopened on its audit, so it isn't accepted now. It can be linked again once it is accepted.");
    expect(notAcceptedReason("rejected")).toBe("Rejected on its audit. It can't be linked unless it is accepted again.");
    expect(notAcceptedReason("missing")).toBe("This finding is no longer in the space.");
  });

  it("lists each audit once, in the order the findings first name it, and skips findings with no audit", () => {
    const f = (auditId: string, auditName: string) => ({ auditId, auditName });
    expect(sourceAuditsOf("prod", [f("b", "Second"), f("a", "First"), f("b", "Second"), f("", "")])).toEqual([
      { id: "b", name: "Second", href: "/spaces/prod/audits/b" },
      { id: "a", name: "First", href: "/spaces/prod/audits/a" },
    ]);
    expect(sourceAuditsOf("prod", [])).toEqual([]);
  });

  it("shows the list in order with labels from the audit's profile, and keeps an ID whose finding is gone", () => {
    const row = (id: string, state: string, values: Record<string, unknown> = {}) => ({ id, auditId: "a1", auditName: "Late October", incidentId: "INCIDENT-1", title: `Title ${id}`, kind: "fix", state, values });
    const profile = { fixOwners: [{ id: "instructions", label: "Instruction and skill package" }], findings: [{ kind: "fix", label: "Fix" }] } as never;
    const views = toAddressViews("prod", ["f2", "gone", "f1"], [row("f1", "accepted", { owner: "instructions" }), row("f2", "proposed")], new Map([["a1", profile]]), new Map([["a1:fix", "Fix"]]));
    expect(views.map((v) => [v.id, v.state, v.accepted])).toEqual([
      ["f2", "proposed", false],
      ["gone", "missing", false],
      ["f1", "accepted", true],
    ]);
    expect(views[2]).toMatchObject({ title: "Title f1", kindLabel: "Fix", owner: "Instruction and skill package", href: "/spaces/prod/audits/a1/findings?finding=f1", auditHref: "/spaces/prod/audits/a1", notAcceptedReason: null });
    expect(views[0]).toMatchObject({ owner: null, ownerLabel: null, notAcceptedReason: expect.stringContaining("Reopened") });
    expect(views[1]).toMatchObject({ href: null, auditHref: null, auditId: "", notAcceptedReason: "This finding is no longer in the space." });
  });
});
