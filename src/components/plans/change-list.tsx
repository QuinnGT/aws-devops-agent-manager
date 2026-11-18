"use client";

import { ChevronDown, ChevronRight, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import type { StatusSpec } from "@/components/common/status-words";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Segmented } from "./segmented";
import { DiffCounts } from "./unified-diff";
import { COLLAPSED_GROUPS, validationSpec } from "./words";

/** One row of the changes list, built on the server from PlanItemView (plain data, so it crosses to the client). */
export interface ChangeRow {
  id: string;
  name: string;
  /** "Instructions · v8 → v9", "Memory in verity · new" */
  detail: string;
  /** "Skipped, live changed", "Set Inactive"; null when the group says it */
  note: string | null;
  validation: { status: "passed" | "warnings" | "failed" | null; errors: number; warnings: number };
  added: number;
  removed: number;
  /** While applying: Waiting, Writing, Done, Failed with its message */
  progress: { word: string; tone: "muted" | "info" | "success" | "warning" | "destructive"; message: string | null } | null;
}

export interface ChangeGroup {
  key: string;
  label: string;
  rows: ChangeRow[];
}

const TONE_TEXT: Record<StatusSpec["tone"] | "muted", string> = {
  success: "text-success-fg",
  warning: "text-warning-fg",
  destructive: "text-destructive-fg",
  info: "text-info-fg",
  neutral: "text-muted-foreground",
  muted: "text-muted-foreground",
};

type Filter = "all" | "errors" | "warnings";

/** Search shows from this many rows; a short plan doesn't need it. */
const SEARCH_FROM = 10;

/**
 * The changes list of plan review (plan-review.md "Changes list"): rows
 * grouped by change, each a link that selects the item (?item=), with its
 * validation and +N −M. Errors and Warnings filters and a name search narrow
 * it; Creates and No change start collapsed when another group is shown. The
 * list scrolls on its own and keeps the selected row in view.
 */
