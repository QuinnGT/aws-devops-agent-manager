"use client";

import { GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AddToRevisionDialog } from "./add-to-revision-dialog";
import type { RevisionChoice } from "./revision-choice";

/**
 * "Add the N fixes to a revision…" for the audit's accepted package fixes that
 * are in no revision, from a server-rendered banner or the flow strip. The
 * dialog is the one the Findings tab uses.
 */
export function AddFixesButton({
  alias,
  findings,
  choices,
  nameRule,
  size = "sm",
  variant = "default",
  short = false,
}: {
  alias: string;
  findings: { id: string; title: string }[];
  choices: RevisionChoice[];
  nameRule: { pattern: string; hint: string; maxLength: number };
  size?: "sm" | "xs";
  variant?: "default" | "outline";
  /** "Add to a revision…" for a narrow place that already says how many fixes there are */
  short?: boolean;
}) {
  return (
    <AddToRevisionDialog
      alias={alias}
      findings={findings}
      acceptFirst={false}
      options={choices}
      nameRule={nameRule}
      trigger={(open, disabled) => (
        <Button type="button" size={size} variant={variant} onClick={open} disabled={disabled}>
          <GitBranch aria-hidden />
          {short ? "Add to a revision…" : `Add the ${findings.length} ${findings.length === 1 ? "fix" : "fixes"} to a revision…`}
        </Button>
      )}
    />
  );
}
