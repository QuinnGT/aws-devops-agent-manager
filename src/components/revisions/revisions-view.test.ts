import { describe, expect, it } from "vitest";
import { applyQuickFix, changelogPreview, deleteOpenFile, diffGroups, editedFiles, fileTerms, groupFindings, incidentAndText, lineCounts, markSaved, namesText, newFileProblem, preselectedFindings, rankFindings, renameOpenFile, restoreOpenFile, saveButtonReason, searchFindings, splitIncident, type OpenFile } from "./editor-state";
import { branchPreview, exportLeftOutText, folderPreview, matchesName, matchesState, nameProblem, parseRevisionListParams, planButtonReason, planHint, freeRevisionName, revisionListQuery, revisionNameFromFile, revisionWord, usualLayoutText } from "./words";

const file = (path: string, base: string | null, text: string): OpenFile => ({ path, base, text, kind: "text", size: text.length });

describe("revision state words", () => {
  const build = (status: "passed" | "failed", current = true) => ({ status, current });
  it("follows the page file's table, first rule that applies", () => {
    expect(revisionWord({ state: "creating", changes: 0, lastBuild: null, plan: null })).toBe("creating");
    expect(revisionWord({ state: "failed", changes: 0, lastBuild: null, plan: null })).toBe("createFailed");
    expect(revisionWord({ state: "abandoned", changes: 3, lastBuild: build("passed"), plan: null })).toBe("abandoned");
    expect(revisionWord({ state: "open", changes: 1, lastBuild: build("passed"), plan: { state: "applied" } })).toBe("applied");
    expect(revisionWord({ state: "open", changes: 1, lastBuild: build("passed"), plan: null, building: true })).toBe("building");
    expect(revisionWord({ state: "open", changes: 1, lastBuild: build("passed"), plan: { state: "waiting" } })).toBe("planned");
    expect(revisionWord({ state: "open", changes: 0, lastBuild: build("passed"), plan: null })).toBe("draft");
    expect(revisionWord({ state: "open", changes: 2, lastBuild: build("failed", false), plan: null })).toBe("draft");
    expect(revisionWord({ state: "open", changes: 2, lastBuild: build("failed"), plan: null })).toBe("buildFailed");
    expect(revisionWord({ state: "open", changes: 2, lastBuild: build("passed"), plan: { state: "discarded" } })).toBe("ready");
  });
});

describe("list filters", () => {
  it("reads and writes the URL without defaults", () => {
    expect(parseRevisionListParams({})).toEqual({ state: "open", q: "" });
    expect(parseRevisionListParams({ state: "nope", q: "  onset " })).toEqual({ state: "open", q: "onset" });
    expect(revisionListQuery({ state: "open", q: "" })).toBe("");
    expect(revisionListQuery({ state: "abandoned", q: "v2" })).toBe("?state=abandoned&q=v2");
  });

  it("counts creating and not-created revisions as open", () => {
    expect(["creating", "open", "failed"].every((s) => matchesState(s, "open"))).toBe(true);
    expect(matchesState("applied", "open")).toBe(false);
    expect(matchesState("abandoned", "abandoned")).toBe(true);
    expect(matchesState("applied", "all")).toBe(true);
    expect(matchesName("v2.4-Onset", "onset")).toBe(true);
  });
});

