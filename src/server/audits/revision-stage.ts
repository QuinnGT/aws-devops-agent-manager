import type { FindingRevisionLink } from "@/server/revisions";

/**
 * How far a revision, or a finding in one, has got, in plain words. A fix in a
 * revision is only queued: it reaches the agent after someone edits the files
 * in the revision, saves, and applies the revision's plan. Pure; unit-tested.
 */

/** A plan's state in a sentence. */
export function planStateWords(state: string): string {
  const words: Record<string, string> = {
    checking: "being checked",
    ready: "ready to apply",
    waiting: "waiting for approval",
    approved: "approved, not applied yet",
    applying: "being applied",
    applied: "applied",
    failed: "failed",
    discarded: "discarded",
  };
  return words[state] ?? state;
}

export type RevisionStage = "creating" | "no-saves" | "saved" | "planned" | "applied" | "abandoned" | "failed";

export interface RevisionStageInput {
  /** creating, open, applied, abandoned or failed */
  state: string;
  /** Saves (commits of the person's edits) */
  changes: number;
  /** The latest plan made from the revision, if any */
  plan: { state: string } | null;
}

/** Where a revision is: no saves yet, saved, planned, applied, or out of the running. */
export function revisionStage(r: RevisionStageInput): { stage: RevisionStage; words: string } {
  if (r.state === "creating") return { stage: "creating", words: "Being created" };
  if (r.state === "failed") return { stage: "failed", words: "Couldn't be created" };
  if (r.state === "abandoned") return { stage: "abandoned", words: "Abandoned" };
  if (r.state === "applied" || r.plan?.state === "applied") return { stage: "applied", words: "Applied to the space" };
  if (r.plan && r.plan.state !== "discarded") return { stage: "planned", words: `Planned: the plan is ${planStateWords(r.plan.state)}` };
  if (r.changes > 0) return { stage: "saved", words: "Saved, no plan yet" };
  return { stage: "no-saves", words: "No saves yet" };
}

/** A revision that still has work before its fixes reach the agent. */
export const isQueued = (stage: RevisionStage): boolean => stage === "no-saves" || stage === "saved" || stage === "planned" || stage === "creating";

/** Where one finding stands in one revision, from the link the revisions module gives. */
export function linkStageWords(l: Pick<FindingRevisionLink, "revisionState" | "kind" | "planId" | "planState" | "releaseName">): string {
  if (l.revisionState === "creating") return "The revision is being created";
  if (l.revisionState === "failed") return "The revision couldn't be created";
  if (l.revisionState === "abandoned") return "The revision was abandoned";
  if (l.planState === "applied" || l.revisionState === "applied") return "Applied to the space";
  if (l.planId) return `Planned: the plan is ${planStateWords(l.planState ?? "checking")}`;
  return l.kind === "linked" ? "Made in a save, no plan yet" : "Not made yet: no save has addressed it";
}

/** Whether a finding's link says its fix reached the space. */
export const linkApplied = (l: Pick<FindingRevisionLink, "revisionState" | "planState">): boolean => l.planState === "applied" || l.revisionState === "applied";
