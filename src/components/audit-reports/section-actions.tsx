"use client";

import { BadgeCheck, Bot, Eye, EyeOff, Loader, SquarePen } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/common/callout";
import { DisabledReason } from "@/components/common/disabled-reason";
import { EmptyState } from "@/components/common/empty-state";
import { JobProgress } from "@/components/job-progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Audience } from "@/server/audit-reports";
import { useReport } from "./report-context";
import { ReportSectionCard } from "./section-card";
import { approvalNotice } from "./words";

function ActionError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="basis-full text-right text-xs text-destructive-fg">
      {message}
    </p>
  );
}

/** "Hide" (ghost, EyeOff) or "Show section" (outline, Eye). Hidden sections are left out of every export. */
export function HideToggle({ sectionId, title, hidden }: { sectionId: string; title: string; hidden: boolean }) {
  const { alias, auditId, actions } = useReport();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = () =>
    start(async () => {
      const r = await actions.setHidden(alias, auditId, sectionId, !hidden);
      if (!r.ok) return setError(r.message);
      setError(null);
      toast.success(hidden ? `${title} is shown again` : `${title} is hidden from exports`);
      router.refresh();
    });
  return (
    <>
      {hidden ? (
        <Button variant="outline" size="sm" onClick={run} disabled={pending} aria-label={`Show section ${title}`}>
          <Eye aria-hidden />
          Show section
        </Button>
      ) : (
        <Button variant="ghost" size="sm" onClick={run} disabled={pending} aria-label={`Hide ${title}`}>
          <EyeOff aria-hidden />
          Hide
        </Button>
      )}
      <ActionError message={error} />
    </>
  );
}

export interface NarrativeDraftState {
  /** Why drafting is blocked ("Accept some findings first."), or null */
  disabledReason: string | null;
  /** A draft job already queued or running for this section */
  runId: string | null;
  /** The latest draft failed after the text last changed */
  failed: string | null;
}

export interface NarrativeSectionProps {
  sectionId: string;
  number: number;
  title: string;
  audience: Audience;
  text: string | null;
  source: "model" | "person" | null;
  /** Model text nobody approved since the latest decisions, and whether it was drafted before them */
  check: { needsApproval: boolean; draftedBeforeDecisions: boolean };
  meta: ReactNode;
  /** The text through SafeMarkdown, rendered on the server */
  rendered: ReactNode;
  /** The person can edit, draft and hide (audits.run, not finalized) */
  canEdit: boolean;
  /** Null when the section has no prompt, so the model can't draft it */
  draft: NarrativeDraftState | null;
  maxChars: number;
}

/**
 * A narrative section: the model's or a person's text, "Edit" turning the
 * body into a markdown Textarea, and "Draft with the model", which asks
 * first when a person wrote the current text, then shows the job's progress.
 * Model text nobody has approved since the latest decisions carries a notice
 * with "Approve this text", which records who checked it and when.
 */
