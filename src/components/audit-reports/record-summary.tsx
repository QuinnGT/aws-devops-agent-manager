import Link from "next/link";
import { StatusBadge } from "@/components/common/status-badge";
import { Time } from "@/components/common/time";
import { Card } from "@/components/ui/card";
import type { RecordInfo } from "@/server/audit-reports/record";
import { displayNames } from "@/server/drafts/loaders";
import { CopyCommit } from "./copy-commit";
import { pushPlanText, savedPushText } from "./words";

const mono = "font-mono text-xs";
const TONE = { success: "success", warning: "warning", destructive: "destructive", neutral: "neutral" } as const;

/**
 * The last link of the audit flow, under the Findings tab's split view: where
 * "Save the audit record" will put the record, or, once saved, the commit and
 * whether it was pushed. Saving itself is on the Report tab. Nothing in the
 * Agent Space changes.
 */
export async function RecordSummary({ alias, auditId, info }: { alias: string; auditId: string; info: RecordInfo }) {
  const { plan, saved } = info;
  const report = `/spaces/${encodeURIComponent(alias)}/audits/${auditId}/report`;
  const by = saved?.by ? (await displayNames([saved.by]))(saved.by) : null;
  const push = saved ? savedPushText(saved.push, plan?.push ?? null) : plan ? pushPlanText(plan.push) : null;
  return (
    <Card className="gap-1.5 px-4 py-3" role="region" aria-label="Record">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{saved ? "Record saved" : "Record"}</h2>
        {push ? <StatusBadge tone={TONE[push.tone]} label={push.text} className="h-auto max-w-full whitespace-normal py-0.5" /> : null}
      </div>
      {!plan && !saved ? (
        <p className="text-[13px] text-muted-foreground">The history repository isn&apos;t set up for this space, so the audit record can&apos;t be saved yet.</p>
      ) : saved ? (
        <p className="text-[13px] text-muted-foreground">
          Saved {saved.at ? <Time value={saved.at} format="datetime" /> : null}
          {by ? ` by ${by}` : ""} as commit <CopyCommit commit={saved.commit} /> in <span className={mono}>{saved.folder}</span> on <span className={mono}>{saved.branch}</span>
          {plan ? (
            <>
              {" "}
              of <span className={mono}>{plan.repository}</span>
            </>
          ) : null}
          : <span className={mono}>audit.json</span>, <span className={mono}>findings.json</span> and <span className={mono}>report.md</span>. Nothing in the Agent Space changed.
        </p>
      ) : plan ? (
        <p className="text-[13px] text-muted-foreground">
          Saving the record commits <span className={mono}>audit.json</span>, <span className={mono}>findings.json</span> and <span className={mono}>report.md</span> to <span className={mono}>{plan.folder}</span> on <span className={mono}>{plan.branch}</span> of{" "}
          <span className={mono}>{plan.repository}</span>, the space&apos;s history repository. Nothing in the Agent Space changes.{" "}
          <Link href={report} className="inline-flex min-h-6 items-center text-foreground underline underline-offset-4">
            Open the Report tab to save it
          </Link>
        </p>
      ) : null}
    </Card>
  );
}
