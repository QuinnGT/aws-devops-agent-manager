"use client";

import { Check, SquarePen, Undo2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Checkbox } from "@/components/common/checkbox";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { changedValues, type CardField } from "./finding-view";

/**
 * The controls for deciding a finding, shared by the incident page's finding
 * cards and the Findings tab's detail pane (pages/audit-item.md,
 * "Finding card"): Accept, Edit and Reject as outline buttons that look like
 * buttons, the line that says who decided, and the forms for a reject note,
 * an edit and "I checked the record".
 */

/** A key shown on a button while the single-key shortcuts are on. */
export const Kbd = ({ k, on }: { k: string; on: boolean }) => (on ? <kbd className="ml-1 rounded border bg-background px-1 font-mono text-xs text-muted-foreground">{k}</kbd> : null);

/** One look for each decision: Accept in the success colour, Reject in the destructive one, Edit neutral. Literal classes so Tailwind finds them. */
const LOOK = {
  accept: "border-success/45 text-success-fg hover:bg-success/12 hover:text-success-fg dark:border-success/45 dark:hover:bg-success/12",
  edit: "",
  reject: "border-destructive/45 text-destructive-fg hover:bg-destructive/12 hover:text-destructive-fg dark:border-destructive/45 dark:hover:bg-destructive/12",
} as const;

const JOINED = "rounded-none first:rounded-l-lg last:rounded-r-lg not-first:-ml-px focus-visible:z-10";

export interface DecisionButtonsProps {
  state: "proposed" | "accepted" | "rejected";
  /** Accept, reject and change decision are allowed (role, audit state, current review) */
  canAct: boolean;
  canEdit: boolean;
  busy: boolean;
  /** Show the shortcut keys on the buttons */
  keys?: boolean;
  /** The decision, in words: "Alex Rivera, Nov 18, 3:41 PM" */
  decidedBy?: string | null;
  /** Said under the buttons of a finding with a failed citation */
  flagged?: boolean;
  /** Names the finding for assistive technology: "Accept <title>" */
  label?: string;
  onAccept: () => void;
  onEdit: () => void;
  onReject: () => void;
  onReopen: () => void;
  className?: string;
}

/**
 * Accept, Edit and Reject for a proposed finding. A decided finding says who
 * decided, and offers "Change decision". The state chip sits elsewhere, so
 * nothing here reads as a status.
 */
