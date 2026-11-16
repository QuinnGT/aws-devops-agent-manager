"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { DiffCounts } from "./diff-counts";

/**
 * Client toggles for server-rendered panels: the content card's Rendered or
 * Source view, and the compare bar's Content or Metadata and Unified or
 * Split (MASTER "Diffs"). The panels are rendered on the server and passed
 * in; the toggles only choose which one shows.
 */

interface Option<V extends string> {
  value: V;
  label: string;
}

/** A shadcn ToggleGroup styled as a segmented control. One value is always selected. */
export function Segmented<V extends string>({ label, value, options, onChange, className }: { label: string; value: V; options: readonly Option<V>[]; onChange: (v: V) => void; className?: string }) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      spacing={0}
      aria-label={label}
      value={value}
      onValueChange={(v) => {
        if (v) onChange(v as V);
      }}
      className={cn("bg-background", className)}
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          className="h-7 px-2.5 text-[13px] text-muted-foreground data-[state=on]:bg-foreground data-[state=on]:text-background aria-checked:bg-foreground aria-checked:text-background"
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** Content card: a header with `title` and the Rendered or Source toggle, then the chosen panel. */
export function ContentViews({ title, rendered, source }: { title: ReactNode; rendered: ReactNode; source: ReactNode }) {
  const [view, setView] = useState<"rendered" | "source">("rendered");
  return (
    <>
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
        {title}
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: "rendered", label: "Rendered" },
            { value: "source", label: "Source" },
          ]}
        />
      </div>
      {view === "rendered" ? rendered : source}
    </>
  );
}

const WIDE = "(min-width: 1024px)";

function subscribeWide(onChange: () => void) {
  const mql = window.matchMedia(WIDE);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** At least 1024 px wide, where Split is offered. The server and first client render assume narrow. */
export function useWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
}

/**
 * The compare bar's right side and the diff below it: Content or Metadata,
 * and Unified or Split (Split only at 1024 px and up; narrower screens show
 * Unified). `bar` is the left side (versions and sources).
 */
export function ComparePanel({
  bar,
  added,
  removed,
  initial,
  unified,
  split,
  metadata,
}: {
  bar: ReactNode;
  added: number;
  removed: number;
  /** Metadata when no file changed */
  initial: "content" | "metadata";
  unified: ReactNode;
  split: ReactNode;
  metadata: ReactNode;
}) {
  const [what, setWhat] = useState(initial);
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const wide = useWide();
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 border-y bg-muted px-4 py-2.5 text-[13px]">
        {bar}
        <span className="grow" />
        <DiffCounts added={added} removed={removed} />
        <Segmented
          label="Compare"
          value={what}
          onChange={setWhat}
          options={[
            { value: "content", label: "Content" },
            { value: "metadata", label: "Metadata" },
          ]}
        />
        {wide && what === "content" ? (
          <Segmented
            label="Layout"
            value={layout}
            onChange={setLayout}
            options={[
              { value: "unified", label: "Unified" },
              { value: "split", label: "Split" },
            ]}
          />
        ) : null}
      </div>
      {what === "metadata" ? metadata : wide && layout === "split" ? split : unified}
    </>
  );
}
