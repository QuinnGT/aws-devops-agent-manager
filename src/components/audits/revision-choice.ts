import type { FixContext } from "@/server/audits/fixes";
import { isQueued } from "@/server/audits/revision-stage";

/**
 * The open revisions "Add to revision…" offers, with what a person needs to
 * tell them apart: what each started from, who started it and when, which
 * audits its findings come from, and how far it has got. Plain data, so it
 * crosses to the client. Pure; unit-tested.
 */

export interface RevisionChoice {
  id: string;
  name: string;
  /** open, creating */
  state: string;
  /** Where it stands in words: "No saves yet", "Saved, no plan yet", "Planned: …", "Applied to the space" */
  stage: string;
  /** Accepted findings on its to-address list, and findings its saves linked */
  toAddress: number;
  linked: number;
  /** What it started from: "Live space" or a release */
  base: string;
  /** Who started it (a display name) and when (ISO) */
  by: string;
  at: string;
  /** The audits its findings come from; `here` marks this audit */
  audits: { id: string; name: string; findings: number; here: boolean }[];
  /** Findings of this audit in it */
  fromThisAudit: number;
}

export const NEW_REVISION = "new";

/** The choice to start from: a revision that already holds findings from this audit (the one with most), else a new revision. */
export function defaultChoice(choices: readonly Pick<RevisionChoice, "id" | "fromThisAudit">[]): string {
  let best: Pick<RevisionChoice, "id" | "fromThisAudit"> | null = null;
  for (const c of choices) if (c.fromThisAudit > 0 && (!best || c.fromThisAudit > best.fromThisAudit)) best = c;
  return best?.id ?? NEW_REVISION;
}

/** The open revisions as choices, newest first. A revision whose details couldn't be read keeps its name and counts. */
export function revisionChoices(ctx: Pick<FixContext, "options" | "revisions">, auditId: string, nameOf: (email: string) => string): RevisionChoice[] {
  return ctx.options.map((o) => {
    const info = ctx.revisions.get(o.id);
    return {
      id: o.id,
      name: o.name,
      state: o.state,
      stage: info?.stage.words ?? (o.state === "creating" ? "Being created" : ""),
      toAddress: o.toAddress,
      linked: o.linked,
      base: info?.base ?? "",
      by: info ? nameOf(info.createdBy) : "",
      at: (info?.createdAt ?? o.updatedAt).toISOString(),
      audits: (info?.audits ?? []).map((a) => ({ id: a.auditId, name: a.auditName, findings: a.findings, here: a.auditId === auditId })),
      fromThisAudit: info?.fromThisAudit ?? 0,
    };
  });
}

/** A revision holding this audit's accepted package fixes that has work left before they reach the agent. */
export interface QueuedRevision {
  id: string;
  name: string;
  stage: string;
  /** Accepted package fixes of this audit in it */
  fixes: number;
}

/** The revisions still waiting on this audit's fixes: no saves yet, saved, or planned but not applied. Most fixes first. */
export function queuedRevisions(ctx: Pick<FixContext, "revisions">): QueuedRevision[] {
  return [...ctx.revisions.values()]
    .filter((r) => r.fromThisAudit > 0 && isQueued(r.stage.stage))
    .map((r) => ({ id: r.id, name: r.name, stage: r.stage.words, fixes: r.fromThisAudit }))
    .sort((a, b) => b.fixes - a.fixes || a.name.localeCompare(b.name));
}
