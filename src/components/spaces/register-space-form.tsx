"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FormMessage, selectClass } from "./field";
import type { FormState } from "./form-state";
import { HistoryRepoFields } from "./history-repo-form";
import { SettingsCard } from "./settings-card";
import { useActionForm } from "./use-action-form";

interface RepoOption {
  id: string;
  name: string;
  remoteUrl: string | null;
}

const textInput = { autoComplete: "off", spellCheck: false } as const;

export function RegisterSpaceForm({ action, repos }: { action: (prev: FormState, form: FormData) => Promise<FormState>; repos: RepoOption[] }) {
  const f = useActionForm(action);
  const [repoMode, setMode] = useState<"existing" | "new">(repos.length > 0 ? "existing" : "new");

  const text = (name: string, label: string, opts: { hint?: string; placeholder?: string; optional?: boolean; mono?: boolean } = {}) => (
    <Field id={name} label={label} hint={opts.hint} optional={opts.optional} error={f.error(name)}>
      <Input id={name} name={name} placeholder={opts.placeholder} className={opts.mono ? "font-mono text-xs md:text-xs" : undefined} {...textInput} />
    </Field>
  );

  return (
    <form onSubmit={f.onSubmit} noValidate className="space-y-4">
      <SettingsCard id="register-space" title="Agent Space" description="Find these in the DevOps Agent console. The alias is used in URLs and can't change later.">
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          {text("alias", "Alias", { placeholder: "anycompany-prod", hint: "3 to 40 lowercase letters, digits or hyphens." })}
          {text("displayName", "Display name", { placeholder: "AnyCompany production", optional: true, hint: "Leave empty to show the alias." })}
          {text("region", "Region", { placeholder: "us-west-2", hint: "The Region code, such as us-west-2." })}
          {text("accountId", "AWS account ID", { placeholder: "111122223333", hint: "12 digits, no hyphens.", mono: true })}
          <div className="sm:col-span-2">{text("agentSpaceId", "Agent Space ID", { placeholder: "00000000-0000-4000-8000-0000000000bb", mono: true })}</div>
        </div>
      </SettingsCard>

      <SettingsCard
        id="register-access"
        title="Connection and roles"
        description="The app stores role ARNs or a profile name, never credentials. Leave all three empty to use this app's own AWS credentials. When you give role ARNs, the app generates an external ID that each role's trust policy must require; you'll find it in the space settings."
      >
        <div className="grid gap-4 p-4 lg:grid-cols-2">
          {text("readRoleArn", "Read role ARN", { placeholder: "arn:aws:iam::111122223333:role/DevOpsAgentManagerRead", optional: true, mono: true, hint: "Used for browsing, syncing and exports." })}
          {text("writeRoleArn", "Write role ARN", { placeholder: "arn:aws:iam::111122223333:role/DevOpsAgentManagerWrite", optional: true, mono: true, hint: "Used only to apply plans, restores included." })}
          {text("awsProfile", "AWS profile (local mode)", { placeholder: "anycompany-poc", optional: true, hint: "A profile name from the AWS config on the machine running the app. Not a key." })}
        </div>
      </SettingsCard>

      <SettingsCard
        id="register-history"
        title="History repository"
        description="Every change to this space is committed here. Give a test space its own repository, so a customer's history never holds test commits."
      >
        <div className="space-y-4 p-4">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Repository</legend>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <label className={`flex min-h-6 items-center gap-2 ${repos.length === 0 ? "text-muted-foreground" : ""}`}>
                <input
                  type="radio"
                  name="historyRepo.mode"
                  value="existing"
                  checked={repoMode === "existing"}
                  disabled={repos.length === 0}
                  onChange={() => setMode("existing")}
                  className="size-4 accent-primary"
                  aria-describedby={repos.length === 0 ? "no-repos" : undefined}
                />
                Use an existing repository
              </label>
              <label className="flex min-h-6 items-center gap-2">
                <input type="radio" name="historyRepo.mode" value="new" checked={repoMode === "new"} onChange={() => setMode("new")} className="size-4 accent-primary" />
                Add a repository
              </label>
            </div>
            {repos.length === 0 ? (
              <p id="no-repos" className="text-xs text-muted-foreground">
                No repositories yet, so this space adds one.
              </p>
            ) : null}
          </fieldset>

          {repoMode === "existing" ? (
            <Field id="historyRepo.id" label="Existing repository" error={f.error("historyRepo.id")} className="max-w-xl">
              <select id="historyRepo.id" name="historyRepo.id" defaultValue={repos[0]?.id} className={selectClass}>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                    {r.remoteUrl ? ` (${r.remoteUrl})` : " (local only)"}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <HistoryRepoFields prefix="historyRepo.repo." idPrefix="new-repo" current={null} error={f.error} />
          )}
          <FieldError error={f.error("historyRepo")} />
        </div>
      </SettingsCard>

      <div className="space-y-3">
        <FormMessage state={f.state} />
        <Button type="submit" disabled={f.pending}>
          {f.pending ? "Registering…" : "Register and test connection"}
        </Button>
      </div>
    </form>
  );
}
