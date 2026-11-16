"use client";

import { Play } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition, type ReactNode } from "react";
import { Callout } from "@/components/common/callout";
import { Checkbox } from "@/components/common/checkbox";
import { DisabledReason } from "@/components/common/disabled-reason";
import { JobProgress } from "@/components/job-progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runAnalyzersAction } from "./actions";
import { fmtMetric, type AnalysisRow } from "./rows";

export interface AnalyzerOption {
  id: string;
  label: string;
  description: string;
  /** Needs a package; cannot run from this page yet */
  needsPackage: boolean;
}

/** An analysis row plus its rendered "Analyzed" time (a server component passed down). */
export type InvestigationRowView = AnalysisRow & { analyzedAt: ReactNode };

const TH = "h-auto bg-muted px-3 py-2 text-xs font-medium text-muted-foreground";
// Metric headers wrap onto two lines so all eleven columns fit at 1440 px.
const TH_NUM = `${TH} min-w-16 max-w-24 text-right leading-tight whitespace-normal`;
const TD = "px-3 py-2 align-top text-[13px] whitespace-normal";
const TD_NUM = `${TD} text-right tabular-nums`;

function AnalyzerChoice({ options, selected, onChange }: { options: AnalyzerOption[]; selected: Set<string>; onChange: (s: Set<string>) => void }) {
  return (
    <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <legend className="sr-only">Analyzers to run</legend>
      {options.map((o) => {
        const id = `analyzer-${o.id}`;
        return (
          <span key={o.id} className="flex items-center gap-1.5 text-[13px]">
            <Checkbox
              id={id}
              checked={selected.has(o.id)}
              disabled={o.needsPackage}
              aria-describedby={o.needsPackage ? `${id}-why` : undefined}
              onCheckedChange={(c) => {
                const next = new Set(selected);
                if (c === true) next.add(o.id);
                else next.delete(o.id);
                onChange(next);
              }}
            />
            <label htmlFor={id} className={o.needsPackage ? "text-muted-foreground" : undefined}>
              {o.label}
            </label>
            {o.needsPackage ? (
              <span id={`${id}-why`} className="text-xs text-muted-foreground">
                (needs an instruction package)
              </span>
            ) : null}
          </span>
        );
      })}
    </fieldset>
  );
}

