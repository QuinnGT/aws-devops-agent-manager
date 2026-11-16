"use client";

import { GitBranch } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useId, useState, useTransition } from "react";
import { SyncNowButton } from "@/components/app-shell/sync-now-button";
import { Callout } from "@/components/common/callout";
import { DisabledReason } from "@/components/common/disabled-reason";
import { RelativeTime } from "@/components/common/relative-time";
import { JobProgress, type JobStatus } from "@/components/job-progress";
import type { ActionResult } from "@/components/plans/action-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { branchPreview, folderPreview, nameProblem } from "./words";

export type CreateRevisionAction = (input: { name: string; base: "live" | "release"; releaseId: string; layout: string }) => Promise<ActionResult<{ runId: string; revisionId: string; name: string }>>;

export interface NewRevisionDialogProps {
  alias: string;
  /** createRevisionAction bound to the space alias */
  createAction: CreateRevisionAction;
  /** Newest first: "v1.2 · Nov 10, 4:15 PM · 21 assets", the release note and whether it is the latest */
  releases: { id: string; name: string; detail: string; note?: string | null; latest?: boolean }[];
  live: { assets: number; lastSyncAt: string | null; stale: boolean; lastSyncText: string | null };
  canSync: boolean;
  /** With one line on what each is for (package-layouts.yaml description) */
  layouts: { name: string; label: string; description?: string | null }[];
  /** The space's usual layout (its last import or release), else the policy default */
  defaultLayout: string;
  /** Why that one: "Usual for this space: its last package import (Nov 13) used it." */
  usualLayoutText?: string;
  /** The space has no import or revision release yet, so `defaultLayout` is the app's default rather than its usual one */
  layoutIsDefault?: boolean;
  /** history-layout revisionBranch and packageDir, with {spaceAlias}, {name} and {package} */
  branchTemplate: string;
  folderTemplate: string;
  nameRule: { pattern: string; hint: string; maxLength: number };
  repoName: string | null;
  /** Why no revision can be created (no history repository), or null */
  blocked: string | null;
  canManage: boolean;
  /** "New revision" in the empty state is a second trigger of the same dialog */
  triggerLabel?: string;
  /** Names of the space's revisions, compared ignoring case (revisions.yaml name.uniqueIgnoringCase) */
  takenNames?: string[];
}

/** "v1.2 (latest) · Nov 13, 1:36 PM · 49 assets": a release as the closed Select shows it. */
function releaseLine(r: NewRevisionDialogProps["releases"][number]): string {
  return `${r.name}${r.latest ? " (latest)" : ""} · ${r.detail}`;
}

/**
 * "New revision" and its dialog (pages/revisions.md, "New revision dialog").
 * Creating starts the revisions.create job and shows its progress here,
 * then opens the revision. Nothing is written to the space.
 */
