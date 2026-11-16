"use client";

import { CircleCheck, CircleX, Download, Info, ListPlus } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { pickableInvestigationsAction, previewSelectionAction } from "@/app/(app)/spaces/[alias]/audits/actions";
import { Checkbox } from "@/components/common/checkbox";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { SelectionPreview } from "@/server/audits/ui";
import { Segmented } from "@/components/plans/segmented";
import { parseIncidentIds, plural } from "./words";

export type PickMode = "incidents" | "range" | "tasks";

export type ClientSelection =
  | { by: "incidents"; incidentIds: string[] }
  | { by: "range"; from: string; to: string; statuses?: string[] }
  | { by: "tasks"; taskIds: string[] };

export interface PickerState {
  /** What to save: IDs without a cached journal left out. Null when nothing is chosen. */
  selection: ClientSelection | null;
  preview: SelectionPreview | null;
  loading: boolean;
}

const MODES: { value: PickMode; label: string }[] = [
  { value: "incidents", label: "Incident IDs" },
  { value: "range", label: "Date range" },
  { value: "tasks", label: "Pick from journals" },
];

/** Local date (YYYY-MM-DD) at local midnight, as an instant; `plusDay` for an inclusive end. */
function localDay(d: string, plusDay = false): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  const t = new Date(y, m - 1, day + (plusDay ? 1 : 0));
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function zoneName(): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "local";
  } catch {
    return "local";
  }
}

/**
 * The Investigations card body of New audit (pages/audit-new.md): incident
 * IDs, a date range with status, or investigations picked from the journal
 * cache. Every change is previewed on the server (found, no cached journal,
 * several executions) and reported through `onChange`.
 */
export function InvestigationPicker({
  alias,
  incidentIdTemplate,
  docKinds,
  statuses,
  canExportJournals,
  onChange,
  idPrefix,
  title = "Investigations",
}: {
  alias: string;
  incidentIdTemplate: string;
  docKinds: string[];
  statuses: string[];
  canExportJournals: boolean;
  onChange: (s: PickerState) => void;
  idPrefix: string;
  title?: string;
}) {
  const [mode, setMode] = useState<PickMode>("incidents");
  const [ids, setIds] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [result, setResult] = useState<{ key: string; preview: SelectionPreview | null; error: string | null } | null>(null);
  const seq = useRef(0);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const kindsKey = docKinds.join(",");

  const request = useMemo((): ClientSelection | null => {
    if (mode === "incidents") {
      const list = parseIncidentIds(ids, incidentIdTemplate);
      return list.length ? { by: "incidents", incidentIds: list.slice(0, 5000) } : null;
    }
    if (mode === "range") {
      const f = localDay(from);
      const t = localDay(to, true);
      return f && t && f < t ? { by: "range", from: f, to: t, ...(status ? { statuses: [status] } : {}) } : null;
    }
    return picked.length ? { by: "tasks", taskIds: picked } : null;
  }, [mode, ids, incidentIdTemplate, from, to, status, picked]);
  const requestKey = request ? `${JSON.stringify(request)}|${kindsKey}` : "";
  const rangeError = mode === "range" && from && to && !request ? "The range must end on or after the day it starts." : null;
  const current = request && result?.key === requestKey ? result : null;
  const preview = current?.preview ?? null;
  const error = current?.error ?? null;
  const loading = !!request && !current;

  useEffect(() => {
    if (!request) return;
    const n = ++seq.current;
    const t = setTimeout(async () => {
      const r = await previewSelectionAction(alias, request, kindsKey ? kindsKey.split(",") : []);
      if (n !== seq.current) return;
      setResult(r.ok ? { key: requestKey, preview: r.preview, error: null } : { key: requestKey, preview: null, error: r.message });
    }, 400);
    return () => clearTimeout(t);
  }, [alias, request, requestKey, kindsKey]);

  useEffect(() => {
    let selection: ClientSelection | null = null;
    if (request && preview && preview.found.length && !preview.overLimit) {
      selection =
        request.by === "incidents"
          ? { by: "incidents", incidentIds: request.incidentIds.filter((i) => !preview.missing.includes(i)) }
          : request.by === "tasks"
            ? { by: "tasks", taskIds: request.taskIds.filter((i) => !preview.missing.includes(i)) }
            : request;
    }
    onChangeRef.current({ selection, preview: request ? preview : null, loading });
  }, [request, preview, loading]);

  const help = `${idPrefix}-ids-help`;
  const example = incidentIdTemplate.includes("{id}") ? ` The space's incident ID rule turns 20101 into ${incidentIdTemplate.replaceAll("{id}", "20101")}.` : "";

  return (
    <div>
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
        <h2 id={`${idPrefix}-h`} className="text-sm font-semibold">
          {title}
        </h2>
        <Segmented label="How to choose investigations" value={mode} onChange={setMode} options={MODES} />
      </div>
      <div className="space-y-2 px-4 py-3">
        {mode === "incidents" ? (
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-ids`}>Incident IDs</Label>
            <Textarea id={`${idPrefix}-ids`} value={ids} onChange={(e) => setIds(e.target.value)} rows={3} aria-describedby={help} className="font-mono text-[13px]" spellCheck={false} />
            <p id={help} className="text-xs text-muted-foreground">
              Numbers or full IDs, separated by spaces, commas or new lines.{example}
            </p>
          </div>
        ) : mode === "range" ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-from`}>From</Label>
              <Input id={`${idPrefix}-from`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-to`}>To</Label>
              <Input id={`${idPrefix}-to`} type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-invalid={rangeError ? true : undefined} aria-describedby={rangeError ? `${idPrefix}-to-err` : undefined} />
              {rangeError ? (
                <p id={`${idPrefix}-to-err`} role="alert" className="text-xs text-destructive-fg">
                  {rangeError}
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-status`}>Status</Label>
              <select
                id={`${idPrefix}-status`}
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
              >
                <option value="">Any status</option>
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          <PickJournals alias={alias} statuses={statuses} picked={picked} onPick={setPicked} />
        )}
      </div>
      <PreviewRows
        alias={alias}
        preview={preview}
        error={error}
        loading={loading}
        mode={mode}
        zone={mode === "range" ? zoneName() : null}
        canExportJournals={canExportJournals}
      />
    </div>
  );
}

