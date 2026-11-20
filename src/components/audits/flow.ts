import type { AuditItemState, AuditState } from "@/server/audits/states";
import { plural, reviewProgressText } from "./words";

/**
 * The strip at the top of an audit (pages/audit-detail.md, "Flow strip"): the
 * five steps of the audit with what is left at each, so accepting a fix is
 * not the end of the page. Pure; unit-tested. The component only lays it out.
 */

export const FLOW_STEPS = ["reviews", "decide", "fix", "report", "record"] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

export interface FlowInput {
  state: AuditState;
  items: Record<AuditItemState, number>;
  /** Citations the checks looked at in the current reviews, and how many failed */
  citations: { checked: number; failed: number };
  findings: { proposed: number; accepted: number; rejected: number; total: number };
  /** Accepted package fixes, how many are in a revision and how many of those were applied; null when the revisions couldn't be read */
  fix: { total: number; inRevision: number | null; applied?: number | null };
  /** The sections the saved report holds, and the ones left out because they have no text yet */
  report: { built: boolean; sections: number; empty?: number };
  /** The commit of the saved record, or null */
  commit: string | null;
}

export interface FlowCell {
  step: FlowStep;
  label: string;
  /** The line under the label; `strong` is the part to read first */
  value: { strong: string | null; rest: string };
  /** The step has nothing left to do */
  done: boolean;
  /** A second muted line: "85 citations passed" */
  detail: string | null;
  tone: "normal" | "warning";
}

export interface FlowStrip {
  cells: FlowCell[];
  /** The first step that isn't done: where the person is. The last one when all are done; null for a cancelled audit */
  current: FlowStep | null;
}

const LABELS: Record<FlowStep, string> = { reviews: "Reviews", decide: "Decide", fix: "Fix in a revision", report: "Report", record: "Record" };

/** The citations line: "85 citations passed", "3 of 88 citations failed the check". */
export function citationsLine(c: { checked: number; failed: number }): string | null {
  if (c.checked === 0) return null;
  return c.failed > 0 ? `${c.failed} of ${plural(c.checked, "citation")} failed the check` : `${plural(c.checked, "citation")} passed`;
}

export function flowStrip(i: FlowInput): FlowStrip {
  const progress = reviewProgressText(i.items);
  const finished = i.items.pending + i.items.analyzing + i.items.reviewing === 0;
  const total = i.items.pending + i.items.analyzing + i.items.reviewing + i.items.reviewed + i.items.failed;

  const reviews: FlowCell = {
    step: "reviews",
    label: LABELS.reviews,
    value: { strong: null, rest: progress.value },
    done: finished && i.items.reviewed > 0 && i.items.failed === 0,
    detail: [progress.failed, citationsLine(i.citations)].filter(Boolean).join(" · ") || null,
    tone: i.items.failed > 0 || i.citations.failed > 0 ? "warning" : "normal",
  };

  const left = i.findings.proposed;
  const decide: FlowCell = {
    step: "decide",
    label: LABELS.decide,
    value:
      i.findings.total === 0
        ? { strong: null, rest: "No findings yet" }
        : left > 0
          ? { strong: `${left} to decide`, rest: ` · ${i.findings.accepted} accepted` }
          : { strong: "All decided", rest: ` · ${i.findings.accepted} accepted` },
    done: i.findings.total > 0 && left === 0,
    detail: null,
    tone: "normal",
  };

  const f = i.fix;
  const inRev = f.inRevision;
  const notIn = inRev === null ? 0 : f.total - inRev;
  const fix: FlowCell = {
    step: "fix",
    label: LABELS.fix,
    value: f.total === 0 ? { strong: null, rest: "No package fixes" } : inRev === null ? { strong: null, rest: plural(f.total, "accepted package fix", "accepted package fixes") } : { strong: null, rest: `${inRev} of ${plural(f.total, "package fix", "package fixes")}` },
    // In a revision is only queued: it reaches the agent after edits, a save and an applied plan.
    detail:
      f.total === 0 || inRev === null
        ? null
        : notIn > 0
          ? `${notIn} in no revision yet. ${inRev > 0 ? "The rest are queued, not applied." : ""}`.trim()
          : (f.applied ?? 0) >= f.total
            ? "All applied to the space"
            : "Queued only: applied after edits, a save and the plan",
    // With no accepted package fix, or when the revisions can't be read, this step doesn't say where the person is.
    done: f.total === 0 || inRev === null || inRev === f.total,
    tone: notIn > 0 ? "warning" : "normal",
  };

  const empty = i.report.empty ?? 0;
  const report: FlowCell = {
    step: "report",
    label: LABELS.report,
    value: { strong: null, rest: i.report.built ? `Built · ${plural(i.report.sections, "section")}` : "Not built" },
    detail: i.report.built && empty > 0 ? `${plural(empty, "section")} with no text yet, left out of the record` : null,
    done: i.report.built,
    tone: "normal",
  };

  const record: FlowCell = {
    step: "record",
    label: LABELS.record,
    value: { strong: null, rest: i.commit ? `Saved · ${i.commit.slice(0, 7)}` : "Not saved" },
    done: !!i.commit,
    detail: null,
    tone: "normal",
  };

  const cells = [reviews, decide, fix, report, record];
  // A running audit is at its reviews, whatever it has already found. Once the record is saved the audit is at its last step.
  const current = i.state === "cancelled" ? null : i.commit ? "record" : i.state === "running" || total === 0 ? "reviews" : (cells.find((c) => !c.done)?.step ?? "record");
  return { cells, current };
}