export function NewRevisionDialog(p: NewRevisionDialogProps) {
  const router = useRouter();
  const ids = { name: useId(), nameHelp: useId(), nameError: useId(), from: useId(), release: useId(), releaseNote: useId(), layout: useId(), layoutHelp: useId() };
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [base, setBase] = useState<"release" | "live">(p.releases.length ? "release" : "live");
  const [releaseId, setReleaseId] = useState(p.releases[0]?.id ?? "");
  const [layout, setLayout] = useState(p.defaultLayout);
  const [result, setResult] = useState<ActionResult<{ runId: string; revisionId: string; name: string }> | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const chosenRelease = p.releases.find((r) => r.id === releaseId) ?? null;
  const chosenLayout = p.layouts.find((l) => l.name === layout) ?? null;
  const usualMark = p.layoutIsDefault ? "default" : "usual for this space";
  const trimmed = name.trim();
  const taken = (p.takenNames ?? []).some((n) => n.toLowerCase() === trimmed.toLowerCase());
  const localProblem = nameProblem(trimmed, p.nameRule) ?? (taken ? "A revision with this name already exists. Its branch would be the same." : null);
  const fieldErrors = result && !result.ok ? result.fieldErrors : {};
  const shownNameError = localProblem ?? fieldErrors.name ?? null;
  const runId = result?.ok ? result.runId : null;
  const running = runId !== null && jobError === null;

  const onDone = useCallback(
    (s: JobStatus) => {
      if (!result?.ok) return;
      if (s.status === "succeeded") {
        router.push(`/spaces/${encodeURIComponent(p.alias)}/revisions/${encodeURIComponent(result.name)}`);
        return;
      }
      setJobError(s.status === "cancelled" ? "The create job was cancelled. The revision wasn't created." : (s.error ?? "The create job stopped without an error message."));
    },
    [p.alias, result, router],
  );

  const submit = () =>
    start(async () => {
      setJobError(null);
      setResult(await p.createAction({ name: trimmed, base, releaseId: base === "release" ? releaseId : "", layout }));
    });

  const reason = p.blocked ?? (!trimmed ? "Enter a name." : localProblem ? "Fix the name first." : base === "release" && !releaseId ? "Choose a release." : null);
  const create = (
    <Button type="button" onClick={submit} disabled={pending || running}>
      <GitBranch aria-hidden />
      {pending ? "Starting…" : "Create revision"}
    </Button>
  );
  const branch = branchPreview(p.branchTemplate, p.alias, trimmed);
  const folder = folderPreview(p.folderTemplate, p.alias, trimmed);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next && !running) {
          setResult(null);
          setJobError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <GitBranch aria-hidden />
          {p.triggerLabel ?? "New revision"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[540px]">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!reason && !running) submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New revision</DialogTitle>
            <DialogDescription>Starts a package on its own branch of the history repository. Nothing changes in the space until a plan is applied.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor={ids.name}>Name</Label>
            <Input
              id={ids.name}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (result && !result.ok) setResult(null);
              }}
              maxLength={p.nameRule.maxLength}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              required
              readOnly={running}
              aria-invalid={shownNameError ? true : undefined}
              aria-describedby={`${ids.nameHelp}${shownNameError ? ` ${ids.nameError}` : ""}`}
            />
            <p id={ids.nameHelp} className="text-xs text-muted-foreground">
              Letters, numbers, dots, hyphens and underscores, for example v2.4-onset. The branch is <span className="font-mono break-all">{branch}</span>, and applying its plan tags a release with this name.
            </p>
            {shownNameError ? (
              <p id={ids.nameError} role="alert" className="text-xs text-destructive-fg">
                {shownNameError}
              </p>
            ) : null}
          </div>

          <fieldset className="grid gap-2">
            <legend id={ids.from} className="mb-2 text-sm font-medium">
              Start from
            </legend>
            <label className={cn("flex items-start gap-3 rounded-lg border px-3.5 py-3", base === "release" && "border-2 border-foreground px-[13px] py-[11px]", !p.releases.length && "opacity-80")}>
              <input type="radio" name="base" value="release" checked={base === "release"} onChange={() => setBase("release")} disabled={!p.releases.length || running} className="mt-1 size-4 accent-foreground" />
              <span className="grid min-w-0 flex-1 gap-1.5">
                <span className="text-sm font-semibold">A release</span>
                {p.releases.length ? (
                  <>
                    <Select value={releaseId} onValueChange={setReleaseId} disabled={base !== "release" || running}>
                      <SelectTrigger id={ids.release} aria-label="Release" className="w-full" aria-describedby={ids.releaseNote}>
                        <SelectValue>{chosenRelease ? releaseLine(chosenRelease) : null}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {p.releases.map((r) => (
                          <SelectItem key={r.id} value={r.id} className="items-start py-1.5">
                            <span className="grid min-w-0 gap-0.5">
                              <span>
                                {r.name}
                                {r.latest ? <span className="ml-1.5 rounded-sm bg-muted px-1 text-xs font-medium text-muted-foreground">Latest</span> : null}
                                <span className="text-muted-foreground"> · {r.detail}</span>
                              </span>
                              {r.note ? <span className="line-clamp-2 max-w-[420px] text-xs whitespace-normal text-muted-foreground">{r.note}</span> : null}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <span id={ids.releaseNote} className="text-xs text-muted-foreground">
                      {chosenRelease?.note ? chosenRelease.note : "This release has no note."}
                    </span>
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">There are no releases yet.</span>
                )}
              </span>
            </label>
            <label className={cn("flex items-start gap-3 rounded-lg border px-3.5 py-3", base === "live" && "border-2 border-foreground px-[13px] py-[11px]")}>
              <input type="radio" name="base" value="live" checked={base === "live"} onChange={() => setBase("live")} disabled={running} className="mt-1 size-4 accent-foreground" />
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="text-sm font-semibold">The live space</span>
                <span className="text-xs text-muted-foreground">
                  {p.live.lastSyncAt ? (
                    <>
                      As of the last sync, <RelativeTime value={p.live.lastSyncAt} />. {p.live.assets} {p.live.assets === 1 ? "asset" : "assets"}.
                    </>
                  ) : (
                    "The space hasn't been synced yet."
                  )}{" "}
                  Creating it syncs the space first.
                </span>
              </span>
            </label>
            {base === "live" && p.live.stale ? (
              <Callout tone="warning" title={<span className="font-normal">The last sync was {p.live.lastSyncText ?? "never"}. Sync first so the revision starts from what is live.</span>} action={p.canSync ? <SyncNowButton alias={p.alias} /> : undefined} />
            ) : null}
          </fieldset>

          <div className="grid gap-1.5">
            <Label htmlFor={ids.layout}>Layout</Label>
            <Select value={layout} onValueChange={setLayout} disabled={running}>
              <SelectTrigger id={ids.layout} className="w-full" aria-describedby={ids.layoutHelp}>
                <SelectValue>{chosenLayout ? `${chosenLayout.label}${chosenLayout.name === p.defaultLayout ? ` (${usualMark})` : ""}` : null}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {p.layouts.map((l) => (
                  <SelectItem key={l.name} value={l.name} className="items-start py-1.5">
                    <span className="grid min-w-0 gap-0.5">
                      <span>
                        {l.label}
                        {l.name === p.defaultLayout ? <span className="text-muted-foreground"> ({usualMark})</span> : null}
                      </span>
                      {l.description ? <span className="max-w-[440px] text-xs whitespace-normal text-muted-foreground">{l.description}</span> : null}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p id={ids.layoutHelp} className="text-xs text-muted-foreground">
              {chosenLayout?.description ?? "The base is written as a package in this layout."}
              {layout === p.defaultLayout && p.usualLayoutText ? ` ${p.usualLayoutText}` : ""}
            </p>
          </div>

          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-[13px]">
            <dt className="text-muted-foreground">Folder</dt>
            <dd className="font-mono text-xs leading-5 break-all">{folder}</dd>
            <dt className="text-muted-foreground">Repository</dt>
            <dd className="font-mono text-xs leading-5 break-all">{p.repoName ?? "None"}</dd>
          </dl>

          {p.blocked ? (
            <Callout tone="info" title={p.blocked}>
              {p.canManage ? (
                <Link href={`/spaces/${encodeURIComponent(p.alias)}/settings`} className="underline underline-offset-4">
                  Open Space settings
                </Link>
              ) : (
                "Ask an Admin to set one up in Space settings."
              )}
            </Callout>
          ) : null}
          {result && !result.ok && !fieldErrors.name ? (
            <Callout tone="destructive" title="The revision wasn't created" afterAction>
              {result.message} Check the form and try again.
            </Callout>
          ) : null}
          {jobError ? (
            <Callout tone="destructive" title="The revision wasn't created" afterAction>
              {jobError}
            </Callout>
          ) : null}
          {runId && !jobError ? (
            <div className="space-y-1" aria-live="polite">
              <p className="text-[13px] font-medium">Creating revision {result?.ok ? result.name : ""}</p>
              <JobProgress key={runId} runId={runId} onDone={onDone} />
            </div>
          ) : null}

          <DialogFooter className="items-start sm:items-center">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {running ? "Close" : "Cancel"}
              </Button>
            </DialogClose>
            {reason && !running ? <DisabledReason reason={reason}>{create}</DisabledReason> : create}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
