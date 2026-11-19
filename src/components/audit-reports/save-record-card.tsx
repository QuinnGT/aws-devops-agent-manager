"use client";

import { GitCommitHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/common/callout";
import { DisabledReason } from "@/components/common/disabled-reason";
import { SectionCard } from "@/components/common/section-card";
import { JobProgress, type JobStatus } from "@/components/job-progress";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { useReport } from "./report-context";
import { goToSection, localRecordText, sectionAnchor, type FinalizeBlock } from "./words";

export interface FinalizeIssueLink {
  message: string;
  href: string | null;
  linkLabel: string | null;
  /** Sections on this page to link to instead ("Go to Summary"); the dialog closes and scrolls there */
  sections?: { id: string; title: string }[];
}

export interface FinalizeCardProps {
  auditName: string;
  repository: { name: string; folder: string; local: "no-remote" | "push-off" | null } | null;
  /** Repository settings (App settings), for people who can change them */
  repositorySettingsHref: string | null;
  journalCount: number;
  acceptedCount: number;
  /** Sections report.md holds (every section that is not hidden) */
  reportSections: number;
  /** Why the card's button is disabled, from finalizeBlock() */
  block: FinalizeBlock;
  findingsHref: string;
  /** Space settings, for Admins only */
  settingsHref: string | null;
  /** The other reasons the server refuses to finalize, listed in the dialog */
  issues: FinalizeIssueLink[];
  /** The report was built before the latest finding changes: a warning, not a block */
  stale: ReactNode | null;
  actor: string;
  /** A finalize job already queued or running */
  runId: string | null;
  /** The latest finalize job failed */
  lastFailed: string | null;
}

function Facts({ p, detailed }: { p: FinalizeCardProps; detailed: boolean }) {
  const s = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      <dt className="font-mono text-xs leading-5 text-muted-foreground">audit.json</dt>
      <dd>{detailed ? `Profile and policy digest, ${s(p.journalCount, "journal SHA-256", "journal SHA-256s")}, analyzer versions, model ID and prompt digest` : `Profile, ${s(p.journalCount, "journal SHA-256", "journal SHA-256s")}, analyzer and model versions`}</dd>
      <dt className="font-mono text-xs leading-5 text-muted-foreground">findings.json</dt>
      <dd>{detailed ? `${s(p.acceptedCount, "accepted finding", "accepted findings")} with their record citations and check results` : `${s(p.acceptedCount, "accepted finding", "accepted findings")} with their citations`}</dd>
      <dt className="font-mono text-xs leading-5 text-muted-foreground">report.md</dt>
      <dd>{detailed ? `${p.reportSections === 1 ? "The 1 shown section" : `All ${p.reportSections} shown sections`}, each marked Internal or Shareable` : "The report as shown here"}</dd>
      {detailed ? (
        <>
          <dt className="text-muted-foreground">Commit by</dt>
          <dd>{p.actor}</dd>
        </>
      ) : null}
    </dl>
  );
}

/** The folder in the history repository (it holds the audit's ID), in a muted Details disclosure. */
function FolderDetails({ folder }: { folder: string | undefined }) {
  if (!folder) return null;
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="inline-flex min-h-6 cursor-pointer items-center rounded-sm hover:text-foreground">Details</summary>
      <p>
        Folder in the repository: <span className="font-mono break-all">{folder}</span>
      </p>
    </details>
  );
}

/**
 * The "Finalize audit" side card and its confirmation (pages/audit-report.md): every finding needs a decision first, so undecided
 * findings disable the button with a link to them; other refusals are listed
 * in the dialog; a stale report is a warning there. Finalizing runs in the
 * worker and shows its progress.
 */