export function NarrativeSection(p: NarrativeSectionProps) {
  const { alias, auditId, actions } = useReport();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(p.text ?? "");
  const [error, setError] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [localRun, setLocalRun] = useState<string | null>(null);
  const [finishedRun, setFinishedRun] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const [requesting, startDraft] = useTransition();
  const [approving, startApprove] = useTransition();
  const fieldId = useId();
  const helpId = useId();
  const errId = useId();

  const serverRun = p.draft?.runId && p.draft.runId !== finishedRun ? p.draft.runId : null;
  const runId = localRun ?? serverRun;

  const requestDraft = (replace: boolean) =>
    startDraft(async () => {
      const r = await actions.draftNarrative(alias, auditId, p.sectionId, replace);
      if (!r.ok) return setDraftError(r.message);
      setDraftError(null);
      setLocalRun(r.runId);
      toast.success(`Drafting ${p.title} with the model`);
    });
  const onDraft = () => (p.source === "person" ? setConfirmOpen(true) : requestDraft(false));
  const onDone = () => {
    setFinishedRun(runId);
    setLocalRun(null);
    router.refresh();
  };

  const save = () =>
    startSave(async () => {
      if (value.length > p.maxChars) return setError(`Keep the text to ${p.maxChars} characters or fewer.`);
      const r = await actions.saveNarrative(alias, auditId, p.sectionId, value);
      if (!r.ok) return setError(r.message);
      setError(null);
      setEditing(false);
      toast.success(`Saved ${p.title}`);
      router.refresh();
    });

  const approve = () =>
    startApprove(async () => {
      const r = await actions.approveNarrative(alias, auditId, p.sectionId, p.text ?? "");
      if (!r.ok) return setApproveError(r.message);
      setApproveError(null);
      toast.success(`Approved ${p.title}`);
      router.refresh();
    });

  const notice =
    p.text && p.check.needsApproval && !editing && !runId ? approvalNotice({ draftedBeforeDecisions: p.check.draftedBeforeDecisions, canApprove: p.canEdit }) : null;

  const draftButton = p.draft ? (
    runId || requesting ? (
      <Button variant="ghost" size="sm" disabled aria-describedby={`${fieldId}-drafting`}>
        <Loader aria-hidden className="motion-safe:animate-spin" />
        Drafting
      </Button>
    ) : p.draft.disabledReason ? (
      <DisabledReason reason={p.draft.disabledReason}>
        <Button variant="ghost" size="sm">
          <Bot aria-hidden />
          Draft with the model
        </Button>
      </DisabledReason>
    ) : (
      <Button variant="ghost" size="sm" onClick={onDraft} disabled={editing}>
        <Bot aria-hidden />
        Draft with the model
      </Button>
    )
  ) : null;

  const actionsNode = p.canEdit ? (
    <>
      {!editing ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={Boolean(runId)}
          onClick={() => {
            setValue(p.text ?? "");
            setEditing(true);
          }}
        >
          <SquarePen aria-hidden />
          Edit
        </Button>
      ) : null}
      {draftButton}
      {!editing ? <HideToggle sectionId={p.sectionId} title={p.title} hidden={false} /> : null}
      <ActionError message={draftError} />
    </>
  ) : null;

  let body: ReactNode;
  if (editing) {
    body = (
      <div className="space-y-2 px-4 py-3">
        <Label htmlFor={fieldId}>Text</Label>
        <Textarea
          id={fieldId}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={12}
          className="max-w-[80ch] font-mono text-xs"
          aria-describedby={error ? `${helpId} ${errId}` : helpId}
          aria-invalid={error ? true : undefined}
        />
        <p id={helpId} className="text-xs text-muted-foreground">
          Markdown, up to {p.maxChars.toLocaleString("en-US")} characters. Saved as your text: a later model draft asks before it replaces it.
        </p>
        {error ? (
          <p id={errId} role="alert" className="text-xs text-destructive-fg">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button size="sm" onClick={save} disabled={saving}>
            Save
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
            disabled={saving}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  } else if (p.text) {
    body = <div className="px-4 py-3">{p.rendered}</div>;
  } else {
    body = (
      <EmptyState
        title="Not drafted yet"
        action={
          p.canEdit && p.draft && !p.draft.disabledReason && !runId ? (
            <Button size="sm" variant="outline" onClick={onDraft} disabled={requesting}>
              <Bot aria-hidden />
              Draft with the model
            </Button>
          ) : null
        }
      >
        {p.canEdit ? "Draft it with the model, or write it yourself with Edit." : "Someone who can run audits drafts or writes this section."}
      </EmptyState>
    );
  }

  return (
    <>
      <ReportSectionCard sectionId={p.sectionId} number={p.number} title={p.title} audience={p.audience} hidden={false} meta={p.meta} actions={actionsNode}>
        {runId ? (
          <div id={`${fieldId}-drafting`} className="border-b px-4 py-3">
            <JobProgress runId={runId} onDone={onDone} />
          </div>
        ) : null}
        {p.draft?.failed && !runId && !editing ? (
          <div className="border-b px-4 py-3">
            <Callout
              tone="destructive"
              title="The model didn't draft this section"
              action={
                p.canEdit && !p.draft.disabledReason ? (
                  <Button size="sm" variant="outline" onClick={onDraft} disabled={requesting}>
                    Try again
                  </Button>
                ) : null
              }
            >
              {p.draft.failed}
            </Callout>
          </div>
        ) : null}
        {notice ? (
          <div className="space-y-1.5 border-b px-4 py-3">
            <Callout
              tone={p.check.draftedBeforeDecisions ? "warning" : "info"}
              title={notice.title}
              action={
                p.canEdit ? (
                  <Button size="sm" variant="outline" onClick={approve} disabled={approving}>
                    <BadgeCheck aria-hidden />
                    Approve this text
                  </Button>
                ) : null
              }
            >
              {notice.body}
            </Callout>
            {approveError ? (
              <p role="alert" className="text-xs text-destructive-fg">
                {approveError}
              </p>
            ) : null}
          </div>
        ) : null}
        {body}
      </ReportSectionCard>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace your edits with a new draft?</AlertDialogTitle>
            <AlertDialogDescription>Your current text in {p.title} is lost when the model&apos;s draft arrives.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                requestDraft(true);
              }}
            >
              Replace with a new draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