describe("New revision dialog", () => {
  const rule = { pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$", hint: "Use letters and numbers.", maxLength: 64 };
  it("checks the name against the policy rule and previews the branch and folder", () => {
    expect(nameProblem("v2.4-onset", rule)).toBeNull();
    expect(nameProblem("v2.4 onset", rule)).toBe("Use letters and numbers.");
    expect(nameProblem("", rule)).toBeNull();
    expect(nameProblem("a".repeat(65), rule)).toBe("Keep the name to 64 characters or fewer.");
    expect(branchPreview("revision/{spaceAlias}/{name}", "demo", "v2.4")).toBe("revision/demo/v2.4");
    expect(branchPreview("revision/{spaceAlias}/{name}", "demo", "")).toBe("revision/demo/<name>");
    expect(folderPreview("packages/{spaceAlias}/{package}", "demo", "v2.4")).toBe("packages/demo/v2.4/");
  });

  it("names a revision from an import's file name, within the rule", () => {
    expect(revisionNameFromFile("revised-instructions-v2.4.2.zip", 64)).toBe("revised-instructions-v2.4.2");
    expect(nameProblem(revisionNameFromFile("My Package (final).ZIP", 64), rule)).toBeNull();
    expect(revisionNameFromFile("My Package (final).ZIP", 64)).toBe("My-Package-final");
    expect(revisionNameFromFile("--.zip", 64)).toBe("import");
    expect(revisionNameFromFile(`${"a".repeat(70)}.zip`, 64)).toHaveLength(64);
    expect(freeRevisionName("v2.4.2", ["V2.4.2", "v2.4.2-2"], 64)).toBe("v2.4.2-3");
    expect(freeRevisionName("v2.4.2", [], 64)).toBe("v2.4.2");
    expect(freeRevisionName("a".repeat(64), ["a".repeat(64)], 64)).toBe(`${"a".repeat(62)}-2`);
  });
});

describe("export while the build fails", () => {
  it("says what the download leaves out", () => {
    expect(exportLeftOutText(2, "reference/EXPORT-NOTES.md")).toBe("Export package zip leaves out 2 assets until the errors are fixed. reference/EXPORT-NOTES.md in the zip says why.");
    expect(exportLeftOutText(1, null)).toBe("Export package zip leaves out 1 asset until the errors are fixed.");
    expect(exportLeftOutText(0, "reference/EXPORT-NOTES.md")).toBe("Export package zip keeps every asset, because the service accepts them as they are. reference/EXPORT-NOTES.md in the zip lists the errors.");
    expect(exportLeftOutText(null, "reference/EXPORT-NOTES.md")).toBe("Export package zip leaves out the assets the service would refuse. reference/EXPORT-NOTES.md in the zip says which and why.");
  });
});

describe("Create plan button", () => {
  const ok = { server: { available: true, reason: null }, dirty: false, building: false, changes: 2, baseLabel: "release v1.2", errors: 0, buildFailed: false, plan: null };
  it("says why it is unavailable, the page's own reasons first", () => {
    expect(planButtonReason(ok)).toBeNull();
    expect(planButtonReason({ ...ok, dirty: true, building: true })).toBe("Save your changes first.");
    expect(planButtonReason({ ...ok, building: true })).toBe("Building after your last save.");
    expect(planButtonReason({ ...ok, plan: { title: "Apply revision v2.4", state: "waiting" } })).toBe("Plan Apply revision v2.4 is open. Apply or discard it first.");
    expect(planButtonReason({ ...ok, buildFailed: true, errors: 2 })).toBe("The last build failed with 2 errors. Fix them and save to build again.");
    expect(planButtonReason({ ...ok, buildFailed: true, errors: 1 })).toBe("The last build failed with 1 error. Fix it and save to build again.");
    expect(planButtonReason({ ...ok, server: { available: false, reason: "The revision was abandoned." } })).toBe("The revision was abandoned.");
    expect(planButtonReason({ ...ok, changes: 0 })).toBe("No changes against release v1.2.");
  });
});

describe("editor state", () => {
  it("knows which files are edited, and makes saved text the new head text", () => {
    const files = { "b.md": file("b.md", "x\n", "y\n"), "a.md": file("a.md", "same\n", "same\n"), "new.md": file("new.md", null, "") };
    expect(editedFiles(files).map((f) => f.path)).toEqual(["b.md", "new.md"]);
    expect(editedFiles(markSaved(files, ["b.md", "new.md"]))).toEqual([]);
    expect(editedFiles({ "z.bin": { ...file("z.bin", null, ""), kind: "binary" } })).toEqual([]);
  });

  it("deletes, restores and renames files, and a save of a delete drops it", () => {
    const files = { "roles/payment_gw.md": file("roles/payment_gw.md", "x\n", "x\n"), "new.md": file("new.md", null, "n\n") };
    const deleted = deleteOpenFile(files, "roles/payment_gw.md");
    expect(editedFiles(deleted).map((f) => [f.path, f.deleted ?? false])).toEqual([
      ["new.md", false],
      ["roles/payment_gw.md", true],
    ]);
    // A file added in this tab just goes.
    expect(deleteOpenFile(files, "new.md")).not.toHaveProperty("new.md");
    expect(editedFiles(restoreOpenFile(deleted, "roles/payment_gw.md")).map((f) => f.path)).toEqual(["new.md"]);
    const renamed = renameOpenFile(files, "roles/payment_gw.md", "roles/payment-gw.md");
    expect(renamed["roles/payment-gw.md"]).toMatchObject({ base: null, text: "x\n", kind: "text" });
    expect(renamed["roles/payment_gw.md"]).toMatchObject({ deleted: true });
    expect(markSaved(renamed, ["roles/payment_gw.md", "roles/payment-gw.md"])).not.toHaveProperty("roles/payment_gw.md");
  });

  it("counts the lines of an edit", () => {
    expect(lineCounts("one\ntwo\n", "one\n2\nthree\n")).toEqual({ added: 2, removed: 1 });
    expect(lineCounts(null, "a\nb\n")).toEqual({ added: 2, removed: 0 });
  });

  it("refuses new file paths outside the package or already taken", () => {
    expect(newFileProblem("memory/patterns/new.md", ["memory/patterns/old.md"])).toBeNull();
    expect(newFileProblem("", [])).toMatch(/^Enter a path/);
    expect(newFileProblem("/etc/x", [])).toBe("Use a path inside the package, with folders separated by /.");
    expect(newFileProblem("a/../b.md", [])).toBe("Use a path inside the package, with folders separated by /.");
    expect(newFileProblem("a\\b.md", [])).toBe("Use a path inside the package, with folders separated by /.");
    expect(newFileProblem("a/b.md", ["a/b.md"])).toBe("A file with this path already exists.");
  });

  it("previews the changelog entry from the message, files and linked findings", () => {
    const f = [
      { id: "1", incidentId: "INCIDENT-31808", title: "INCIDENT-31808: x", records: [114, 121] },
      { id: "2", incidentId: null, title: "A fix", records: [] },
    ];
    expect(changelogPreview("Establish onset\n before changes", ["a.md", "b.md"], f, null)).toEqual({ title: "Establish onset before changes", files: "a.md, b.md", evidence: "INCIDENT-31808 (R114, R121), A fix" });
    expect(changelogPreview("", [], [], "The README needs it")).toEqual({ title: "Write a message", files: "None", evidence: "Not linked to a finding: The README needs it" });
  });

  it("searches findings by every word of the query", () => {
    const list = [
      { id: "1", title: "INCIDENT-31808: Ruled out Redis", incidentId: "INCIDENT-31808", kindLabel: "Diagnosis", auditName: "Late October" },
      { id: "2", title: "Look back across weekends", incidentId: "INCIDENT-32566", kindLabel: "Fix", auditName: "Late October" },
    ];
    expect(searchFindings(list, "").map((f) => f.id)).toEqual(["1", "2"]);
    expect(searchFindings(list, "redis diagnosis").map((f) => f.id)).toEqual(["1"]);
    expect(searchFindings(list, "32566").map((f) => f.id)).toEqual(["2"]);
  });

  it("says why Save and build can't be pressed yet, following the unlinked rule", () => {
    const base = { message: "Fix it", findings: 0, reason: "", rule: "reason" as const, reasonMinChars: 10, messageMaxChars: 200, files: 1 };
    expect(saveButtonReason({ ...base, files: 0 })).toBe("Edit a file first.");
    expect(saveButtonReason({ ...base, message: "  " })).toBe("Write a message.");
    expect(saveButtonReason(base)).toBe("Link at least one accepted finding, or say why the change is needed.");
    expect(saveButtonReason({ ...base, reason: "The README needs it." })).toBeNull();
    expect(saveButtonReason({ ...base, findings: 1 })).toBeNull();
    expect(saveButtonReason({ ...base, rule: "refuse" })).toBe("Link at least one accepted finding.");
    expect(saveButtonReason({ ...base, rule: "allow" })).toBeNull();
    expect(saveButtonReason({ ...base, findings: 1, message: "x".repeat(201) })).toBe("Keep the message to 200 characters or fewer.");
  });

  it("splits the incident off a finding title so it can be bold", () => {
    expect(splitIncident("INCIDENT-31808: Ruled out Redis", "INCIDENT-31808")).toEqual({ incident: "INCIDENT-31808", rest: ": Ruled out Redis" });
    expect(splitIncident("Look back", "INCIDENT-32566")).toEqual({ incident: null, rest: "Look back" });
  });
});

describe("save dialog finding order", () => {
  const f = (id: string, title: string, incidentId: string | null, text = "") => ({ id, title, incidentId, kindLabel: "Fix", auditName: "Late October", text });
  const list = [
    f("a", "Add a seat-map-service service-map entry", "INCIDENT-32336"),
    f("b", "INCIDENT-31801: read 0 ms 500s as a write stall", "INCIDENT-31801"),
    f("c", "In incident-rca.md, add a rule for fast-fail 5xx", "INCIDENT-31801"),
    f("d", "Update the change window skill", "INCIDENT-32607", "Add a step to change-window-search: compare the same weekday."),
    f("e", "Unrelated", null),
  ];

  it("names the edited files and skill folders, not generic file names", () => {
    expect(fileTerms(["instructions/incident-rca.md", "instructions/global.md", "skills/change-window-search/SKILL.md", "README.md"])).toEqual(["incident-rca.md", "incident-rca", "global.md", "change-window-search"]);
  });

  it("puts findings that name an edited file first, then their incidents, then the rest in order", () => {
    const r = rankFindings(list, ["instructions/incident-rca.md"]);
    expect(r.related.map((x) => x.id)).toEqual(["c", "b"]);
    expect(r.rest.map((x) => x.id)).toEqual(["a", "d", "e"]);
    expect(rankFindings(list, ["skills/change-window-search/SKILL.md"]).related.map((x) => x.id)).toEqual(["d"]);
    expect(rankFindings(list, ["README.md"])).toEqual({ related: [], rest: list });
    // The search also reads the finding's text.
    expect(searchFindings(list, "weekday").map((x) => x.id)).toEqual(["d"]);
  });
});

describe("findings sent to the revision in the save dialog", () => {
  const f = (id: string, title: string, incidentId: string | null, toAddress = false, text = "") => ({ id, title, incidentId, kindLabel: "Fix", auditName: "Late October", toAddress, text });
  const list = [f("a", "Plain fix", "INCIDENT-1"), f("b", "Sent fix", "INCIDENT-2", true), f("c", "Edit incident-rca.md", "INCIDENT-3"), f("d", "Sent too", "INCIDENT-4", true)];

  it("groups the sent findings first, then those naming an edited file, then the rest", () => {
    const groups = groupFindings(list, ["instructions/incident-rca.md"]);
    expect(groups.map((g) => [g.key, g.items.map((x) => x.id)])).toEqual([
      ["sent", ["b", "d"]],
      ["related", ["c"]],
      ["rest", ["a"]],
    ]);
    // Empty groups are left out, and a finding sent to the revision is never ranked as related.
    expect(groupFindings(list.filter((x) => !x.toAddress), []).map((g) => g.key)).toEqual(["rest"]);
    expect(groupFindings([], ["README.md"])).toEqual([]);
    expect(groupFindings(list, ["instructions/sent.md"]).find((g) => g.key === "related")).toBeUndefined();
  });

  it("ticks the sent findings, up to what one save can link, and says how many were left", () => {
    expect(preselectedFindings(list, 20)).toEqual({ ids: ["b", "d"], left: 0 });
    expect(preselectedFindings(list, 1)).toEqual({ ids: ["b"], left: 1 });
    expect(preselectedFindings(list, 0)).toEqual({ ids: [], left: 2 });
    expect(preselectedFindings([f("a", "x", null)], 5)).toEqual({ ids: [], left: 0 });
  });

  it("refuses a save that links more findings than the policy allows", () => {
    const base = { message: "Fix", findings: 3, reason: "", rule: "reason" as const, reasonMinChars: 10, messageMaxChars: 200, files: 1 };
    expect(saveButtonReason({ ...base, maxFindings: 3 })).toBeNull();
    expect(saveButtonReason({ ...base, maxFindings: 2 })).toBe("One save can link at most 2 findings.");
    expect(saveButtonReason(base)).toBeNull();
  });

  it("splits the incident ID off a finding's title for the to-address card", () => {
    expect(incidentAndText("INCIDENT-31499: kept a resolved gap open", "INCIDENT-31499")).toEqual({ incident: "INCIDENT-31499", text: "kept a resolved gap open" });
    expect(incidentAndText("Record precedents only as hypotheses", "INCIDENT-31495")).toEqual({ incident: "INCIDENT-31495", text: "Record precedents only as hypotheses" });
    expect(incidentAndText("A finding with no incident", null)).toEqual({ incident: null, text: "A finding with no incident" });
  });
});

describe("diff counts", () => {
  it("separates the files a person edited from the files the build wrote", () => {
    const d = (path: string, status = "modified") => ({ path, status });
    const files = [d("instructions/incident-rca.md"), d("reference/CHANGELOG.md", "added"), d("reference/VALIDATION.json"), d("README.md", "unchanged")];
    expect(diffGroups(files, ["reference/CHANGELOG.md", "reference/VALIDATION.json"])).toEqual({ edited: [files[0]], built: [files[1], files[2]] });
    expect(namesText(["CHANGELOG.md", "VALIDATION.json"])).toBe("CHANGELOG.md, VALIDATION.json");
    expect(namesText(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more");
  });
});

describe("header and New revision words", () => {
  it("says what a plan from the revision holds", () => {
    expect(planHint(null)).toBe("Checks the package against the live space. Nothing is written until the plan is applied.");
    expect(planHint({ changed: ["Incident RCA instructions"] })).toBe("Plans only what this revision changed (Incident RCA instructions). Nothing is written until the plan is applied.");
    expect(planHint({ changed: ["A", "B"] })).toBe("Plans only what this revision changed (A and B). Nothing is written until the plan is applied.");
    expect(planHint({ changed: ["A", "B", "C", "D"] })).toBe("Plans only the 4 assets this revision changed. Nothing is written until the plan is applied.");
  });

  it("says why the layout is preselected", () => {
    expect(usualLayoutText({ source: "import" }, "Nov 13")).toBe("Usual for this space: its last package import (Nov 13) used it.");
    expect(usualLayoutText({ source: "release", release: "v1.3" }, null)).toBe("Usual for this space: release v1.3 used it.");
    expect(usualLayoutText({ source: "default" }, null)).toBe("The app's default layout. This space has no package import or revision release yet.");
  });
});

describe("one-click fixes", () => {
  const file = (path: string, text: string): OpenFile => ({ path, base: text, text, kind: "text", size: text.length });
  it("replaces the lines the build saw, renames, and refuses a file that changed", () => {
    const text = "---\nname: roles/payment_gw\ndescription: Gateway.\n---\n# x\n";
    const files = { "memory/p/roles/payment_gw.md": file("memory/p/roles/payment_gw.md", text) };
    const fix = { label: "Rename to roles/payment-gw", edits: [{ kind: "replace-lines" as const, line: 2, count: 1, expect: "name: roles/payment_gw", text: "name: roles/payment-gw" }, { kind: "rename" as const, to: "memory/p/roles/payment-gw.md" }] };
    const r = applyQuickFix(files, "memory/p/roles/payment_gw.md", fix);
    if ("error" in r) throw new Error(r.error);
    expect(r.path).toBe("memory/p/roles/payment-gw.md");
    expect(r.line).toBe(2);
    expect(r.files["memory/p/roles/payment-gw.md"]!.text).toContain("name: roles/payment-gw\n");
    expect(r.files["memory/p/roles/payment_gw.md"]!.deleted).toBe(true);
    const edited = { "memory/p/roles/payment_gw.md": { ...files["memory/p/roles/payment_gw.md"]!, text: text.replace("payment_gw\n", "payment-x\n") } };
    expect(applyQuickFix(edited, "memory/p/roles/payment_gw.md", fix)).toEqual({ error: "The file changed since the last build. Save it to check it again." });
  });
});