export function ChangeList({ groups, planHref, selectedId, top, className }: { groups: ChangeGroup[]; planHref: string; selectedId: string | null; /** Above the rows (the apply job's progress) */ top?: ReactNode; className?: string }) {
  const rows = groups.flatMap((g) => g.rows);
  const errors = rows.filter((r) => r.validation.errors > 0).length;
  const warnings = rows.filter((r) => r.validation.errors === 0 && r.validation.warnings > 0).length;
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const groupOf = (id: string | null) => groups.find((g) => g.rows.some((r) => r.id === id))?.key ?? null;
  const keys = groups.map((g) => g.key).join(" ");
  const startClosed = (seen: ReadonlySet<string>) => (groups.length > 1 ? groups.map((g) => g.key).filter((k) => !seen.has(k) && COLLAPSED_GROUPS.has(k) && k !== groupOf(selectedId)) : []);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set(startClosed(new Set())));
  // State adjusted during render, not in an effect: groups that appear later (after the check sorts the items) start
  // collapsed like the first ones, and Previous or Next opens the group of the row it selects.
  const [shown, setShown] = useState({ keys, selectedId });
  if (shown.keys !== keys || shown.selectedId !== selectedId) {
    const next = new Set(closed);
    if (shown.keys !== keys) for (const k of startClosed(new Set(shown.keys.split(" ")))) next.add(k);
    const g = groupOf(selectedId);
    if (g) next.delete(g);
    setShown({ keys, selectedId });
    setClosed(next);
  }
  useEffect(() => {
    if (selectedId) document.getElementById(`plan-change-${selectedId}`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const needle = q.trim().toLowerCase();
  const narrowed = filter !== "all" || needle !== "";
  const keep = (r: ChangeRow) =>
    (filter === "all" || (filter === "errors" ? r.validation.errors > 0 : r.validation.errors === 0 && r.validation.warnings > 0)) && (!needle || `${r.name} ${r.detail}`.toLowerCase().includes(needle));
  const visible = groups.map((g) => ({ ...g, rows: g.rows.filter(keep) })).filter((g) => g.rows.length > 0);
  const filters: { value: Filter; label: string }[] = [{ value: "all", label: "All" }];
  if (errors) filters.push({ value: "errors", label: `Errors ${errors}` });
  if (warnings) filters.push({ value: "warnings", label: `Warnings ${warnings}` });

  return (
    <Card className={cn("gap-0 overflow-hidden py-0", className)} role="region" aria-labelledby="plan-items-h">
      <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <h2 id="plan-items-h" className="text-sm font-semibold">
          Changes <span className="text-xs font-normal text-muted-foreground tabular-nums">{rows.length === 1 ? "1 asset" : `${rows.length} assets`}</span>
        </h2>
        {filters.length > 1 ? <Segmented label="Show" value={filter} onChange={setFilter} options={filters} /> : null}
      </div>
      {top ? <div className="shrink-0 border-b px-4 py-3">{top}</div> : null}
      {rows.length >= SEARCH_FROM ? (
        <div className="relative shrink-0 border-b px-3 py-2">
          <Search className="pointer-events-none absolute top-1/2 left-5.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or type" aria-label="Filter changes by name or type" className="h-8 pl-7 text-[13px] md:text-[13px]" />
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? <p className="px-4 py-3 text-[13px] text-muted-foreground">{rows.length ? "No changes match." : "This plan has no items."}</p> : null}
        {visible.map((g) => {
          const open = narrowed || !closed.has(g.key);
          const headed = groups.length > 1;
          return (
            <section key={g.key} aria-label={g.label}>
              {headed ? (
                <button
                  type="button"
                  aria-expanded={open}
                  disabled={narrowed}
                  onClick={() => setClosed(new Set(open ? [...closed, g.key] : [...closed].filter((k) => k !== g.key)))}
                  className="flex w-full items-center justify-between gap-2 border-b bg-muted/50 px-4 py-1.5 text-left text-xs font-semibold text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground"
                >
                  <span className="flex items-center gap-1">
                    {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                    {g.label}
                  </span>
                  <span className="tabular-nums">{g.rows.length}</span>
                </button>
              ) : null}
              {open ? (
                <ul>
                  {g.rows.map((r) => (
                    <li key={r.id}>
                      <ChangeRowLink row={r} href={`${planHref}?item=${r.id}`} selected={r.id === selectedId} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          );
        })}
      </div>
    </Card>
  );
}

function ChangeRowLink({ row: r, href, selected }: { row: ChangeRow; href: string; selected: boolean }) {
  const v = validationSpec(r.validation);
  const Icon = r.validation.status === null ? null : v.icon;
  const count = r.validation.status === "passed" ? 0 : r.validation.errors || r.validation.warnings;
  return (
    <Link
      id={`plan-change-${r.id}`}
      href={href}
      scroll={false}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 border-b px-4 py-2 text-[13px] outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        selected && "bg-foreground/5 shadow-[inset_3px_0_0_var(--foreground)] hover:bg-foreground/5",
      )}
    >
      <span className="font-semibold break-words">{r.name}</span>
      <span className={cn("flex items-center justify-end gap-1 text-xs tabular-nums", TONE_TEXT[v.tone])}>
        {Icon ? <Icon className="size-3.5" aria-hidden /> : null}
        {count ? <span aria-hidden>{count}</span> : null}
        <span className="sr-only">{r.validation.status === null ? "Not validated" : v.label}</span>
      </span>
      <span className="text-xs break-words text-muted-foreground">
        {r.detail}
        {r.note ? <span className="text-warning-fg"> · {r.note}</span> : null}
        {r.progress?.message ? <span className="block">{r.progress.message}</span> : null}
      </span>
      {r.progress ? (
        <span className={cn("text-xs font-medium", TONE_TEXT[r.progress.tone])}>{r.progress.word}</span>
      ) : r.added || r.removed ? (
        <DiffCounts added={r.added} removed={r.removed} className="justify-end" />
      ) : (
        <span />
      )}
    </Link>
  );
}
