import { describe, expect, it } from "vitest";
import { getAppPolicy } from "@/server/policy";
import { cell, changelogDate, changelogRow, renderChangelogSection, upsertChangelog, type ChangelogFinding } from "./changelog";

const cfg = getAppPolicy().policy.revisions.changelog;

const f1: ChangelogFinding = {
  id: "f1",
  auditName: "Late October low scores",
  incidentId: "INCIDENT-31495",
  title: "Persist precedents as hypotheses",
  citations: [
    { record: 12, quote: "root cause: monitor precedent", ok: true },
    { record: 40, quote: null, ok: false },
  ],
};
const f2: ChangelogFinding = { id: "f2", auditName: "Late October low scores", incidentId: "INCIDENT-31499", title: "Retire resolved gaps", citations: [] };
const findings = new Map([f1, f2].map((f) => [f.id, f]));

describe("change record", () => {
  it("writes dates the way the hand-written record does", () => {
    expect(changelogDate(new Date("2026-10-15T23:00:00Z"))).toBe("October 15, 2026");
  });

  it("renders one row per change with the finding's audit, incident and evidence", () => {
    const section = renderChangelogSection(cfg, {
      name: "v2.4",
      baseLabel: "release v2.3",
      changes: [
        { message: "Record precedents as hypotheses", changedPaths: ["instructions/global.md"], findingIds: ["f1"], unlinkedReason: null, createdAt: "2026-11-12T10:00:00Z" },
        { message: "Add the README", changedPaths: ["README.md"], findingIds: [], unlinkedReason: "The package needs its README for the checks.", createdAt: "2026-11-13T10:00:00Z" },
      ],
      findings,
    });
    expect(section.split("\n")).toEqual([
      "<!-- revision: v2.4 (generated from the revision's changes; edits between these markers are replaced on the next save) -->",
      "## v2.4, November 13, 2026",
      "",
      "Source: release v2.3. Generated from the revision's changes and the accepted audit findings each change links to.",
      "",
      "| Change | Files | Audit | Incident | Finding | Evidence |",
      "|---|---|---|---|---|---|",
      '| Record precedents as hypotheses | `instructions/global.md` | Late October low scores | INCIDENT-31495 | Persist precedents as hypotheses | R12 "root cause: monitor precedent", R40 (not confirmed by the citation check) |',
      "| Add the README | `README.md` | None | None | None | Not linked to a finding: The package needs its README for the checks. |",
      "<!-- /revision: v2.4 -->",
    ]);
  });

  it("joins several findings in one row and caps files and citations", () => {
    const many = { ...f1, citations: Array.from({ length: 7 }, (_, i) => ({ record: i + 1, quote: "x".repeat(200), ok: true })) };
    const row = changelogRow(
      { message: "Two fixes", changedPaths: ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md"], findingIds: ["f1", "f2", "missing"], unlinkedReason: null, createdAt: new Date() },
      new Map([
        ["f1", many],
        ["f2", f2],
      ]),
      cfg,
    );
    expect(row).toContain("`a.md`, `b.md`, `c.md`, `d.md`, `e.md` and 2 more");
    expect(row).toContain("| Late October low scores | INCIDENT-31495; INCIDENT-31499 | Persist precedents as hypotheses; Retire resolved gaps |");
    expect(row).toContain("and 2 more; Retire resolved gaps: None |");
    expect(row).toContain(`R1 "${"x".repeat(119)}…"`);
  });

  it("keeps untrusted finding text from breaking the table or carrying HTML", () => {
    expect(cell("a | b\n<script>alert(1)</script>")).toBe("a \\| b &lt;script&gt;alert(1)&lt;/script&gt;");
    const row = changelogRow({ message: "x", changedPaths: [], findingIds: ["f"], unlinkedReason: null, createdAt: new Date() }, new Map([["f", { ...f2, id: "f", title: "bad | title\nsecond line" }]]), cfg);
    expect(row.split("\n")).toHaveLength(1);
    expect(row).toContain("bad \\| title second line");
  });

  it("puts the section at the top of an existing record and replaces it on the next save", () => {
    const handWritten = "# Candidate v2.3 change record\n\n## v2.3, October 15, 2026\n\nOlder history.\n";
    const first = renderChangelogSection(cfg, { name: "v2.4", baseLabel: "release v2.3", changes: [], findings, date: new Date("2026-11-12T00:00:00Z") });
    const once = upsertChangelog(handWritten, first, cfg, "v2.4");
    expect(once).toBe(`# Candidate v2.3 change record\n\n${first}\n\n## v2.3, October 15, 2026\n\nOlder history.\n`);
    const second = renderChangelogSection(cfg, {
      name: "v2.4",
      baseLabel: "release v2.3",
      changes: [{ message: "m", changedPaths: [], findingIds: [], unlinkedReason: "why it is needed", createdAt: "2026-11-13T00:00:00Z" }],
      findings,
    });
    const twice = upsertChangelog(once, second, cfg, "v2.4");
    expect(twice).toBe(`# Candidate v2.3 change record\n\n${second}\n\n## v2.3, October 15, 2026\n\nOlder history.\n`);
    // Another revision's section stays when this one is inserted.
    const other = upsertChangelog(twice, renderChangelogSection(cfg, { name: "v2.5", baseLabel: "release v2.4", changes: [], findings }), cfg, "v2.5");
    expect(other).toContain(second);
    expect(other.indexOf("<!-- revision: v2.5")).toBeLessThan(other.indexOf("<!-- revision: v2.4"));
  });

  it("starts a record that doesn't exist with the policy title", () => {
    expect(upsertChangelog(null, "S", cfg, "v2.4")).toBe("# Change record\n\nS\n");
    expect(upsertChangelog("no title here\n", "S", cfg, "v2.4")).toBe("S\n\nno title here\n");
  });
});