export function FinalizeCard(p: FinalizeCardProps) {
  const { alias, auditId, actions } = useReport();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [localRun, setLocalRun] = useState<string | null>(null);
  const [finishedRun, setFinishedRun] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; problems: string[] } | null>(null);
  const [pending, start] = useTransition();
  const trigger = useRef<HTMLElement | null>(null);
  /** A section the person chose to go to from the dialog */
  const target = useRef<string | null>(null);
  const runId = localRun ?? (p.runId && p.runId !== finishedRun ? p.runId : null);
  const localText = p.repository ? localRecordText(p.repository.name, p.repository.local) : null;

  const onDone = (s: JobStatus) => {
    if (s.status !== "succeeded") return;
    setFinishedRun(runId);
    setLocalRun(null);
    setOpen(false);
    toast.success(`Finalized ${p.auditName}`);
    router.refresh();
  };

  const confirm = () =>
    start(async () => {
      const r = await actions.finalize(alias, auditId);
      if (!r.ok) return setError({ message: r.message, problems: r.problems });
      setError(null);
      setLocalRun(r.runId);
    });

  const button = (
    <Button>
      <GitCommitHorizontal aria-hidden />
      Finalize audit
    </Button>
  );

  return (
    <SectionCard id="report-finalize-title" title="Finalize audit">
      <div className="space-y-3 px-4 py-4 text-[13px]">
        {p.repository ? (
          <p>
            Commits the audit record to <span className="font-mono text-xs">{p.repository.name}</span>:
          </p>
        ) : (
          <p>Commits the audit record to the space&apos;s history repository:</p>
        )}
        <Facts p={p} detailed={false} />
        <p className="text-xs text-muted-foreground">Findings and the report can&apos;t change after this. The journals stay in this app&apos;s database.</p>
        <FolderDetails folder={p.repository?.folder} />
        {p.lastFailed && !runId ? (
          <Callout tone="destructive" title="The last finalize attempt failed">
            {p.lastFailed}
          </Callout>
        ) : null}
        {runId && !open ? (
          <JobProgress runId={runId} onDone={onDone} />
        ) : p.block ? (
          <div className="space-y-1.5">
            <DisabledReason reason={p.block.reason}>{button}</DisabledReason>
            {p.block.link === "findings" ? (
              <Link href={p.findingsHref} className="inline-flex min-h-6 items-center text-[13px] underline underline-offset-4">
                Open the proposed findings
              </Link>
            ) : p.block.link === "settings" && p.settingsHref ? (
              <Link href={p.settingsHref} className="inline-flex min-h-6 items-center text-[13px] underline underline-offset-4">
                Open Space settings
              </Link>
            ) : p.block.link === "settings" ? (
              <p className="text-xs text-muted-foreground">An Admin sets it up in Space settings.</p>
            ) : null}
          </div>
        ) : (
          <Button
            onClick={() => {
              trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
              target.current = null;
              setError(null);
              setOpen(true);
            }}
          >
            <GitCommitHorizontal aria-hidden />
            Finalize audit
          </Button>
        )}
      </div>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent
          className="data-[size=default]:sm:max-w-lg"
          onCloseAutoFocus={(e) => {
            const el = target.current ? document.getElementById(target.current) : null;
            if (el) {
              e.preventDefault();
              el.scrollIntoView({ block: "start" });
              el.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
            } else if (trigger.current?.isConnected) {
              e.preventDefault();
              trigger.current.focus();
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Finalize {p.auditName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Commits the audit record to {p.repository ? <span className="font-mono text-xs">{p.repository.name}</span> : "the history repository"}. Findings and the report can&apos;t change after this.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Facts p={p} detailed />
          <FolderDetails folder={p.repository?.folder} />
          {p.issues.length ? (
            <Callout tone="destructive" title="This audit can't be finalized yet">
              <ul className="list-disc space-y-1 pl-4">
                {p.issues.map((i) => (
                  <li key={i.message}>
                    {i.message}{" "}
                    {i.sections?.length ? (
                      <span className="mt-0.5 flex flex-wrap gap-x-3">
                        {i.sections.map((s) => (
                          <a
                            key={s.id}
                            href={`#${sectionAnchor(s.id)}`}
                            className="inline-flex min-h-6 items-center underline underline-offset-4"
                            onClick={(e) => {
                              e.preventDefault();
                              target.current = sectionAnchor(s.id);
                              setOpen(false);
                            }}
                          >
                            {goToSection(s.title)}
                          </a>
                        ))}
                      </span>
                    ) : i.href ? (
                      <Link href={i.href} className="underline underline-offset-4">
                        {i.linkLabel}
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Callout>
          ) : null}
          {localText ? (
            <Callout
              tone="warning"
              title="The record stays on this machine"
              action={
                p.repositorySettingsHref ? (
                  <Link href={p.repositorySettingsHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
                    Repository settings
                  </Link>
                ) : null
              }
            >
              {localText}
            </Callout>
          ) : null}
          {p.stale ? (
            <Callout tone="warning" title="The report was built before the latest decisions">
              {p.stale}
            </Callout>
          ) : null}
          {error ? (
            <Callout tone="destructive" afterAction title={error.message}>
              {error.problems.length > 1 ? (
                <ul className="list-disc space-y-1 pl-4">
                  {error.problems.slice(1).map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              ) : null}
            </Callout>
          ) : null}
          {runId ? <JobProgress runId={runId} onDone={onDone} /> : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{runId ? "Close" : "Cancel"}</AlertDialogCancel>
            {runId ? null : p.issues.length ? (
              <DisabledReason reason="Resolve the items above first.">
                <Button>
                  <GitCommitHorizontal aria-hidden />
                  Finalize and commit
                </Button>
              </DisabledReason>
            ) : (
              <Button onClick={confirm} disabled={pending}>
                <GitCommitHorizontal aria-hidden />
                Finalize and commit
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}