export function DecisionButtons(p: DecisionButtonsProps) {
  if (p.state === "proposed") {
    if (!p.canAct) return null;
    return (
      <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5", p.className)}>
        <div role="group" aria-label={p.label ? `Decide: ${p.label}` : "Decide this finding"} className="inline-flex">
          <Button type="button" size="sm" variant="outline" className={cn(JOINED, LOOK.accept)} onClick={p.onAccept} disabled={p.busy} aria-label={p.label ? `Accept ${p.label}` : undefined}>
            <Check aria-hidden />
            Accept
            <Kbd k="A" on={!!p.keys} />
          </Button>
          {p.canEdit ? (
            <Button type="button" size="sm" variant="outline" className={cn(JOINED, LOOK.edit)} onClick={p.onEdit} disabled={p.busy} aria-label={p.label ? `Edit ${p.label}` : undefined}>
              <SquarePen aria-hidden />
              Edit
              <Kbd k="E" on={!!p.keys} />
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="outline" className={cn(JOINED, LOOK.reject)} onClick={p.onReject} disabled={p.busy} aria-label={p.label ? `Reject ${p.label}` : undefined}>
            <X aria-hidden />
            Reject
            <Kbd k="R" on={!!p.keys} />
          </Button>
        </div>
        {p.flagged ? <span className="text-xs text-muted-foreground">Accepting keeps the flag in the record.</span> : null}
      </div>
    );
  }
  const word = p.state === "accepted" ? "Accepted" : "Rejected";
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5", p.className)}>
      <p className="text-[13px]">
        <span className="font-medium">{word}</span>
        {p.decidedBy ? <span className="text-muted-foreground"> by {p.decidedBy}</span> : null}
      </p>
      {p.canAct ? (
        <Button type="button" size="sm" variant="outline" onClick={p.onReopen} disabled={p.busy} aria-label={p.label ? `Change the decision on ${p.label}` : undefined}>
          <Undo2 aria-hidden />
          Change decision
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Reject with an optional note, in the card's footer under the evidence
 * (pages/audit-detail.md, "Rejecting"), so it never covers the citations it
 * is about. The note is stored as the finding's review note.
 */
export function RejectForm({ busy, onCancel, onReject }: { busy: boolean; onCancel: () => void; onReject: (note: string) => void }) {
  const [note, setNote] = useState("");
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onReject(note.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
      className="space-y-2 border-t px-4 py-2.5 text-[13px]"
    >
      <Label htmlFor={id}>Why, for the record</Label>
      <Textarea ref={ref} id={id} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} placeholder="Optional" />
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="destructive" disabled={busy}>
          <X aria-hidden />
          Reject
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** "I checked the record": a short note on what the record shows. The check's own result stays in the record. */
export function CheckForm({ record, busy, onCancel, onSave }: { record: number; busy: boolean; onCancel: () => void; onSave: (note: string) => Promise<string | null> }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!note.trim()) return setError("Say what you found in the record.");
        setSaving(true);
        const err = await onSave(note.trim());
        setSaving(false);
        setError(err);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
      className="w-full space-y-1.5 rounded-lg border bg-muted/30 p-2.5"
    >
      <Label htmlFor={id}>What did you find in R{record}?</Label>
      <Textarea
        ref={ref}
        id={id}
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          setError(null);
        }}
        rows={2}
        maxLength={500}
        placeholder="For example: the numbers are there; only the dash differs."
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-help`}
      />
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        Shown with the citation as &quot;Checked by&quot; you. The failed check stays in the record.
      </p>
      {error ? (
        <p role="alert" className="text-xs text-destructive-fg">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || saving}>
          <Check aria-hidden />
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function EditForm({ fields, busy, onCancel, onSave }: { fields: CardField[]; busy: boolean; onCancel: () => void; onSave: (values: Record<string, unknown>) => void }) {
  const editable = fields.filter((x) => x.editable);
  const current = Object.fromEntries(fields.map((x) => [x.key, x.value]));
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(editable.map((x) => [x.key, x.value])));
  const id = useId();
  const first = useRef<HTMLDivElement>(null);
  useEffect(() => {
    (first.current?.querySelector("select, textarea, input") as HTMLElement | null)?.focus();
  }, []);
  const set = (k: string, v: unknown) => setValues((s) => ({ ...s, [k]: v }));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(changedValues(current, values));
      }}
      className="space-y-3 text-[13px]"
    >
      <div ref={first} className="space-y-3">
        {editable.map((x) => {
          const fid = `${id}-${x.key}`;
          const v = values[x.key];
          if (x.choices && x.multiple) {
            const list = Array.isArray(v) ? (v as string[]) : [];
            return (
              <fieldset key={x.key} className="space-y-1.5">
                <legend className="mb-1 font-medium">{x.label}</legend>
                <div className="grid gap-1 sm:grid-cols-2">
                  {x.choices.map((c) => (
                    <label key={c.value} className="flex min-h-6 items-center gap-2">
                      <Checkbox checked={list.includes(c.value)} onCheckedChange={(on) => set(x.key, on ? [...list, c.value] : list.filter((y) => y !== c.value))} />
                      {c.label}
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          }
          if (x.choices && x.choices.length <= 4) {
            return (
              <fieldset key={x.key} className="space-y-1.5">
                <legend className="mb-1 font-medium">{x.label}</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {x.choices.map((c) => (
                    <label key={c.value} className="flex min-h-6 items-center gap-2">
                      <input type="radio" name={fid} value={c.value} checked={v === c.value} onChange={() => set(x.key, c.value)} className="size-4 accent-foreground" />
                      {c.label}
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          }
          if (x.choices) {
            return (
              <div key={x.key} className="space-y-1.5">
                <Label htmlFor={fid}>{x.label}</Label>
                <select id={fid} value={typeof v === "string" ? v : ""} onChange={(e) => set(x.key, e.target.value)} className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30">
                  {x.choices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            );
          }
          return (
            <div key={x.key} className="space-y-1.5">
              <Label htmlFor={fid}>{x.label}</Label>
              <Textarea id={fid} value={typeof v === "string" ? v : v === null || v === undefined ? "" : String(v)} onChange={(e) => set(x.key, e.target.value)} rows={3} />
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">Other fields stay as the review proposed them. The proposed values are kept in the record.</p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          <Check aria-hidden />
          Save and accept
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
