"use client";

import { Check, GitCommitHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/common/callout";
import { DisabledReason } from "@/components/common/disabled-reason";
import { SectionCard } from "@/components/common/section-card";
import { StatusBadge } from "@/components/common/status-badge";
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
import { cn } from "@/lib/utils";
import type { PushPlan, RecordFile } from "@/server/audit-reports/record";
import { CopyCommit } from "./copy-commit";
import { useReport } from "./report-context";
import { BRANCH_HELP, COMMIT_HELP, FOLDER_HELP, REPOSITORY_HELP, fileStatusText, goToSection, localRecordText, pushPlanText, recordFileHolds, remoteHelp, savedPushText, sectionAnchor, type FinalizeBlock } from "./words";

export interface RecordIssueLink {
  message: string;
  href: string | null;
  linkLabel: string | null;
  /** Sections on this page to link to instead ("Go to Summary"); the dialog closes and scrolls there */
  sections?: { id: string; title: string }[];
}

/** What a save does (the repository now) and, once saved, what it did. Plain data, so it crosses to the client. */
export interface RecordCardRecord {
  repository: string;
  branch: string;
  folder: string;
  push: PushPlan;
  files: RecordFile[];
  saved: {
    commit: string;
    branch: string;
    folder: string;
    files: RecordFile[];
    push: { pushed: boolean; error: string | null; remote: string | null } | null;
    /** "Nov 18, 3:41 PM", as a server-rendered time */
    when: ReactNode;
    by: string | null;
  } | null;
}

export interface SaveRecordCardProps {
  auditName: string;
  /** Null when the space has no history repository */
  record: RecordCardRecord | null;
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
  /** The other reasons the server refuses to save the record, listed in the dialog */
  issues: RecordIssueLink[];
  /** The report was built before the latest finding changes: a warning, not a block */
  stale: ReactNode | null;
  /** Accepted package fixes in no revision: a warning in the dialog, not a block (a person may decide a fix won't be made) */
  openFixes: { id: string; title: string; incident: string | null }[];
  /** The Findings tab filtered to those fixes */
  openFixesHref: string;
  /** Accepted package fixes that are in a revision whose plan isn't applied yet */
  queuedFixes: number;
  actor: string;
  /** A save job already queued or running */
  runId: string | null;
  /** The latest save failed */
  lastFailed: string | null;
}

const mono = "font-mono text-xs";

/** "1 accepted package fix", "3 accepted package fixes". */
const plainCount = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/**
 * The facts of the save as a definition list: the repository and branch, the
 * folder, each file with whether it is new or replaces one, and where the
 * commit goes. Each exact name carries a few words that say what it is. The
 * same list before and after saving; after, it is what happened, not what will.
 */
function Facts({ p, files, repository, branch, folder, push, pushHelp }: { p: SaveRecordCardProps; files: RecordFile[]; repository: string; branch: string; folder: string; push: ReactNode; pushHelp: string | null }) {
  return (
    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-[13px]">
      <dt className="text-muted-foreground">Repository</dt>
      <dd className="[overflow-wrap:anywhere]">
        <span className="font-semibold">{repository}</span> <span className="text-xs text-muted-foreground">({REPOSITORY_HELP})</span>
        <span className="block">
          on branch <span className={mono}>{branch}</span> <span className="text-xs text-muted-foreground">({BRANCH_HELP})</span>
        </span>
      </dd>
      <dt className="text-muted-foreground">Folder</dt>
      <dd className="[overflow-wrap:anywhere]">
        <span className={mono}>{folder}</span> <span className="text-xs text-muted-foreground">({FOLDER_HELP})</span>
      </dd>
      <dt className="text-muted-foreground">Files</dt>
      <dd>
        <ul className="space-y-1">
          {files.map((f) => (
            <li key={f.name}>
              <span className={mono}>{f.name}</span> <span className="text-muted-foreground">({fileStatusText(f.status)})</span>
              <span className="block text-xs text-muted-foreground">{recordFileHolds(f.name, p)}</span>
            </li>
          ))}
        </ul>
      </dd>
      <dt className="text-muted-foreground">Copied to</dt>
      <dd>
        {push}
        {pushHelp ? <span className="mt-1 block text-xs text-muted-foreground">{pushHelp}</span> : null}
      </dd>
    </dl>
  );
}

/**
 * The "Save the audit record" side card and its confirmation (pages/audit-report.md).
 * Saving commits the record to the space's history repository and changes
 * nothing in the Agent Space. Every finding needs a decision first, so
 * undecided findings disable the button with a link to them; other refusals are
 * listed in the dialog; a stale report is a warning there. Saving runs in the
 * worker and shows its progress. Once saved, the card says where the record
 * went, which files, and whether it was pushed.
 */
export function SaveRecordCard(p: SaveRecordCardProps) {
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
  const rec = p.record;
  const saved = rec?.saved ?? null;
  const localText = rec && !saved ? localRecordText(rec.repository, rec.push.kind === "local" ? rec.push.reason : null) : null;

  const onDone = (s: JobStatus) => {
    if (s.status !== "succeeded") return;
    setFinishedRun(runId);
    setLocalRun(null);
    setOpen(false);
    toast.success(`Saved the record of ${p.auditName}`);
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
      Save the audit record
    </Button>
  );

  const pushNow = rec ? pushPlanText(rec.push) : null;
  const pushAfter = saved ? savedPushText(saved.push, rec?.push ?? null) : null;

  return (
    <SectionCard id="report-record" title="Save the audit record" aside={saved ? <StatusBadge tone="success" icon={Check} label="Saved" /> : undefined} className="scroll-mt-20">
      <div className="space-y-3 px-4 py-4 text-[13px]">
        {saved && rec ? (
          <>
            <p>
              Saved {saved.when}
              {saved.by ? ` by ${saved.by}` : ""}. Nothing in the Agent Space changed.
            </p>
            <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
              <dt className="text-muted-foreground">Commit</dt>
              <dd>
                <CopyCommit commit={saved.commit} /> <span className="text-xs text-muted-foreground">({COMMIT_HELP})</span>
              </dd>
            </dl>
            <Facts
              p={p}
              files={saved.files}
              repository={rec.repository}
              branch={saved.branch}
              folder={saved.folder}
              push={pushAfter ? <StatusBadge tone={pushAfter.tone} label={pushAfter.text} className="h-auto max-w-full whitespace-normal py-0.5 text-left" /> : null}
              pushHelp={saved.push && !saved.push.pushed && !saved.push.error ? remoteHelp(rec.push.kind === "pushes" ? { kind: "local", reason: "push-off", remote: rec.push.remote } : rec.push) : null}
            />
            <p className="text-xs text-muted-foreground">Findings and the report can&apos;t change. The journals stay in this app&apos;s database.</p>
          </>
        ) : (
          <>
            <p>Saves what this audit found, as files in the space&apos;s history repository. Nothing in the Agent Space changes.</p>
            {p.lastFailed && !runId ? (
              <Callout tone="destructive" title="The last attempt to save the record failed">
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
                Save the audit record
              </Button>
            )}
            {rec ? (
              <Facts
                p={p}
                files={rec.files}
                repository={rec.repository}
                branch={rec.branch}
                folder={rec.folder}
                push={pushNow ? <StatusBadge tone={pushNow.tone} label={pushNow.text} className="h-auto max-w-full whitespace-normal py-0.5 text-left" /> : null}
                pushHelp={remoteHelp(rec.push)}
              />
            ) : (
              <p className="text-muted-foreground">The history repository isn&apos;t set up for this space, so there is nowhere to save the record yet.</p>
            )}
            <p className="text-xs text-muted-foreground">Findings and the report can&apos;t change after this. The journals stay in this app&apos;s database.</p>
          </>
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
            <AlertDialogTitle>Save the audit record?</AlertDialogTitle>
            <AlertDialogDescription>Saves what {p.auditName} found. Nothing in the Agent Space changes. Findings and the report can&apos;t change after this.</AlertDialogDescription>
          </AlertDialogHeader>
          {rec ? (
            <Facts
              p={p}
              files={rec.files}
              repository={rec.repository}
              branch={rec.branch}
              folder={rec.folder}
              push={pushNow ? <StatusBadge tone={pushNow.tone} label={pushNow.text} className="h-auto max-w-full whitespace-normal py-0.5 text-left" /> : null}
              pushHelp={remoteHelp(rec.push)}
            />
          ) : null}
          <p className="text-xs text-muted-foreground">The commit is recorded as made by {p.actor}.</p>
          {p.openFixes.length ? (
            <Callout tone="warning" title={`${plainCount(p.openFixes.length, "accepted package fix", "accepted package fixes")} ${p.openFixes.length === 1 ? "is" : "are"} in no revision`}>
              <span className="block">You can still save the record: a person may decide a fix won&apos;t be made. A fix in no revision won&apos;t reach the agent, and the record says it was accepted.</span>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {p.openFixes.slice(0, 5).map((f) => (
                  <li key={f.id} className="line-clamp-2 [overflow-wrap:anywhere]">
                    {f.incident ? <span className="font-mono text-xs">{f.incident}: </span> : null}
                    {f.title}
                  </li>
                ))}
              </ul>
              {p.openFixes.length > 5 ? <span className="mt-0.5 block text-xs text-muted-foreground">and {p.openFixes.length - 5} more</span> : null}
              <Link href={p.openFixesHref} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-2")}>
                Add {p.openFixes.length === 1 ? "it" : "them"} to a revision
              </Link>
            </Callout>
          ) : null}
          {p.queuedFixes ? (
            <p className="text-xs text-muted-foreground">
              {plainCount(p.queuedFixes, "accepted package fix", "accepted package fixes")} {p.queuedFixes === 1 ? "is" : "are"} queued in a revision and not applied yet. Saving the record doesn&apos;t change that.
            </p>
          ) : null}
          {p.issues.length ? (
            <Callout tone="destructive" title="The record can't be saved yet">
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
            <Callout tone="warning" title="The record stays on this machine">
              {localText}
              {p.repositorySettingsHref ? (
                <Link href={p.repositorySettingsHref} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-2 flex w-fit")}>
                  Repository settings
                </Link>
              ) : null}
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
                  Save the record
                </Button>
              </DisabledReason>
            ) : (
              <Button onClick={confirm} disabled={pending}>
                <GitCommitHorizontal aria-hidden />
                Save the record
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}
