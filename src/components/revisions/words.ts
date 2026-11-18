import { CircleCheck, CircleX, GitMerge, GitPullRequest, Loader, SquarePen } from "lucide-react";
import type { StatusSpec } from "@/components/common/status-words";

/**
 * Words, tones and icons for revision states and builds (pages/revisions.md,
 * "States"), and the pure rules the revision pages show: which state a row
 * is in, the list filters, and why "Create plan" is unavailable. The status
 * presets for revision words live here, not in common/status-words.ts. Pure;
 * unit-tested.
 */

export type RevisionWord = "draft" | "buildFailed" | "ready" | "planned" | "applied" | "abandoned" | "creating" | "createFailed" | "building";

export const REVISION_STATUS = {
  draft: { tone: "neutral", icon: SquarePen, label: "Draft" },
  buildFailed: { tone: "destructive", icon: CircleX, label: "Build failed" },
  ready: { tone: "success", icon: CircleCheck, label: "Ready" },
  planned: { tone: "info", icon: GitPullRequest, label: "Planned" },
  applied: { tone: "success", icon: GitMerge, label: "Applied" },
  abandoned: { tone: "neutral", icon: CircleX, label: "Abandoned" },
  creating: { tone: "info", icon: Loader, label: "Creating" },
  createFailed: { tone: "destructive", icon: CircleX, label: "Not created" },
  building: { tone: "info", icon: Loader, label: "Building" },
} as const satisfies Record<RevisionWord, StatusSpec>;

/** Plan states in which a plan from the revision is still open (server OPEN_PLAN_STATES). */
const OPEN_PLAN = new Set(["checking", "ready", "waiting", "approved", "applying"]);

export interface RevisionStateInput {
  state: "creating" | "open" | "applied" | "abandoned" | "failed" | string;
  changes: number;
  lastBuild: { status: "passed" | "failed"; current: boolean } | null;
  plan: { state: string } | null;
  /** A save's build job is queued or running */
  building?: boolean;
}

/** The state word of a revision (revisions.md "States"), first rule that applies. */
export function revisionWord(r: RevisionStateInput): RevisionWord {
  if (r.state === "creating") return "creating";
  if (r.state === "failed") return "createFailed";
  if (r.state === "abandoned") return "abandoned";
  if (r.state === "applied" || r.plan?.state === "applied") return "applied";
  if (r.building) return "building";
  if (r.plan && OPEN_PLAN.has(r.plan.state)) return "planned";
  if (r.changes === 0 || !r.lastBuild || !r.lastBuild.current) return "draft";
  return r.lastBuild.status === "failed" ? "buildFailed" : "ready";
}

export type StateFilter = "open" | "applied" | "abandoned" | "all";

export const STATE_FILTERS: { value: StateFilter; label: string; hint?: string }[] = [
  { value: "open", label: "Open", hint: "Draft, build failed, ready, planned" },
  { value: "applied", label: "Applied" },
  { value: "abandoned", label: "Abandoned" },
  { value: "all", label: "All" },
];

/** Whether a revision row matches the state filter. Creating and not-created revisions count as open. */
export function matchesState(state: string, filter: StateFilter): boolean {
  if (filter === "all") return true;
  if (filter === "applied") return state === "applied";
  if (filter === "abandoned") return state === "abandoned";
  return state !== "applied" && state !== "abandoned";
}

export interface RevisionListParams {
  state: StateFilter;
  q: string;
}

type Raw = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parseRevisionListParams(sp: Raw): RevisionListParams {
  const state = first(sp.state);
  return {
    state: STATE_FILTERS.some((f) => f.value === state) ? (state as StateFilter) : "open",
    q: (first(sp.q) ?? "").trim().slice(0, 200),
  };
}

