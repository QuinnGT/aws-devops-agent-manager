import {
  Folder,
  GitBranch,
  GitPullRequest,
  House,
  Layers,
  ListChecks,
  Microscope,
  NotebookText,
  RotateCcwClock,
  ScrollText,
  Settings,
  SlidersHorizontal,
  Tag,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Permission } from "@/server/policy/sections/roles";

/**
 * Sidebar navigation (design-system MASTER "Shell", navigation table).
 * `placeholder` items render PhasePlaceholder until their phase is built.
 */

export type NavRequirement = { kind: "space"; permission: Permission } | { kind: "signed-in" } | { kind: "app"; flag: "auditLog" | "appSettings" };

export interface NavItem {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Path under /spaces/[alias] (space items), or an absolute path */
  path: string;
  scope: "space" | "app";
  requires: NavRequirement;
  phase: number;
  placeholder: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

const space = (key: string, label: string, icon: LucideIcon, path: string, permission: Permission, phase = 1, placeholder = false): NavItem => ({
  key,
  label,
  icon,
  path,
  scope: "space",
  requires: { kind: "space", permission },
  phase,
  placeholder,
});

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Space",
    items: [
      space("home", "Home", House, "", "assets.read"),
      space("assets", "Assets", Layers, "/assets", "assets.read"),
      space("history", "History", RotateCcwClock, "/history", "history.read"),
      space("plans", "Plans", GitPullRequest, "/plans", "assets.read", 2),
      space("releases", "Releases", Tag, "/releases", "history.read", 2),
      // Not in the MASTER table: everyone who can see the space can find who holds each role.
      space("roles", "Who can do what", Users, "/roles", "assets.read"),
    ],
  },
  {
    label: "Investigations",
    items: [
      space("journals", "Journals", NotebookText, "/journals", "journals.read"),
      space("analysis", "Analysis", ListChecks, "/analysis", "audits.read"),
      space("audits", "Audits", Microscope, "/audits", "audits.read", 3),
      space("revisions", "Revisions", GitBranch, "/revisions", "audits.read", 4),
    ],
  },
  {
    label: "Admin",
    items: [
      space("space-settings", "Space settings", Settings, "/settings", "spaces.manage"),
      { key: "spaces", label: "All spaces", icon: Folder, path: "/spaces", scope: "app", requires: { kind: "signed-in" }, phase: 1, placeholder: false },
      { key: "audit-log", label: "Audit log", icon: ScrollText, path: "/audit-log", scope: "app", requires: { kind: "app", flag: "auditLog" }, phase: 1, placeholder: false },
      // Not in the MASTER table: history repositories and role bindings (/settings) need a way in.
      { key: "app-settings", label: "App settings", icon: SlidersHorizontal, path: "/settings", scope: "app", requires: { kind: "app", flag: "appSettings" }, phase: 1, placeholder: false },
    ],
  },
];

/**
 * The groups to render, each with its visible items. A group left with one
 * item (a Viewer's Admin group holds only All spaces) joins the group above,
 * so no heading sits over a lone item. Pure.
 */
export function visibleGroups(groups: readonly NavGroup[], isVisible: (item: NavItem) => boolean): NavGroup[] {
  const out: NavGroup[] = [];
  for (const g of groups) {
    const items = g.items.filter(isVisible);
    if (items.length === 0) continue;
    const prev = out.at(-1);
    if (items.length === 1 && prev) prev.items.push(...items);
    else out.push({ label: g.label, items });
  }
  return out;
}

/** Permissions the sidebar needs per space, so the layout loads only these. */
export const NAV_SPACE_PERMISSIONS: Permission[] = [
  ...new Set(NAV_GROUPS.flatMap((g) => g.items.flatMap((i) => (i.requires.kind === "space" ? [i.requires.permission] : [])))),
];

export function spaceBase(alias: string): string {
  return `/spaces/${encodeURIComponent(alias)}`;
}

/** The space alias in a pathname such as /spaces/demo/assets, or null (also for /spaces and /spaces/new). */
export function aliasFromPath(pathname: string): string | null {
  const m = /^\/spaces\/([^/]+)/.exec(pathname);
  if (!m?.[1] || m[1] === "new") return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export function navHref(item: NavItem, alias: string | null): string | null {
  if (item.scope === "app") return item.path;
  return alias ? spaceBase(alias) + item.path : null;
}

/** Whether the item is the current page: Home matches exactly, others by prefix. Plans also covers the drafts screen. */
export function isActive(item: NavItem, href: string, pathname: string): boolean {
  if (item.key === "home") return pathname === href;
  if (item.key === "spaces") return pathname === "/spaces" || pathname === "/";
  if (item.key === "plans" && isUnder(pathname, href.replace(/\/plans$/, "/drafts"))) return true;
  return isUnder(pathname, href);
}

function isUnder(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
