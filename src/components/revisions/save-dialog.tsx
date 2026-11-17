"use client";

import { Save, Search } from "lucide-react";
import { useId, useMemo, useState, useTransition } from "react";
import { Callout } from "@/components/common/callout";
import { Checkbox } from "@/components/common/checkbox";
import { DisabledReason } from "@/components/common/disabled-reason";
import { JobProgress, type JobStatus } from "@/components/job-progress";
import type { ActionResult } from "@/components/plans/action-state";
import { DiffCounts } from "@/components/plans/unified-diff";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { SaveFinding } from "@/server/revisions/views";
import { changelogPreview, lineCounts, rankFindings, saveButtonReason, searchFindings, splitIncident, type OpenFile, type UnlinkedRule } from "./editor-state";

export type SaveRevisionAction = (input: {
  revisionId: string;
  message: string;
  edits: { path: string; content: string | null }[];
  findingIds: string[];
  unlinkedReason: string | null;
  expectedHead: string | null;
}) => Promise<ActionResult<{ runId: string; changeId: string }>>;

export interface SaveRules {
  unlinked: UnlinkedRule;
  reasonMinChars: number;
  reasonMaxChars: number;
  messageMaxChars: number;
}

/** What the job reported when it finished. */
export type SaveOutcome = { kind: "passed" } | { kind: "failed"; errors: number } | { kind: "error"; message: string };

const MAX_SHOWN = 50;

/**
 * The save dialog (revision-detail.md, option 1 "Save"): the changed files
 * with their counts, the message, linked accepted findings (or the reason
 * when none is linked, revisions.yaml save.unlinked), and the changelog
 * entry preview. "Save and build" starts the revisions.save job and shows
 * its progress, then the build result.
 */