/** "Run analyzers" for a fixed set of investigations, with job progress. */
export function RunAnalyzersButton({ alias, taskIds, analyzers, label = "Run analyzers" }: { alias: string; taskIds: string[]; analyzers: string[]; label?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onDone = useCallback(() => router.refresh(), [router]);

  const start = () => {
    setError(null);
    startTransition(async () => {
      const res = await runAnalyzersAction({ alias, taskIds, analyzers });
      if (res.ok) setRunId(res.runId);
      else setError(res.error);
    });
  };

  const button = (
    <Button size="sm" onClick={start} disabled={pending}>
      <Play aria-hidden />
      {pending ? "Starting…" : label}
    </Button>
  );
  const blocked = taskIds.length === 0 ? "Select investigations first." : analyzers.length === 0 ? "Choose at least one analyzer." : null;

  return (
    <div className="space-y-2">
      {blocked ? <DisabledReason reason={blocked}>{button}</DisabledReason> : button}
      {error ? (
        <Callout tone="destructive" title="The analyzers didn't start" afterAction>
          {error}
        </Callout>
      ) : null}
      {runId ? (
        <div className="max-w-md">
          <JobProgress key={runId} runId={runId} onDone={onDone} />
        </div>
      ) : null}
    </div>
  );
}

/** Analyzer picker plus a run button for one investigation. */
export function RunForInvestigation({ alias, taskId, options }: { alias: string; taskId: string; options: AnalyzerOption[] }) {
  const [selected, setSelected] = useState(() => new Set(options.filter((o) => !o.needsPackage).map((o) => o.id)));
  return (
    <div className="space-y-3 px-4 py-3">
      <AnalyzerChoice options={options} selected={selected} onChange={setSelected} />
      <RunAnalyzersButton alias={alias} taskIds={[taskId]} analyzers={[...selected]} />
    </div>
  );
}

/** Investigations with their latest run metrics, selectable when the user can run analyzers. */
export function InvestigationsTable({ alias, rows, options, canRun }: { alias: string; rows: InvestigationRowView[]; options: AnalyzerOption[]; canRun: boolean }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [analyzers, setAnalyzers] = useState(() => new Set(options.filter((o) => !o.needsPackage).map((o) => o.id)));
  const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.taskId));
  const somePicked = !allPicked && rows.some((r) => picked.has(r.taskId));
  const toggle = (taskId: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(taskId);
    else next.delete(taskId);
    setPicked(next);
  };

  return (
    <>
      {canRun ? (
        <div className="space-y-2.5 border-b px-4 py-3">
          <p className="text-[13px] text-muted-foreground">
            <span className="font-medium text-foreground tabular-nums">
              {picked.size === 0 ? "No investigations selected." : `${picked.size} ${picked.size === 1 ? "investigation" : "investigations"} selected.`}
            </span>{" "}
            Select investigations in the table, choose analyzers and run them. Unchanged investigations are skipped.
          </p>
          <AnalyzerChoice options={options} selected={analyzers} onChange={setAnalyzers} />
          <RunAnalyzersButton
            alias={alias}
            taskIds={[...picked]}
            analyzers={[...analyzers]}
            label={picked.size > 1 ? `Run analyzers on ${picked.size} investigations` : picked.size === 1 ? "Run analyzers on 1 investigation" : "Run analyzers"}
          />
        </div>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            {canRun ? (
              <TableHead className={`${TH} w-10`}>
                <Checkbox
                  aria-label="Select all investigations on this page"
                  checked={allPicked ? true : somePicked ? "indeterminate" : false}
                  onCheckedChange={(c) => setPicked(c === true ? new Set(rows.map((r) => r.taskId)) : new Set())}
                />
              </TableHead>
            ) : null}
            <TableHead className={TH}>Investigation</TableHead>
            <TableHead className={TH}>Source</TableHead>
            <TableHead className={TH_NUM}>Records</TableHead>
            <TableHead className={TH_NUM}>Span (min)</TableHead>
            <TableHead className={TH_NUM}>First summary (min)</TableHead>
            <TableHead className={TH_NUM}>Lead tool calls</TableHead>
            <TableHead className={TH_NUM}>Subagents</TableHead>
            <TableHead className={TH_NUM}>Max context (%)</TableHead>
            <TableHead className={TH_NUM}>Auth error signals</TableHead>
            <TableHead className={TH_NUM}>Analyzed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.taskId} data-state={picked.has(r.taskId) ? "selected" : undefined}>
              {canRun ? (
                <TableCell className={`${TD} w-10`}>
                  <Checkbox aria-label={`Select ${r.name}`} checked={picked.has(r.taskId)} onCheckedChange={(c) => toggle(r.taskId, c === true)} />
                </TableCell>
              ) : null}
              <TableCell className={`${TD} max-w-[22rem]`}>
                <Link
                  className={`inline-flex min-h-6 items-center rounded-sm font-semibold underline-offset-4 hover:underline ${r.nameIsTaskId ? "font-mono text-xs" : ""}`}
                  href={r.href}
                >
                  {r.name}
                </Link>
                {r.title ? <div className="truncate text-xs text-muted-foreground">{r.title}</div> : null}
              </TableCell>
              <TableCell className={TD}>
                <Badge variant="outline" className="h-[22px] font-medium text-muted-foreground">
                  {r.source === "import" ? "Imported" : "Pulled"}
                </Badge>
              </TableCell>
              <TableCell className={TD_NUM}>{r.records}</TableCell>
              <TableCell className={TD_NUM}>{fmtMetric(r.spanMin)}</TableCell>
              <TableCell className={TD_NUM}>{fmtMetric(r.firstSummaryMin)}</TableCell>
              <TableCell className={TD_NUM}>{fmtMetric(r.leadToolCalls)}</TableCell>
              <TableCell className={TD_NUM}>{fmtMetric(r.subagents)}</TableCell>
              <TableCell className={TD_NUM}>{fmtMetric(r.maxContextPct)}</TableCell>
              <TableCell className={TD_NUM}>{fmtMetric(r.authErrorSignals)}</TableCell>
              <TableCell className={`${TD_NUM} whitespace-nowrap`}>{r.analyzed ? r.analyzedAt : <span className="text-muted-foreground">Not analyzed</span>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