function PreviewRows({
  alias,
  preview,
  error,
  loading,
  mode,
  zone,
  canExportJournals,
}: {
  alias: string;
  preview: SelectionPreview | null;
  error: string | null;
  loading: boolean;
  mode: PickMode;
  zone: string | null;
  canExportJournals: boolean;
}) {
  if (error)
    return (
      <p role="alert" className="flex items-start gap-2 border-t px-4 py-2.5 text-[13px]">
        <CircleX className="mt-0.5 size-4 shrink-0 text-destructive-fg" aria-hidden />
        {error}
      </p>
    );
  if (!preview) return loading ? <p className="border-t px-4 py-2.5 text-[13px] text-muted-foreground">Looking up the investigations</p> : null;
  const n = preview.found.length;
  const exportHref = `/spaces/${encodeURIComponent(alias)}/journals/exports`;
  return (
    <div className="divide-y border-t text-[13px]" aria-live="polite">
      {preview.overLimit ? (
        <p role="alert" className="flex items-start gap-2 px-4 py-2.5">
          <CircleX className="mt-0.5 size-4 shrink-0 text-destructive-fg" aria-hidden />
          An audit holds at most {preview.maxItems} investigations. Narrow the range or split it.
        </p>
      ) : n ? (
        <p className="flex items-start gap-2 px-4 py-2.5">
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-success-fg" aria-hidden />
          <span>
            <strong className="font-semibold">
              {mode === "range" ? `${plural(n, "investigation")} ${n === 1 ? "matches" : "match"}` : mode === "tasks" ? `${plural(n, "investigation")} selected` : `${plural(n, "investigation")} found`}
            </strong>
            {mode === "range" ? `, all with cached journals.${zone ? ` Times are in your time zone (${zone}).` : ""}` : mode === "incidents" ? ` in the cached journals${preview.multiExecution ? "." : n === 1 ? ", with one execution." : ", each with one execution."}` : "."}
          </span>
        </p>
      ) : (
        <p className="flex items-start gap-2 px-4 py-2.5">
          <CircleX className="mt-0.5 size-4 shrink-0 text-destructive-fg" aria-hidden />
          {mode === "range" ? "No investigation in the journal cache matches the range and status." : "None of these has a cached journal."}
        </p>
      )}
      {preview.multiExecution ? (
        <p className="flex items-start gap-2 px-4 py-2.5 text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          {preview.multiExecution} {preview.multiExecution === 1 ? "has" : "have"} more than one execution; the latest finished one is used.
        </p>
      ) : null}
      {preview.missing.slice(0, 10).map((id) => (
        <div key={id} className="space-y-1.5 px-4 py-2.5">
          <p className="flex items-start gap-2">
            <CircleX className="mt-0.5 size-4 shrink-0 text-destructive-fg" aria-hidden />
            <span>
              {id} has no cached journal, so it is left out. Export its journal first, or remove it from the list.
            </span>
          </p>
          {canExportJournals ? (
            <Link href={exportHref} className={buttonVariants({ variant: "outline", size: "sm", className: "ml-6" })}>
              <Download aria-hidden />
              Export journals
            </Link>
          ) : null}
        </div>
      ))}
      {preview.missing.length > 10 ? <p className="px-4 py-2.5 text-muted-foreground">And {plural(preview.missing.length - 10, "more ID")} without a cached journal.</p> : null}
    </div>
  );
}