export function SaveDialog({
  open,
  onOpenChange,
  revisionId,
  branch,
  files,
  findings,
  rules,
  expectedHead,
  planWarning,
  saveAction,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  revisionId: string;
  branch: string;
  files: OpenFile[];
  findings: SaveFinding[];
  rules: SaveRules;
  expectedHead: string | null;
  /** "This save is not in plan <title>..." while a plan from the revision is open */
  planWarning: string | null;
  saveAction: SaveRevisionAction;
  /** The job finished; `paths` are the files it saved */
  onSaved: (outcome: SaveOutcome, paths: string[]) => void;
}) {
  const ids = { message: useId(), messageHelp: useId(), search: useId(), findingsHelp: useId(), reason: useId(), reasonHelp: useId() };
  const [message, setMessage] = useState("");
  const [q, setQ] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<ActionResult<{ runId: string; changeId: string }> | null>(null);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [sentPaths, setSentPaths] = useState<string[]>([]);
  const [pending, start] = useTransition();

  const counts = useMemo(() => files.map((f) => ({ path: f.path, isNew: f.base === null, deleted: f.deleted === true, ...lineCounts(f.base, f.deleted ? "" : f.text) })), [files]);
  const matches = useMemo(() => searchFindings(findings, q), [findings, q]);
  // Findings that name an edited file or asset come first, then the rest.
  const ranked = useMemo(() => rankFindings(matches, files.map((f) => f.path)), [matches, files]);
  const ordered = useMemo(() => [...ranked.related, ...ranked.rest], [ranked]);
  const picked = findings.filter((f) => chosen.includes(f.id));
  const runId = result?.ok ? result.runId : null;
  const running = runId !== null && outcome === null;
  const fieldErrors = result && !result.ok ? result.fieldErrors : {};
  const preview = changelogPreview(
    message,
    files.map((f) => f.path),
    picked.map((f) => ({ id: f.id, incidentId: f.incidentId, title: f.title, records: f.records })),
    chosen.length ? null : reason,
  );
  const blocked = saveButtonReason({ message, findings: chosen.length, reason, rule: rules.unlinked, reasonMinChars: rules.reasonMinChars, messageMaxChars: rules.messageMaxChars, files: files.length });
  const needsReason = chosen.length === 0 && rules.unlinked === "reason";

  const reset = () => {
    setResult(null);
    setOutcome(null);
    setSentPaths([]);
  };

  const submit = () =>
    start(async () => {
      setOutcome(null);
      const paths = files.map((f) => f.path);
      const r = await saveAction({
        revisionId,
        message,
        edits: files.map((f) => ({ path: f.path, content: f.deleted ? null : f.text })),
        findingIds: chosen,
        unlinkedReason: chosen.length ? null : reason.trim() || null,
        expectedHead,
      });
      setResult(r);
      if (r.ok) setSentPaths(paths);
    });

  const onDone = (s: JobStatus) => {
    const res = (s.result ?? null) as { build?: "passed" | "failed"; errors?: number } | null;
    const o: SaveOutcome =
      s.status === "succeeded"
        ? res?.build === "failed"
          ? { kind: "failed", errors: res.errors ?? 0 }
          : { kind: "passed" }
        : { kind: "error", message: s.status === "cancelled" ? "The save was cancelled. Nothing was committed." : (s.error ?? "The save stopped without an error message.") };
    setOutcome(o);
    if (o.kind !== "error") {
      setMessage("");
      setChosen([]);
      setReason("");
      setQ("");
    }
    onSaved(o, o.kind === "error" ? [] : sentPaths);
  };

  const saveBtn = (
    <Button type="button" onClick={submit} disabled={pending || running}>
      <Save aria-hidden />
      {pending ? "Starting…" : "Save and build"}
    </Button>
  );
  const done = outcome !== null && outcome.kind !== "error";
  // Once sent, the dialog keeps naming what was sent (the editor's edits clear when the save lands).
  const count = runId ? sentPaths.length : files.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next && !running) reset();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[700px]">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!blocked && !running && !done) submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Save changes</DialogTitle>
            <DialogDescription>
              {done ? "Committed" : "Commits"} {count} changed {count === 1 ? "file" : "files"} to <span className="font-mono break-all">{branch}</span>
              {done ? " and ran the build and validation." : ", then runs the build and validation."}
            </DialogDescription>
          </DialogHeader>

          {done ? null : (
            <>
              <dl className="grid grid-cols-[minmax(0,auto)_auto] justify-start gap-x-6 gap-y-1 text-[13px]">
                {counts.map((c) => (
                  <div key={c.path} className="contents">
                    <dt className="font-mono text-xs leading-5 break-all text-muted-foreground">{c.path}</dt>
                    <dd>
                      {c.isNew ? <span className="mr-2 text-xs text-success-fg">New file</span> : null}
                      {c.deleted ? <span className="mr-2 text-xs text-destructive-fg">Deleted</span> : null}
                      <DiffCounts added={c.added} removed={c.removed} />
                    </dd>
                  </div>
                ))}
              </dl>

              <div className="grid gap-1.5">
                <Label htmlFor={ids.message}>Message</Label>
                <Textarea
                  id={ids.message}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={2}
                  maxLength={rules.messageMaxChars + 50}
                  readOnly={running}
                  aria-invalid={fieldErrors.message ? true : undefined}
                  aria-describedby={ids.messageHelp}
                  className="min-h-16 text-sm"
                />
                <p id={ids.messageHelp} className="text-xs text-muted-foreground">
                  The message becomes the changelog entry&apos;s title.
                </p>
                {fieldErrors.message ? (
                  <p role="alert" className="text-xs text-destructive-fg">
                    {fieldErrors.message}
                  </p>
                ) : null}
              </div>

              <fieldset className="grid gap-1.5" aria-describedby={ids.findingsHelp}>
                <legend className="mb-1.5 text-sm font-medium">
                  Linked findings{" "}
                  <span className="font-normal text-muted-foreground">{rules.unlinked === "refuse" ? "(at least 1)" : rules.unlinked === "reason" ? "(at least 1, or a reason)" : "(optional)"}</span>
                </legend>
                <InputGroup>
                  <InputGroupAddon>
                    <Search aria-hidden />
                  </InputGroupAddon>
                  <InputGroupInput id={ids.search} type="search" aria-label="Search accepted findings" placeholder="Search accepted findings" value={q} onChange={(e) => setQ(e.target.value)} readOnly={running} />
                </InputGroup>
                {findings.length === 0 ? (
                  <p className="rounded-md border px-3 py-2.5 text-[13px] text-muted-foreground">No audit of this space has accepted findings that a revision can link yet.</p>
                ) : matches.length === 0 ? (
                  <p className="rounded-md border px-3 py-2.5 text-[13px] text-muted-foreground">No accepted finding matches “{q}”.</p>
                ) : (
                  <ul className="max-h-64 overflow-y-auto rounded-md border" aria-label={q ? `Accepted findings matching ${q}` : "Accepted findings"}>
                    {ordered.slice(0, MAX_SHOWN).map((f, i) => {
                      const cid = `${ids.search}-${f.id}`;
                      const t = splitIncident(f.title, f.incidentId);
                      const owner = f.kind === "fix" && f.owner ? `${f.ownerLabel ?? "Owner"}: ${f.owner}` : null;
                      const meta = [f.kindLabel, owner ?? f.auditName, f.kind === "fix" ? f.incidentId : f.acceptedBy ? `accepted by ${f.acceptedBy}` : null].filter(Boolean).join(" · ");
                      const header =
                        ranked.related.length && i === 0 ? (
                          <li key="related-h" className="border-b bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground">
                            About the files you changed
                          </li>
                        ) : ranked.related.length && i === ranked.related.length ? (
                          <li key="rest-h" className="border-b bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground">
                            Other accepted findings
                          </li>
                        ) : null;
                      return [
                        header,
                        <li key={f.id} className="flex items-start gap-2 border-b px-3 py-2 last:border-b-0">
                          <Checkbox id={cid} checked={chosen.includes(f.id)} onCheckedChange={(on) => setChosen((c) => (on ? [...c, f.id] : c.filter((x) => x !== f.id)))} disabled={running} className="-mt-0.5" />
                          <Label htmlFor={cid} className="grid gap-0.5 text-[13px] leading-5 font-normal">
                            <span>
                              {t.incident ? <b>{t.incident}</b> : null}
                              {t.rest}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {meta}
                              {f.linkedBefore ? " · linked by an earlier save" : ""}
                            </span>
                          </Label>
                        </li>,
                      ];
                    })}
                  </ul>
                )}
                <p id={ids.findingsHelp} className="text-xs text-muted-foreground">
                  Only accepted findings can be linked. {chosen.length} selected.{matches.length > MAX_SHOWN ? ` Showing ${MAX_SHOWN} of ${matches.length}; search to narrow them.` : ""}
                </p>
                {fieldErrors.findingIds ? (
                  <p role="alert" className="text-xs text-destructive-fg">
                    {fieldErrors.findingIds}
                  </p>
                ) : null}
              </fieldset>

              {needsReason ? (
                <div className="grid gap-1.5">
                  <Label htmlFor={ids.reason}>Why is this change needed?</Label>
                  <Textarea
                    id={ids.reason}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={2}
                    maxLength={rules.reasonMaxChars}
                    readOnly={running}
                    aria-invalid={fieldErrors.unlinkedReason ? true : undefined}
                    aria-describedby={ids.reasonHelp}
                    className="min-h-14 text-sm"
                  />
                  <p id={ids.reasonHelp} className="text-xs text-muted-foreground">
                    No finding is linked, so the change record says why instead. At least {rules.reasonMinChars} characters.
                  </p>
                  {fieldErrors.unlinkedReason ? (
                    <p role="alert" className="text-xs text-destructive-fg">
                      {fieldErrors.unlinkedReason}
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="grid gap-1.5">
                <p className="text-sm font-medium">Changelog entry</p>
                <div className="space-y-2 rounded-lg border px-4 py-3 text-[13px]">
                  <p className="font-semibold">{preview.title}</p>
                  <p className="break-words">Files: {preview.files}</p>
                  <p className="text-muted-foreground">Evidence: {preview.evidence}</p>
                </div>
              </div>

              {planWarning ? (
                <Callout tone="warning" title={<span className="font-normal">{planWarning}</span>} />
              ) : null}
            </>
          )}

          {result && !result.ok && !Object.keys(result.fieldErrors).length ? (
            <Callout tone="destructive" title="Nothing was saved" afterAction>
              {result.message}
            </Callout>
          ) : null}
          {runId && !outcome ? (
            <div className="space-y-1" aria-live="polite">
              <p className="text-[13px] font-medium">Saving and building</p>
              <JobProgress key={runId} runId={runId} onDone={onDone} />
            </div>
          ) : null}
          {outcome?.kind === "passed" ? (
            <Callout tone="success" title="Saved. The build passed." afterAction>
              The change is on the revision branch with its changelog entry.
            </Callout>
          ) : outcome?.kind === "failed" ? (
            <Callout tone="destructive" title={`Saved. The build has ${outcome.errors} ${outcome.errors === 1 ? "error" : "errors"}.`} afterAction>
              Your change is committed. The build and validation card lists what to fix; save again to build again.
            </Callout>
          ) : outcome?.kind === "error" ? (
            <Callout tone="destructive" title="Nothing was saved" afterAction>
              {outcome.message} Your edits are still in the editor.
            </Callout>
          ) : null}

          <DialogFooter className="items-start sm:items-center">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {running || done ? "Close" : "Cancel"}
              </Button>
            </DialogClose>
            {done ? null : blocked && !running ? <DisabledReason reason={blocked}>{saveBtn}</DisabledReason> : saveBtn}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

