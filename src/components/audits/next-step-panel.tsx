"use client";

import { GitBranch } from "lucide-react";
import Link from "next/link";
import { StatusBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import type { NextStep } from "@/server/audits/next-step";
import { AddToRevisionDialog, type RevisionChoice } from "./add-to-revision-dialog";
import { linkKindWords, planStateWords, revisionStateWords } from "./words";

export interface NextStepPanelProps {
  alias: string;
  step: NextStep;
  finding: { id: string; title: string };
  options: RevisionChoice[];
  nameRule: { pattern: string; hint: string; maxLength: number };
  className?: string;
}

const link = "inline-flex min-h-6 items-center rounded-sm underline underline-offset-4 hover:text-foreground";

/**
 * "What happens next" under a finding (pages/audit-detail.md): a diagnosis is
 * recorded and counted in the report; a package fix shows the revisions it
 * went to, each a link, or offers "Add to revision…" ("Accept and add to
 * revision…" while it is proposed); any other fix says it is listed in the
 * report as an action for its owner; a rejected finding shows its note. The
 * words come from nextStepFor (src/server/audits/next-step.ts).
 */
export function NextStepPanel({ alias, step, finding, options, nameRule, className }: NextStepPanelProps) {
  const base = `/spaces/${encodeURIComponent(alias)}`;
  return (
    <section aria-label="What happens next" className={className ?? "rounded-lg border border-dashed px-3 py-2.5"}>
      <h3 className="text-[13px] font-semibold">What happens next</h3>
      <p className="mt-1 max-w-[72ch] text-[13px]">{step.text}</p>
      {step.reviewNote ? (
        <p className="mt-1 max-w-[72ch] text-[13px] whitespace-pre-wrap [overflow-wrap:anywhere]">
          <span className="text-muted-foreground">Why: </span>
          {step.reviewNote}
        </p>
      ) : null}
      {step.links.length ? (
        <ul className="mt-2 space-y-1.5">
          {step.links.map((l) => {
            const state = revisionStateWords(l.revisionState);
            return (
              <li key={`${l.revisionId}-${l.kind}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                <GitBranch className="size-3.5 text-muted-foreground" aria-hidden />
                <Link href={`${base}/revisions/${encodeURIComponent(l.revisionName)}`} className={`${link} font-semibold`}>
                  {l.revisionName}
                </Link>
                <StatusBadge tone="neutral" label={linkKindWords(l.kind)} />
                {state ? <StatusBadge tone="neutral" label={state} /> : null}
                {l.planId ? (
                  <Link href={`${base}/plans/${encodeURIComponent(l.planId)}`} className={`${link} text-muted-foreground`}>
                    Plan{l.planState ? `, ${planStateWords(l.planState)}` : ""}
                  </Link>
                ) : null}
                {l.releaseName ? (
                  <Link href={`${base}/releases/${encodeURIComponent(l.releaseName)}`} className={`${link} text-muted-foreground`}>
                    Release {l.releaseName}
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {step.note ? <p className="mt-1.5 max-w-[72ch] text-xs text-muted-foreground">{step.note}</p> : null}
      {step.action ? (
        <div className="mt-2.5">
          <AddToRevisionDialog
            alias={alias}
            findings={[finding]}
            acceptFirst={step.action.acceptFirst}
            options={options}
            nameRule={nameRule}
            trigger={(open, disabled) => (
              <Button type="button" size="sm" onClick={open} disabled={disabled}>
                <GitBranch aria-hidden />
                {step.action!.label}
              </Button>
            )}
          />
        </div>
      ) : null}
    </section>
  );
}
