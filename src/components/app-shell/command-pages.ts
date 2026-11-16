import type { Permission } from "@/server/policy/sections/roles";

/**
 * Pages and actions the command search offers besides asset names, with the
 * everyday words people type for them ("snapshot" finds Releases, "undo"
 * finds History and Releases). One row per entry; `path` is under
 * /spaces/[alias] unless `app` is set.
 */

export interface CommandPage {
  key: string;
  label: string;
  /** One short line under the label */
  hint: string;
  path: string;
  app?: boolean;
  /** Permission in the space (app pages: in any space or globally, as the sidebar decides) */
  requires: Permission | "signed-in" | "auditLog" | "appSettings";
  keywords: string[];
}

export const COMMAND_PAGES: CommandPage[] = [
  { key: "home", label: "Home", hint: "What needs attention and what changed", path: "", requires: "assets.read", keywords: ["home", "overview", "dashboard", "start"] },
  {
    key: "global",
    label: "Instructions",
    hint: "Global instructions, read by every agent, and one file per agent type",
    path: "/assets?type=agents_md",
    requires: "assets.read",
    keywords: ["global", "instructions", "agents.md", "agents_md", "generic", "prompt"],
  },
  { key: "assets", label: "Assets", hint: "Instructions, skills, memories and the other assets", path: "/assets", requires: "assets.read", keywords: ["assets", "skills", "memories", "memory", "artifacts", "custom agents"] },
  {
    key: "history",
    label: "History",
    hint: "Every recorded change and who made it",
    path: "/history",
    requires: "history.read",
    keywords: ["history", "changes", "who changed", "versions", "undo", "restore", "diff", "compare"],
  },
  {
    key: "restore",
    label: "Restore an older version",
    hint: "Open an asset, then Versions, then Restore this version",
    path: "/assets",
    requires: "plans.create",
    keywords: ["undo", "restore", "revert", "roll back", "rollback", "older version", "previous version"],
  },
  {
    key: "releases",
    label: "Releases",
    hint: "Saved snapshots of every asset that you can restore later",
    path: "/releases",
    requires: "history.read",
    keywords: ["releases", "release", "snapshot", "snapshots", "restore", "undo", "roll back", "rollback", "tag"],
  },
  {
    key: "create-release",
    label: "Create a release",
    hint: "Save a snapshot of every asset now",
    path: "/releases?create=1",
    requires: "releases.create",
    keywords: ["snapshot", "save", "release", "create", "backup"],
  },
  { key: "plans", label: "Plans", hint: "Review, approve and apply changes", path: "/plans", requires: "assets.read", keywords: ["plans", "approve", "approval", "apply", "review", "pending"] },
  { key: "drafts", label: "Drafts", hint: "Your edits, saved in this app", path: "/drafts", requires: "drafts.write", keywords: ["drafts", "edit", "change"] },
  { key: "import", label: "Import package", hint: "Upload an instruction package as a plan", path: "/plans/import", requires: "plans.create", keywords: ["import", "package", "upload", "zip"] },
  { key: "journals", label: "Journals", hint: "Investigation journals and exports", path: "/journals", requires: "journals.read", keywords: ["journals", "investigations", "export"] },
  {
    key: "roles",
    label: "Who can do what",
    hint: "Roles in this space and who holds them",
    path: "/roles",
    requires: "assets.read",
    keywords: ["roles", "permissions", "who can approve", "approve", "approver", "admin", "publisher", "editor", "viewer", "access"],
  },
  {
    key: "space-settings",
    label: "Space settings",
    hint: "Connection, change capture, plan rules and role bindings",
    path: "/settings",
    requires: "spaces.manage",
    keywords: ["settings", "configure", "connection", "approval", "second person", "bindings"],
  },
  { key: "app-settings", label: "App settings", hint: "History repositories and roles for all spaces", path: "/settings", app: true, requires: "appSettings", keywords: ["settings", "roles", "bindings", "repositories"] },
  { key: "audit-log", label: "Audit log", hint: "Who did what in this app", path: "/audit-log", app: true, requires: "auditLog", keywords: ["audit", "log", "activity"] },
  { key: "spaces", label: "All spaces", hint: "Every registered Agent Space", path: "/spaces", app: true, requires: "signed-in", keywords: ["spaces", "switch space"] },
];

export interface CommandPageLink {
  key: string;
  label: string;
  hint: string;
  href: string;
  keywords: string[];
}

/** The entries the caller may open, with their links. Pure. */
export function commandPagesFor(
  spaceBase: string,
  can: { space: ReadonlySet<string>; auditLog: boolean; appSettings: boolean },
  pages: readonly CommandPage[] = COMMAND_PAGES,
): CommandPageLink[] {
  return pages
    .filter((p) => (p.requires === "signed-in" ? true : p.requires === "auditLog" ? can.auditLog : p.requires === "appSettings" ? can.appSettings : can.space.has(p.requires)))
    .map((p) => ({ key: p.key, label: p.label, hint: p.hint, href: p.app ? p.path : `${spaceBase}${p.path}`, keywords: p.keywords }));
}

/**
 * Substring match on the item's value and keywords, every typed word
 * required. cmdk's default fuzzy score lets "snapshot" match "Who can do
 * what" letter by letter; a page should come up only for its own words.
 */
export function matchWords(value: string, search: string, keywords?: string[]): number {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const hay = [value, ...(keywords ?? [])].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w)) ? 1 : 0;
}
