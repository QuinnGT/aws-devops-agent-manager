import { describe, expect, it } from "vitest";
import { COMMAND_PAGES, commandPagesFor, matchWords } from "./command-pages";
import { NAV_GROUPS, visibleGroups } from "./nav";

const VIEWER = new Set(["assets.read", "history.read", "journals.read", "journals.export", "audits.read"]);

describe("sidebar groups", () => {
  it("moves a lone item into the group above, so a Viewer's All spaces has no Admin heading", () => {
    const groups = visibleGroups(NAV_GROUPS, (i) => (i.requires.kind === "space" ? VIEWER.has(i.requires.permission) : i.requires.kind === "signed-in"));
    expect(groups.map((g) => g.label)).toEqual(["Space", "Investigations"]);
    expect(groups.at(-1)?.items.at(-1)?.key).toBe("spaces");
    expect(groups.every((g) => g.items.length > 1)).toBe(true);
    expect(groups[0]?.items.map((i) => i.label)).toContain("Who can do what");
  });

  it("keeps every group for an Admin", () => {
    expect(visibleGroups(NAV_GROUPS, () => true).map((g) => g.label)).toEqual(["Space", "Investigations", "Admin"]);
  });
});

describe("command search pages", () => {
  const all = new Set(["assets.read", "history.read", "plans.create", "releases.create", "drafts.write", "journals.read", "spaces.manage"]);
  const links = commandPagesFor("/spaces/demo", { space: all, auditLog: true, appSettings: true });
  const find = (word: string) => links.filter((l) => l.keywords.includes(word) || l.label.toLowerCase().includes(word)).map((l) => l.key);

  it("offers a page for each everyday word", () => {
    expect(find("global")).toContain("global");
    expect(find("instructions")).toContain("global");
    expect(find("snapshot")).toEqual(expect.arrayContaining(["releases", "create-release"]));
    expect(find("release")).toContain("releases");
    expect(find("undo")).toEqual(expect.arrayContaining(["history", "restore", "releases"]));
    expect(find("restore")).toContain("restore");
    expect(find("history")).toContain("history");
    expect(find("roles")).toContain("roles");
    expect(find("settings")).toEqual(expect.arrayContaining(["space-settings", "app-settings"]));
    expect(find("import")).toContain("import");
    expect(find("approve")).toEqual(expect.arrayContaining(["plans", "roles"]));
  });

  it("links space pages under the space and hides what the user can't open", () => {
    expect(links.find((l) => l.key === "releases")?.href).toBe("/spaces/demo/releases");
    expect(links.find((l) => l.key === "audit-log")?.href).toBe("/audit-log");
    expect(links.find((l) => l.key === "roles")?.href).toBe("/spaces/demo/roles");
    const viewer = commandPagesFor("/spaces/demo", { space: VIEWER, auditLog: false, appSettings: false }).map((l) => l.key);
    expect(viewer).toEqual(expect.arrayContaining(["home", "history", "releases", "roles", "spaces"]));
    expect(viewer).not.toContain("create-release");
    expect(viewer).not.toContain("space-settings");
    expect(viewer).not.toContain("audit-log");
    expect(new Set(COMMAND_PAGES.map((p) => p.key)).size).toBe(COMMAND_PAGES.length);
  });
});

describe("command search matching", () => {
  it("matches typed words as substrings of the value or keywords, not letter by letter", () => {
    expect(matchWords("page releases Releases", "snapshot", ["snapshot", "undo"])).toBe(1);
    expect(matchWords("page roles Who can do what", "snapshot", ["roles", "permissions", "approve"])).toBe(0);
    expect(matchWords("Global instructions ki-1", "global instr", ["GENERIC"])).toBe(1);
    expect(matchWords("Global instructions ki-1", "generic", ["GENERIC"])).toBe(1);
    expect(matchWords("anything", "  ")).toBe(1);
  });
});
