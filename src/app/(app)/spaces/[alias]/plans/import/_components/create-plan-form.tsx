"use client";

import { GitPullRequest, Loader } from "lucide-react";
import { useActionState, useId, useState } from "react";
import { Checkbox } from "@/components/common/checkbox";
import { DisabledReason } from "@/components/common/disabled-reason";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { typeErrorsText, typePlanCountsText } from "@/server/package-io/format";
import type { PlanTypeOption } from "@/server/package-io/loaders";
import { createImportPlanAction, type CreatePlanState } from "../[importId]/actions";
import { selectionBlocker } from "./mapping";

/**
 * "Create the import plan" (pages/package-import.md): the asset types to
 * include, a title, a change reason (required before applying when the
 * space's settings say so, as on the plan page), and the button. Each type
 * says what the plan would hold with the words the plan notes use for a type
 * left out ("48 changes, 5 left out"). Types start
 * all selected; leaving out the types with errors (for example memory) can
 * make the rest plannable. `stateReason` blocks any selection (already
 * planned, rejected, deleted upload).
 */
export function CreatePlanForm({
  alias,
  importId,
  defaultTitle,
  types,
  unattributedErrors,
  blockOnErrors,
  stateReason,
  reasonRequired = false,
}: {
  alias: string;
  importId: string;
  defaultTitle: string;
  types: PlanTypeOption[];
  unattributedErrors: number;
  blockOnErrors: boolean;
  stateReason: string | null;
  /** The space requires a change reason before a plan is applied (settings changeReasonRequired) */
  reasonRequired?: boolean;
}) {
  const id = useId();
  const [state, action, pending] = useActionState<CreatePlanState, FormData>(createImportPlanAction.bind(null, alias), { error: null });
  const [selected, setSelected] = useState<string[]>(() => types.map((t) => t.assetType));
  const chosen = types.filter((t) => selected.includes(t.assetType));
  const changes = chosen.reduce((n, t) => n + t.changes, 0);
  const disabledReason = stateReason ?? selectionBlocker({ types, selected, unattributedErrors, blockOnErrors });
  const toggle = (assetType: string, on: boolean) => setSelected((s) => (on ? [...new Set([...s, assetType])] : s.filter((t) => t !== assetType)));

  const button = (
    <Button type="submit" className="w-full" disabled={pending || !!disabledReason}>
      {pending ? <Loader className="motion-safe:animate-spin" aria-hidden /> : <GitPullRequest aria-hidden />}
      {pending ? "Creating plan" : `Create plan with ${changes} ${changes === 1 ? "change" : "changes"}`}
    </Button>
  );
  return (
    <form action={action} className="flex flex-col gap-3 p-4">
      <input type="hidden" name="importId" value={importId} />
      {types.length ? (
        <fieldset className="flex flex-col gap-1.5" disabled={!!stateReason || pending}>
          <input type="hidden" name="typeSelection" value="1" />
          {selected.map((t) => (
            <input key={t} type="hidden" name="types" value={t} />
          ))}
          <legend className="mb-1.5 text-sm font-medium">Asset types to import</legend>
          <ul className="flex flex-col gap-1" aria-describedby={`${id}-types-help`}>
            {types.map((t) => {
              const box = `${id}-type-${t.assetType}`;
              return (
                <li key={t.assetType} className="flex items-start gap-2">
                  <Checkbox id={box} checked={selected.includes(t.assetType)} onCheckedChange={(v) => toggle(t.assetType, v === true)} disabled={!!stateReason || pending} />
                  <label htmlFor={box} className="min-w-0 flex-1 py-0.5 text-[13px]">
                    <span className="font-semibold">{t.label}</span>{" "}
                    <span className="text-muted-foreground tabular-nums">· {typePlanCountsText({ changes: t.changes, unchanged: t.unchanged ?? 0, leftOut: t.leftOut ?? 0 })}</span>
                    {t.errors > 0 ? <span className="block text-xs text-destructive-fg">{typeErrorsText(t)}</span> : null}
                  </label>
                </li>
              );
            })}
          </ul>
          <p id={`${id}-types-help`} className="text-xs text-muted-foreground">
            Types you leave out stay as they are in the space. The plan notes what was left out.
          </p>
        </fieldset>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-title`}>Plan title</Label>
        <Input id={`${id}-title`} name="title" defaultValue={defaultTitle} maxLength={200} required disabled={!!stateReason} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-reason`}>
          Change reason <span className="font-normal text-muted-foreground">{reasonRequired ? "(required for this space)" : "(optional)"}</span>
        </Label>
        <Textarea id={`${id}-reason`} name="reason" rows={2} maxLength={2000} disabled={!!stateReason} aria-describedby={`${id}-reason-help`} />
        <p id={`${id}-reason-help`} className="text-xs text-muted-foreground">
          {reasonRequired
            ? "Prefilled on the plan. The plan can't be applied without one; you can add or change it there."
            : "Prefilled on the plan. You can change it there before applying."}
        </p>
      </div>
      {disabledReason ? <DisabledReason reason={disabledReason}>{button}</DisabledReason> : button}
      {state.error ? (
        <p role="alert" className="text-xs text-destructive-fg">
          {state.error}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">The plan checks the live space next. You review every diff there before anything is written.</p>
    </form>
  );
}
