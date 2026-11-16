"use client";

import { Tag } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useActionState, useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Callout } from "@/components/common/callout";
import { DisabledReason } from "@/components/common/disabled-reason";
import { JobProgress } from "@/components/job-progress";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { CheckNameAction, CreateReleaseAction, CreateReleaseState } from "./action-state";

/**
 * "Create release" button and dialog (pages/releases.md, "Create release
 * dialog"). The name is checked as the user types; confirming starts the
 * releases.create job and shows its progress. On success the dialog goes to
 * the new release; on failure it keeps the form and shows the error.
 */
export interface CreateReleaseDialogProps {
  alias: string;
  /** createReleaseAction bound to the space alias */
  createAction: CreateReleaseAction;
  /** checkReleaseNameAction bound to the space alias */
  checkName: CheckNameAction;
  /** releaseErrorNeedsSettingsAction bound to the space alias: whether a job error is one an Admin fixes in Space settings */
  needsSettings?: (error: string) => Promise<boolean>;
  /** The next step after such an error (ConnectionNextStep), shown after it */
  settingsStep?: ReactNode;
  spaceName: string;
  /** Live assets the release pins (index as of the last sync) */
  liveAssets: number;
  repoName: string;
  /** Git tag and manifest path with "{release}" where the name goes */
  tagTemplate: string;
  manifestTemplate: string;
  /** Help text for the name field, from policy releases.name.hint */
  nameHint: string;
  nameMaxLength: number;
  noteMaxChars: number;
  /** Whether a release of HEAD syncs the space first (policy releases.syncBeforeCreate) */
  syncFirst: boolean;
  /** Title of a plan that is applying right now, which blocks creating a release */
  applyingPlan: string | null;
  /** Open on load (from ?create=1) */
  initialOpen?: boolean;
  /** Tag after apply: the commit the apply made, and its plan */
  commit?: string | null;
  planId?: string | null;
}

const IDLE: CreateReleaseState = { status: "idle" };
const NAME_CHECK_DELAY_MS = 350;

function fill(template: string, name: string): string {
  return template.replace("{release}", name || "<name>");
}

/** The job's error is already a plain sentence (/api/jobs words it). */
function failureText(error: string | null): string {
  return (error ?? "The release job stopped without an error message.").replace(/^ReleaseError: /, "");
}

