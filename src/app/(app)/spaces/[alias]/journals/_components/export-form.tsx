"use client";

import { ChevronDown, Download } from "lucide-react";
import { useActionState, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/common/callout";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { requestExportAction } from "../actions";
import { initialActionState } from "./action-state";
import { enumLabel } from "./words";

interface Props {
  alias: string;
  taskTypes: string[];
  statuses: string[];
  priorities: string[];
  maxIds: number;
  hasIncidentRule: boolean;
}

type Mode = "filter" | "taskIds" | "incidentIds";

const MODES: [Mode, string][] = [
  ["filter", "Date range and filters"],
  ["taskIds", "Task IDs"],
  ["incidentIds", "Incident IDs"],
];

/** A checkbox menu whose choices are sent as hidden inputs named `name`. */
function ChoiceMenu({ name, label, values }: { name: string; label: string; values: string[] }) {
  const [picked, setPicked] = useState<string[]>([]);
  const text = picked.length === 0 ? `${label}: All` : picked.length === 1 ? `${label}: ${enumLabel(picked[0]!)}` : `${label}: ${picked.length} selected`;
  return (
    <>
      {picked.map((v) => (
        <input key={v} type="hidden" name={name} value={v} />
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            {text}
            <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52">
          <DropdownMenuItem disabled={picked.length === 0} onSelect={() => setPicked([])}>
            Include all
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {values.map((v) => (
            <DropdownMenuCheckboxItem
              key={v}
              checked={picked.includes(v)}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(on) => setPicked(on ? [...picked, v] : picked.filter((p) => p !== v))}
            >
              {enumLabel(v)}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/** Segmented radio group on native radios, so the form posts `mode` and the keyboard works as usual. */
function ModeChoice({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">Select investigations by</legend>
      <div className="inline-flex flex-wrap gap-1 rounded-lg bg-muted p-1">
        {MODES.map(([value, label]) => (
          <label
            key={value}
            className={cn(
              "inline-flex h-7 cursor-pointer items-center rounded-md px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground",
              "has-[:checked]:bg-background has-[:checked]:text-foreground has-[:checked]:shadow-sm",
              "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
            )}
          >
            <input type="radio" name="mode" value={value} checked={mode === value} onChange={() => onChange(value)} className="sr-only" />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ExportForm({ alias, taskTypes, statuses, priorities, maxIds, hasIncidentRule }: Props) {
  const [state, action, pending] = useActionState(requestExportAction.bind(null, alias), initialActionState);
  const [mode, setMode] = useState<Mode>("filter");
  const id = useId();

  useEffect(() => {
    if (state.status === "ok") toast.success(state.message);
  }, [state]);

  return (
    <form action={action} className="space-y-4 px-4 py-4 text-sm">
      <ModeChoice mode={mode} onChange={setMode} />

      {mode === "taskIds" ? (
        <div className="max-w-2xl space-y-1">
          <Label htmlFor={`${id}-tasks`}>Task IDs</Label>
          <Textarea id={`${id}-tasks`} name="taskIds" rows={4} required className="font-mono text-xs" aria-describedby={`${id}-tasks-help`} />
          <p id={`${id}-tasks-help`} className="text-xs text-muted-foreground">
            Separate IDs with commas, spaces or new lines. At most {maxIds}.
          </p>
        </div>
      ) : null}

      {mode === "incidentIds" ? (
        <div className="max-w-2xl space-y-1">
          <Label htmlFor={`${id}-incidents`}>Incident IDs</Label>
          <Textarea id={`${id}-incidents`} name="incidentIds" rows={4} required className="font-mono text-xs" aria-describedby={`${id}-inc-help`} />
          <p id={`${id}-inc-help`} className="text-xs text-muted-foreground">
            Separate IDs with commas, spaces or new lines. At most {maxIds}.{" "}
            {hasIncidentRule
              ? "Tasks are matched with this space's incident ID rule; the filters below narrow the tasks that are searched."
              : "This space has no incident ID rule, so incident IDs can't be matched. An Admin can set one in the space settings."}
          </p>
        </div>
      ) : null}

      {mode !== "taskIds" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor={`${id}-from`}>Created from</Label>
              <Input id={`${id}-from`} type="date" name="from" className="w-44" />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-to`}>Created to, inclusive</Label>
              <Input id={`${id}-to`} type="date" name="to" className="w-44" />
            </div>
          </div>
          <div role="group" aria-label="Task filters" className="flex flex-wrap items-center gap-2">
            <ChoiceMenu name="taskTypes" label="Type" values={taskTypes} />
            <ChoiceMenu name="statuses" label="Status" values={statuses} />
            <ChoiceMenu name="priorities" label="Priority" values={priorities} />
          </div>
          <p className="max-w-[72ch] text-xs text-muted-foreground">
            Dates are UTC days. A menu left at All includes every value; each value you pick is one API call.
          </p>
        </div>
      ) : null}

      {state.status === "error" ? (
        <Callout tone="destructive" title="The export wasn't queued" afterAction>
          {state.message}
        </Callout>
      ) : null}

      <Button type="submit" disabled={pending}>
        <Download aria-hidden />
        {pending ? "Queuing export…" : "Start export"}
      </Button>
    </form>
  );
}
