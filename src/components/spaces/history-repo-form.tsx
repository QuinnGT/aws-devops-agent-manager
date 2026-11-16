"use client";

import { type ReactElement, useCallback, useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/common/callout";
import { Checkbox } from "@/components/common/checkbox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CheckField, Field, FormMessage } from "./field";
import type { FormState } from "./form-state";
import { useActionForm } from "./use-action-form";

export interface HistoryRepoValues {
  name: string;
  remoteUrl: string | null;
  deployKeyFile: string | null;
  defaultBranch: string;
  pushEnabled: boolean;
}

const textInput = { autoComplete: "off", spellCheck: false } as const;

/**
 * The fields of a history repository. `prefix` is prepended to each field
 * name ("historyRepo.repo." on the registration form); `idPrefix` keeps
 * element IDs unique. `lockedBy` names the space that writes to the
 * repository, which fixes its name and branch.
 */
export function HistoryRepoFields({
  prefix = "",
  idPrefix,
  current,
  lockedBy,
  error,
}: {
  prefix?: string;
  idPrefix: string;
  current: HistoryRepoValues | null;
  lockedBy?: string | null;
  error: (name: string) => string | undefined;
}) {
  const [push, setPush] = useState(current?.pushEnabled ?? false);
  const [remote, setRemote] = useState(current?.remoteUrl ?? "");
  const id = (name: string) => `${idPrefix}-${name}`;
  const name = (field: string) => `${prefix}${field}`;
  const locked = lockedBy ? `Space ${lockedBy} writes to this repository, so this can't change.` : null;

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id={id("name")} label="Name" hint={locked ?? "Letters, digits, dots, hyphens and underscores."} error={error(name("name"))}>
        <Input id={id("name")} name={name("name")} defaultValue={current?.name ?? ""} readOnly={Boolean(lockedBy)} className="font-mono text-xs read-only:bg-muted md:text-xs" placeholder="anycompany-agent-history" {...textInput} />
      </Field>
      <Field id={id("defaultBranch")} label="Branch" hint={locked ?? "Commits go to this branch, and push sends it. Leave empty for main."} error={error(name("defaultBranch"))}>
        <Input id={id("defaultBranch")} name={name("defaultBranch")} defaultValue={current?.defaultBranch ?? "main"} readOnly={Boolean(lockedBy)} className="font-mono text-xs read-only:bg-muted md:text-xs" placeholder="main" {...textInput} />
      </Field>
      <Field id={id("remoteUrl")} label="Remote URL" optional hint="An https:// or ssh:// URL, or git@host:owner/repo.git. Leave empty for a local-only repository." error={error(name("remoteUrl"))}>
        <Input id={id("remoteUrl")} name={name("remoteUrl")} value={remote} onChange={(e) => setRemote(e.target.value)} placeholder="git@github.com:owner/repo.git" className="font-mono text-xs md:text-xs" {...textInput} />
      </Field>
      <Field id={id("deployKeyFile")} label="Deploy key file path" optional hint="A file the worker can read. Never paste the key itself." error={error(name("deployKeyFile"))}>
        <Input id={id("deployKeyFile")} name={name("deployKeyFile")} defaultValue={current?.deployKeyFile ?? ""} placeholder="/run/secrets/history_deploy_key" className="font-mono text-xs md:text-xs" {...textInput} />
      </Field>
      <div className="sm:col-span-2">
        <CheckField
          id={id("pushEnabled")}
          label="Push commits to the remote"
          hint="Off by default: history stays in the working copy on the machine that runs the worker. Push needs a remote URL and a deploy key file."
          error={error(name("pushEnabled"))}
          control={
            <Checkbox
              id={id("pushEnabled")}
              name={name("pushEnabled")}
              checked={push}
              onCheckedChange={(v) => setPush(v === true)}
              aria-describedby={`${id("pushEnabled")}-hint${push ? ` ${id("push-warning")}` : ""}`}
            />
          }
        >
          {push ? (
            <div id={id("push-warning")}>
              <Callout tone="warning" title="Commits will leave this machine">
                Every commit in this repository is pushed to {remote.trim() ? <span className="font-mono text-xs break-all">{remote.trim()}</span> : "the remote"}. The
                commits hold the space&apos;s instructions, skills, memories and audit findings, so the remote repository must stay private.
              </Callout>
            </div>
          ) : null}
        </CheckField>
      </div>
    </div>
  );
}

/**
 * Add or edit a history repository in a dialog. The dialog closes and a
 * toast confirms when the save succeeds; errors stay inside it.
 */
export function HistoryRepoDialog({
  action,
  current,
  lockedBy = null,
  title,
  description,
  trigger,
  submitLabel,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  current: HistoryRepoValues | null;
  lockedBy?: string | null;
  title: string;
  description: string;
  trigger: ReactElement;
  submitLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const save = useCallback(
    async (prev: FormState, form: FormData) => {
      const r = await action(prev, form);
      if (r.ok) {
        setOpen(false);
        if (r.message) toast.success(r.message);
      }
      return r;
    },
    [action],
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {open ? <RepoForm action={save} current={current} lockedBy={lockedBy} submitLabel={submitLabel} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function RepoForm({
  action,
  current,
  lockedBy,
  submitLabel,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  current: HistoryRepoValues | null;
  lockedBy: string | null;
  submitLabel: string;
}) {
  const f = useActionForm(action, { toast: false });
  return (
    <form onSubmit={f.onSubmit} noValidate className="space-y-4">
      <HistoryRepoFields idPrefix={current ? `repo-${current.name}` : "repo-new"} current={current} lockedBy={lockedBy} error={f.error} />
      <FormMessage state={f.state} />
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" size="sm">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" size="sm" disabled={f.pending}>
          {f.pending ? "Saving…" : submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