/** Query string without defaults ("" or "?state=all&q=onset"). */
export function revisionListQuery(p: Partial<RevisionListParams>): string {
  const q = new URLSearchParams();
  if (p.state && p.state !== "open") q.set("state", p.state);
  if (p.q) q.set("q", p.q);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** Case-insensitive name match for the list's name filter. */
export function matchesName(name: string, q: string): boolean {
  return !q || name.toLowerCase().includes(q.toLowerCase());
}

const plural = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;

/** "Passed" or "<N> errors" for a build. */
export function buildWord(b: { status: "passed" | "failed"; errors: number }): StatusSpec {
  return b.status === "passed" ? { tone: "success", icon: CircleCheck, label: "Passed" } : { tone: "destructive", icon: CircleX, label: plural(b.errors, "error", "errors") };
}

/** The branch name preview the New revision dialog shows (history-layout revisionBranch). */
export function branchPreview(template: string, alias: string, name: string): string {
  return template.replace("{spaceAlias}", alias).replace("{name}", name || "<name>");
}

/** The package folder preview (history-layout packageDir, package name from revisions.packageName). */
export function folderPreview(template: string, alias: string, packageName: string): string {
  return `${template.replace("{spaceAlias}", alias).replace("{package}", packageName || "<name>")}/`;
}

/** Client-side check of a revision name against the policy pattern; the server checks again on create. */
export function nameProblem(name: string, rule: { pattern: string; hint: string; maxLength: number }): string | null {
  if (!name) return null;
  if (name.length > rule.maxLength) return `Keep the name to ${rule.maxLength} characters or fewer.`;
  let re: RegExp;
  try {
    re = new RegExp(rule.pattern);
  } catch {
    return null;
  }
  return re.test(name) ? null : rule.hint;
}

/** A revision name from an uploaded file's name ("revised-instructions-v2.4.2.zip" -> "revised-instructions-v2.4.2"), for "Fix in a revision". The person can change it. */
export function revisionNameFromFile(fileName: string, maxLength: number): string {
  const stem = fileName.replace(/\.zip$/i, "");
  const name = stem
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .slice(0, maxLength)
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
  return name || "import";
}

/** `name`, or the first of name-2, name-3, ... that no revision has (compared ignoring case), within `maxLength`. */
export function freeRevisionName(name: string, taken: readonly string[], maxLength: number): string {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const candidate = `${name.slice(0, maxLength - suffix.length)}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}

export interface PlanButtonInput {
  /** The server's answer (loadRevisionDetail actions.createPlan) */
  server: { available: boolean; reason: string | null };
  /** Unsaved edits in the editor */
  dirty: boolean;
  /** A save's build is queued or running */
  building: boolean;
  /** Saves so far */
  changes: number;
  baseLabel: string;
  /** Errors of the latest build */
  errors: number;
  buildFailed: boolean;
  plan: { title: string; state: string } | null;
}

/**
 * Why "Create plan" is unavailable (revision-detail.md, "Disabled reasons"),
 * or null when it can be used. The page's own reasons come first because
 * they are about what the person is doing right now; then the server's.
 */
export function planButtonReason(p: PlanButtonInput): string | null {
  if (p.dirty) return "Save your changes first.";
  if (p.building) return "Building after your last save.";
  if (p.plan && OPEN_PLAN.has(p.plan.state)) return `Plan ${p.plan.title} is open. Apply or discard it first.`;
  if (p.buildFailed && p.errors > 0) return `The last build failed with ${plural(p.errors, "error", "errors")}. Fix ${p.errors === 1 ? "it" : "them"} and save to build again.`;
  if (!p.server.available) return p.server.reason;
  if (p.changes === 0) return `No changes against ${p.baseLabel}.`;
  return null;
}

/** The line under "Create plan": what the plan holds (the assets the revision changed) and that nothing is written yet. */
export function planHint(scope: { changed: readonly string[] } | null | undefined): string {
  const tail = "Nothing is written until the plan is applied.";
  const n = scope?.changed.length ?? 0;
  if (!scope || n === 0) return `Checks the package against the live space. ${tail}`;
  if (n === 1) return `Plans only what this revision changed (${scope.changed[0]}). ${tail}`;
  if (n <= 3) return `Plans only what this revision changed (${scope.changed.slice(0, -1).join(", ")} and ${scope.changed.at(-1)}). ${tail}`;
  return `Plans only the ${n} assets this revision changed. ${tail}`;
}

/** Why the New revision dialog starts with this layout (layouts.ts usualLayout). */
export function usualLayoutText(usual: { source: "import" | "release" | "default"; release?: string | null }, date: string | null): string {
  if (usual.source === "import") return `Usual for this space: its last package import${date ? ` (${date})` : ""} used it.`;
  if (usual.source === "release") return `Usual for this space: ${usual.release ? `release ${usual.release}` : "its last release"} used it.`;
  return "The app's default layout. This space has no package import or revision release yet.";
}

/** "Based on release v1.2" or "Based on the live space". */
export function basedOnText(base: { kind: string; label: string }): string {
  return `Based on ${base.label}`;
}

/** "Release v1.2" or "Live space, Nov 11" for the list's Based on column (the date is filled in by the caller). */
export function baseCellText(base: { kind: string; releaseName?: string | null }): string {
  return base.kind === "release" && base.releaseName ? `Release ${base.releaseName}` : "Live space";
}

/**
 * The build card's line about "Export package zip" while the build fails
 * (revision-detail.md): the download leaves out the assets the service would refuse.
 * `leftOut` is null for a build stored before the count was recorded.
 */
export function exportLeftOutText(leftOut: number | null, note: string | null): string {
  const where = (what: string) => (note ? ` ${note} in the zip ${what}.` : "");
  if (leftOut === null) return `Export package zip leaves out the assets the service would refuse.${where("says which and why")}`;
  if (leftOut === 0) return `Export package zip keeps every asset, because the service accepts them as they are.${where("lists the errors")}`;
  return `Export package zip leaves out ${leftOut} ${leftOut === 1 ? "asset" : "assets"} until the errors are fixed.${where("says why")}`;
}
