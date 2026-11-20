"use client";

import { CircleCheck, TriangleAlert } from "lucide-react";
import { useId } from "react";
import { cn } from "@/lib/utils";
import type { CardField } from "./finding-view";

/** The citation chip and a field's value, shared by the incident page's finding cards and the Findings tab's detail. */

export function CitationChip({ n, pressed, onClick, failed, checked, reason, id: buttonId }: { n: number; pressed: boolean; onClick: () => void; failed?: boolean; checked?: boolean; reason?: string | null; id?: string }) {
  const id = useId();
  return (
    <span className="inline-flex max-w-full items-start gap-1.5">
      <button
        id={buttonId}
        type="button"
        aria-pressed={pressed}
        aria-describedby={reason ? id : undefined}
        aria-label={`Open record R${n}`}
        title={`Read journal record R${n}`}
        onClick={onClick}
        className={cn(
          "inline-flex h-6 min-w-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border px-1.5 font-mono text-xs tabular-nums transition-colors",
          failed && !checked ? "border-warning/45 bg-warning/12 text-warning-fg hover:bg-warning/20" : "border-info/45 bg-info/8 text-info-fg underline decoration-info/50 underline-offset-2 hover:bg-info/15",
          pressed && (!failed || checked) && "border-primary bg-primary text-primary-foreground no-underline hover:bg-primary",
          pressed && failed && !checked && "ring-2 ring-warning",
        )}
      >
        {failed && !checked ? <TriangleAlert className="size-3" aria-hidden /> : null}
        {checked ? <CircleCheck className="size-3" aria-hidden /> : null}R{n}
      </button>
      {reason ? (
        <span id={id} className="min-w-0 pt-0.5 text-xs text-muted-foreground">
          {reason}
        </span>
      ) : null}
    </span>
  );
}

export function FieldValue({ field, primary }: { field: CardField; primary: string | null }) {
  const v = field.value;
  if (Array.isArray(v) && field.choices) {
    const items = v.filter((x): x is string => typeof x === "string" && x !== primary);
    if (!items.length) return <span className="text-muted-foreground">None</span>;
    return (
      <span className="flex flex-wrap gap-1">
        {items.map((x) => (
          <span key={x} className="rounded-md bg-muted px-1.5 py-0.5 text-xs">
            {field.choices!.find((c) => c.value === x)?.label ?? x}
          </span>
        ))}
      </span>
    );
  }
  if (v === null || v === undefined || v === "") return <span className="text-muted-foreground">None</span>;
  if (Array.isArray(v) || typeof v === "object") return null;
  return <span className="whitespace-pre-wrap">{field.choices || (typeof v === "string" && field.valueLabel && field.valueLabel !== v) ? field.valueLabel : String(v)}</span>;
}