export function CreateReleaseDialog(props: CreateReleaseDialogProps) {
  const { alias, createAction, checkName, needsSettings, settingsStep, spaceName, liveAssets, repoName, tagTemplate, manifestTemplate, nameHint, nameMaxLength, noteMaxChars, syncFirst, applyingPlan, commit = null, planId = null } = props;
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(Boolean(props.initialOpen));
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [jobError, setJobError] = useState<{ runId: string; message: string; settings: boolean } | null>(null);
  const [state, formAction, pending] = useActionState(createAction, IDLE);
  const checkSeq = useRef(0);
  const ids = { name: useId(), nameHelp: useId(), nameError: useId(), note: useId(), noteHelp: useId() };

  const trimmed = name.trim();
  // Inline name check, debounced; a later keystroke supersedes an earlier answer.
  useEffect(() => {
    if (!open || !trimmed) return;
    const seq = ++checkSeq.current;
    const timer = setTimeout(async () => {
      const r = await checkName(trimmed);
      if (seq === checkSeq.current) setNameError(r.ok ? null : r.message);
    }, NAME_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [checkName, open, trimmed]);

  const runId = state.status === "started" ? state.runId : null;
  const running = runId !== null && jobError?.runId !== runId;
  const fieldErrors = state.status === "error" ? state.fieldErrors : {};
  const shownNameError = trimmed ? (nameError ?? fieldErrors.name ?? null) : (fieldErrors.name ?? null);
  const onDone = useCallback(
    (s: { status: string; error: string | null }) => {
      if (!runId || state.status !== "started") return;
      if (s.status === "succeeded") {
        router.push(`/spaces/${encodeURIComponent(alias)}/releases/${encodeURIComponent(state.name)}`);
        return;
      }
      setJobError({ runId, message: s.status === "cancelled" ? "The release job was cancelled. The release wasn't created." : failureText(s.error), settings: false });
      const error = s.status === "cancelled" ? null : s.error;
      if (error && needsSettings) {
        void needsSettings(error).then((yes) => {
          if (yes) setJobError((e) => (e?.runId === runId ? { ...e, settings: true } : e));
        });
      }
    },
    [alias, needsSettings, router, runId, state],
  );

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    // Drop ?create=1 so a reload or Back doesn't open the dialog again.
    if (!next && props.initialOpen) router.replace(pathname, { scroll: false });
  };

  const disabledReason = applyingPlan ? `Plan ${applyingPlan} is applying. Create the release after it finishes.` : !trimmed ? "Enter a name." : null;
  const submitLabel = `Create release${trimmed ? ` ${trimmed}` : ""}`;
  const submit = (
    <Button type="submit" disabled={pending || running}>
      <Tag aria-hidden />
      {pending ? "Starting…" : submitLabel}
    </Button>
  );
  const shortCommit = commit ? commit.slice(0, 7) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Tag aria-hidden />
          Create release
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[540px]">
        <form action={formAction} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Create a release</DialogTitle>
            <DialogDescription>
              A release is a saved snapshot of every asset that you can restore later.{" "}
              {commit ? `This one saves ${spaceName} as the plan you applied left it (commit ${shortCommit}).` : `This one saves ${spaceName} as it is now.`}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor={ids.name}>Name</Label>
            <Input
              id={ids.name}
              name="name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
              }}
              maxLength={nameMaxLength}
              autoComplete="off"
              spellCheck={false}
              required
              aria-invalid={shownNameError ? true : undefined}
              aria-describedby={`${ids.nameHelp}${shownNameError ? ` ${ids.nameError}` : ""}`}
              readOnly={running}
            />
            <p id={ids.nameHelp} className="text-xs text-muted-foreground">
              {nameHint} Saved in the history repository as <span className="font-mono">{fill(tagTemplate, trimmed)}</span>.
            </p>
            {shownNameError ? (
              <p id={ids.nameError} role="alert" className="text-xs text-destructive-fg">
                {shownNameError}
              </p>
            ) : null}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor={ids.note}>
              Notes <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id={ids.note}
              name="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={noteMaxChars}
              aria-describedby={ids.noteHelp}
              aria-invalid={fieldErrors.note ? true : undefined}
              readOnly={running}
            />
            <p id={ids.noteHelp} className="text-xs text-muted-foreground">
              Shown on the release page and saved with the release in the history repository.
            </p>
            {fieldErrors.note ? (
              <p role="alert" className="text-xs text-destructive-fg">
                {fieldErrors.note}
              </p>
            ) : null}
          </div>

          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-[13px]">
            <dt className="text-muted-foreground">Saves</dt>
            <dd>{commit ? `The assets the plan left at commit ${shortCommit}, each with its version, content and status` : `${liveAssets} live ${liveAssets === 1 ? "asset" : "assets"}, each with its version, content and status`}</dd>
            <dt className="text-muted-foreground">Saved as</dt>
            <dd className="font-mono text-xs break-all">{fill(manifestTemplate, trimmed)}</dd>
            <dt className="text-muted-foreground">History repository</dt>
            <dd className="font-mono text-xs break-all">{repoName}</dd>
            {planId ? (
              <>
                <dt className="text-muted-foreground">Plan</dt>
                <dd className="font-mono text-xs break-all">{planId}</dd>
              </>
            ) : null}
          </dl>

          <Callout
            tone="info"
            title={
              <span className="font-normal">
                {commit
                  ? "The release saves exactly what the plan applied, without syncing first."
                  : syncFirst
                    ? "The app syncs the space first, so the release matches the live space at this moment."
                    : "The release saves the space as of the last sync."}
              </span>
            }
          />

          {commit ? <input type="hidden" name="commit" value={commit} /> : null}
          {planId ? <input type="hidden" name="planId" value={planId} /> : null}

          {state.status === "error" && !fieldErrors.name && !fieldErrors.note ? (
            <Callout tone="destructive" title="The release wasn't created" afterAction>
              {state.message}
            </Callout>
          ) : null}
          {jobError && jobError.runId === runId ? (
            <Callout tone="destructive" title="The release wasn't created" afterAction>
              {jobError.message}
              {jobError.settings && settingsStep ? <> {settingsStep}</> : null}
            </Callout>
          ) : null}
          {running && runId ? (
            <div className="space-y-1" aria-live="polite">
              <p className="text-[13px] font-medium">Creating release {state.status === "started" ? state.name : ""}</p>
              <JobProgress key={runId} runId={runId} onDone={onDone} />
            </div>
          ) : null}

          <DialogFooter className="items-start sm:items-center">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {running ? "Close" : "Cancel"}
              </Button>
            </DialogClose>
            {disabledReason && !running ? <DisabledReason reason={disabledReason}>{submit}</DisabledReason> : submit}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
