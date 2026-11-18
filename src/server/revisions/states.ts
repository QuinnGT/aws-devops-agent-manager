import type { RevisionsPolicy } from "@/server/policy/sections/revisions";
import { buildPassedAtHead } from "./build";
import type { RevisionBuild } from "./types";

/**
 * Why a revision can't become a plan or a download right now, in plain
 * words, or null when it can. Shared by the services (which refuse) and the
 * detail loader (which explains the disabled button). Pure.
 */

/** Plan states in which the plan is still being worked on. */
export const OPEN_PLAN_STATES = ["checking", "ready", "waiting", "approved", "applying"] as const;

export interface RevisionStateView {
  state: string;
  stateReason: string | null;
  headCommit: string | null;
  latestBuild: RevisionBuild | null;
  releaseName: string | null;
}

function stateBlocker(r: RevisionStateView): string | null {
  switch (r.state) {
    case "creating":
      return "The revision is still being created.";
    case "failed":
      return `The revision could not be created${r.stateReason ? `: ${r.stateReason}` : "."}`;
    case "abandoned":
      return "The revision was abandoned.";
    default:
      return null;
  }
}

function buildBlocker(r: RevisionStateView): string | null {
  const b = r.latestBuild;
  if (!b || !r.headCommit || b.commit !== r.headCommit) return "The build of the latest save hasn't finished.";
  if (!buildPassedAtHead(b, r.headCommit)) {
    return `The build and validation failed with ${b.errors} ${b.errors === 1 ? "error" : "errors"}. Fix ${b.errors === 1 ? "it" : "them"} and save again.`;
  }
  return null;
}

/** Why "Create plan" is unavailable: state, build, or a plan from the revision that is still open or already applied. */
export function planBlocker(r: RevisionStateView, plan: { state: string; title: string } | null): string | null {
  const s = stateBlocker(r);
  if (s) return s;
  if (r.state === "applied" || plan?.state === "applied") {
    return `A plan from this revision was already applied${r.releaseName ? ` and tagged as release ${r.releaseName}` : ""}. Start a new revision for further changes.`;
  }
  if (plan && (OPEN_PLAN_STATES as readonly string[]).includes(plan.state)) return `The plan "${plan.title}" from this revision is still open. Apply or discard it first.`;
  return buildBlocker(r);
}

/** Why the package download is refused (revisions.yaml export.requirePassingBuild), or null. */
export function exportBlocker(r: RevisionStateView, policy: { export: Pick<RevisionsPolicy["export"], "requirePassingBuild"> }): string | null {
  if (r.state === "creating" || r.state === "failed" || !r.headCommit) return stateBlocker(r) ?? "The revision has no commits yet.";
  if (!policy.export.requirePassingBuild) return null;
  const b = buildBlocker(r);
  return b ? `The package can't be downloaded yet. ${b}` : null;
}

/** Why saving is refused, or null. */
export function saveBlocker(r: RevisionStateView): string | null {
  if (r.state === "applied") return "A plan from this revision was already applied. Start a new revision for further changes.";
  return stateBlocker(r);
}
