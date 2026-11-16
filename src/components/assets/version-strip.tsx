"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import type { ChangeSource } from "@/lib/assets/types";
import { cn } from "@/lib/utils";

/** Fill at 22%, a 1 px border in the source color; selected: full color and a 2 px ring. Literal classes so Tailwind finds them. */
const TICK: Record<ChangeSource, { idle: string; on: string; swatch: string }> = {
  agent: { idle: "bg-src-agent/22 border-src-agent", on: "bg-src-agent border-src-agent", swatch: "bg-src-agent" },
  console: { idle: "bg-src-console/22 border-src-console", on: "bg-src-console border-src-console", swatch: "bg-src-console" },
  cli: { idle: "bg-src-cli/22 border-src-cli", on: "bg-src-cli border-src-cli", swatch: "bg-src-cli" },
  app: { idle: "bg-src-app/22 border-src-app", on: "bg-src-app border-src-app", swatch: "bg-src-app" },
  unknown: { idle: "bg-src-unknown/22 border-src-unknown", on: "bg-src-unknown border-src-unknown", swatch: "bg-src-unknown" },
};

export interface StripVersion {
  version: number;
  source: ChangeSource;
  /** Short source label, for the button's name */
  sourceLabel: string;
  /** Shown under the strip */
  labeled: boolean;
}

/**
 * The version strip (pages/asset-detail.md): one button per version in its
 * source color. Picking two versions sets `from` and `to` in the URL; a
 * third pick starts a new pair.
 */
export function VersionStrip({
  versions,
  from,
  to,
  legend,
  firstDate,
  lastDate,
}: {
  versions: StripVersion[];
  from: number | null;
  to: number | null;
  legend: { source: ChangeSource; label: string }[];
  firstDate: string;
  lastDate: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, start] = useTransition();
  const [pending, setPending] = useState<number | null>(null);
  const selected = pending !== null ? [pending] : [from, to].filter((v): v is number => v !== null);

  const pick = (v: number) => {
    if (pending === null) {
      setPending(v);
      return;
    }
    if (pending === v) {
      setPending(null);
      return;
    }
    const next = new URLSearchParams(params.toString());
    next.set("tab", "versions");
    next.set("from", String(Math.min(pending, v)));
    next.set("to", String(Math.max(pending, v)));
    setPending(null);
    start(() => router.push(`${pathname}?${next.toString()}`, { scroll: false }));
  };

  const cols = { gridTemplateColumns: `repeat(${versions.length}, minmax(24px, 1fr))` };
  const first = versions[0]?.version ?? 1;
  const last = versions.at(-1)?.version ?? first;

  return (
    <div className="flex flex-col gap-2 px-4 pt-3.5 pb-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Pick two versions</h2>
          <p className="text-xs text-muted-foreground">Click two versions to compare them.</p>
        </div>
        <ul className="flex flex-wrap gap-3.5 text-xs text-muted-foreground" aria-label="Sources">
          {legend.map((l) => (
            <li key={l.source} className="inline-flex items-center gap-1.5">
              <span className={cn("size-2.5 rounded-[3px]", TICK[l.source].swatch)} aria-hidden />
              {l.label}
            </li>
          ))}
        </ul>
      </div>
      <div className="overflow-x-auto pt-1 pb-1">
        <div className="grid gap-1 px-1" style={cols} role="group" aria-label={`Versions ${first} to ${last}`}>
          {versions.map((v) => {
            const on = selected.includes(v.version);
            return (
              <button
                key={v.version}
                type="button"
                aria-label={`Version ${v.version}, ${v.sourceLabel}`}
                aria-pressed={on}
                onClick={() => pick(v.version)}
                className={cn(
                  "h-[26px] min-w-6 rounded-md border transition-colors",
                  on ? cn(TICK[v.source].on, "ring-2 ring-foreground ring-offset-2 ring-offset-card") : TICK[v.source].idle,
                )}
              />
            );
          })}
        </div>
        <div className="mt-1.5 grid gap-1 px-1 font-mono text-xs text-muted-foreground tabular-nums" style={cols} aria-hidden>
          {versions.map((v) => (
            <span key={v.version} className="text-center">
              {v.labeled || selected.includes(v.version) ? v.version : ""}
            </span>
          ))}
        </div>
      </div>
      <div className="flex justify-between gap-3 text-xs text-muted-foreground tabular-nums">
        <span>{firstDate}</span>
        <span aria-live="polite" className="text-center text-foreground">
          {pending !== null ? `Version ${pending} picked. Pick a second version to compare.` : ""}
        </span>
        <span>{lastDate}</span>
      </div>
    </div>
  );
}
