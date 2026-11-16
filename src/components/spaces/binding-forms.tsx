"use client";

import { useActionState, useState, useTransition } from "react";
import { DisabledReason } from "@/components/common/disabled-reason";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, selectClass } from "./field";
import { type FormState, initialFormState } from "./form-state";
import { roleLabel } from "./labels";
import { SaveBar } from "./settings-card";
import { useActionForm, useSavedToast } from "./use-action-form";

export interface ScopeOption {
  /** "" for global */
  value: string;
  label: string;
}

export interface RoleOption {
  name: string;
  description: string;
}

/**
 * Bind a user or group to a role. With one scope the scope is fixed (a hidden
 * field). `grantable` lists, per scope value, the roles the caller may grant
 * there; roles above the caller's own are not offered.
 */
export function AddBindingForm({
  action,
  scopes,
  roles,
  grantable,
}: {
  action: (prev: FormState, form: FormData) => Promise<FormState>;
  scopes: ScopeOption[];
  roles: RoleOption[];
  grantable?: Record<string, string[]>;
}) {
  const f = useActionForm(action);
  const [scope, setScope] = useState(scopes[0]?.value ?? "");
  const allowed = roles.filter((r) => !grantable || grantable[scope]?.includes(r.name));
  const [role, setRole] = useState(allowed.at(-1)?.name ?? "");
  // Keep the chosen role valid when the scope changes.
  const roleValue = allowed.some((r) => r.name === role) ? role : (allowed.at(-1)?.name ?? "");
  const fixed = scopes.length === 1 ? scopes[0] : null;
  const description = roles.find((r) => r.name === roleValue)?.description;

  return (
    <form onSubmit={f.onSubmit} noValidate>
      <div className="space-y-3 p-4">
        <h3 className="text-sm font-semibold">Add or change a binding</h3>
        <p className="max-w-[72ch] text-xs text-muted-foreground">
          Saving a person or group that already has a role here replaces that role.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {fixed ? (
            <input type="hidden" name="spaceId" value={fixed.value} />
          ) : (
            <Field id="binding-scope" label="Scope" error={f.error("spaceId")}>
              <select id="binding-scope" name="spaceId" value={scope} onChange={(e) => setScope(e.target.value)} className={selectClass}>
                {scopes.map((s) => (
                  <option key={s.value || "global"} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field id="binding-type" label="Bind" error={f.error("subjectType")}>
            <select id="binding-type" name="subjectType" defaultValue="user" className={selectClass}>
              <option value="user">A person, by email</option>
              <option value="group">A group from your sign-in provider</option>
            </select>
          </Field>
          <Field id="binding-subject" label="User email or group name" error={f.error("subject")} className={fixed ? "lg:col-span-2" : undefined}>
            <Input id="binding-subject" name="subject" placeholder="name@example.com" autoComplete="off" spellCheck={false} />
          </Field>
          <Field id="binding-role" label="Role" hint={description} error={f.error("role")}>
            <select id="binding-role" name="role" value={roleValue} onChange={(e) => setRole(e.target.value)} className={selectClass}>
              {allowed.map((r) => (
                <option key={r.name} value={r.name}>
                  {roleLabel(r.name)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      <SaveBar state={f.state} pending={f.pending} label="Save binding" />
    </form>
  );
}

/**
 * Remove a binding after an AlertDialog confirms it. With `blockedReason` the
 * button is disabled and the reason shows beside it.
 */
export function RemoveBindingButton({
  action,
  subject,
  role,
  scopeLabel,
  blockedReason,
}: {
  action: (prev: FormState) => Promise<FormState>;
  subject: string;
  role: string;
  scopeLabel: string;
  blockedReason?: string | null;
}) {
  const [state, dispatch, pending] = useActionState(action, initialFormState);
  const [, startTransition] = useTransition();
  useSavedToast(state);

  const label = `Remove the ${roleLabel(role)} binding for ${subject}`;
  if (blockedReason) {
    return (
      <DisabledReason reason={blockedReason} className="justify-end">
        <Button type="button" size="sm" variant="outline" aria-label={label}>
          Remove
        </Button>
      </DisabledReason>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button type="button" size="sm" variant="outline" aria-label={label}>
            Remove
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this binding?</AlertDialogTitle>
            <AlertDialogDescription>
              {subject} loses the {roleLabel(role)} role for {scopeLabel}. Other bindings that match this subject still apply.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <FieldError error={!state.ok && state.message ? state.message : undefined} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                startTransition(() => dispatch());
              }}
            >
              {pending ? "Removing…" : "Remove binding"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