type Pickable = { taskId: string; incidentId: string | null; title: string | null; status: string | null; createdAt: string | null };

/** "Pick from journals": the cached investigations in a dialog, with checkboxes and a text and status filter. */
function PickJournals({ alias, statuses, picked, onPick }: { alias: string; statuses: string[]; picked: string[]; onPick: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<Pickable[]>([]);
  const [total, setTotal] = useState(0);
  const [sel, setSel] = useState<string[]>(picked);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    let live = true;
    const t = setTimeout(async () => {
      const r = await pickableInvestigationsAction(alias, { q, status });
      if (!live) return;
      if (r.ok) {
        setRows(r.rows);
        setTotal(r.total);
        setError(null);
      } else setError(r.message);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, alias, q, status]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) setSel(picked);
        }}
      >
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <ListPlus aria-hidden />
            {picked.length ? "Change the selection" : "Choose investigations"}
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Pick from journals</DialogTitle>
            <DialogDescription>Cached investigations, newest first. Titles come from the journals.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-2">
            <Input type="search" aria-label="Filter by incident or title" placeholder="Filter by incident or title" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 max-w-72" />
            <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30">
              <option value="">Any status</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
          {error ? (
            <p role="alert" className="text-[13px] text-destructive-fg">
              {error}
            </p>
          ) : null}
          <div className="max-h-[50vh] overflow-y-auto rounded-lg border">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
                <tr>
                  <th className="w-10 px-3 py-2">
                    <span className="sr-only">Selected</span>
                  </th>
                  <th className="px-2 py-2 font-medium">Investigation</th>
                  <th className="px-2 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => {
                  const cb = `${id}-${r.taskId}`;
                  return (
                    <tr key={r.taskId}>
                      <td className="px-3 py-1.5">
                        <Checkbox id={cb} checked={sel.includes(r.taskId)} onCheckedChange={(c) => setSel((s) => (c ? [...s, r.taskId] : s.filter((x) => x !== r.taskId)))} />
                      </td>
                      <td className="px-2 py-1.5">
                        <label htmlFor={cb} className="block cursor-pointer">
                          <span className="font-mono text-xs">{r.incidentId ?? r.taskId}</span>
                          {r.title ? <span className="block text-xs text-muted-foreground">{r.title}</span> : null}
                        </label>
                      </td>
                      <td className="px-2 py-1.5 text-xs text-muted-foreground">{r.status ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!rows.length ? <p className="px-3 py-3 text-[13px] text-muted-foreground">No cached investigation matches.</p> : null}
          </div>
          <DialogFooter className="items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">
              {plural(sel.length, "investigation")} selected{total > rows.length ? `. Showing ${rows.length} of ${total}; filter to find others.` : ""}
            </p>
            <Button
              size="sm"
              onClick={() => {
                onPick(sel);
                setOpen(false);
              }}
            >
              Use {plural(sel.length, "investigation")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {picked.length ? <span className="text-[13px] text-muted-foreground">{plural(picked.length, "investigation")} picked</span> : null}
    </div>
  );
}
