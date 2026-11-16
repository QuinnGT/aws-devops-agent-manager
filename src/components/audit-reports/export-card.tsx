"use client";

import { CircleX, Download, Loader, ShieldCheck, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/common/callout";
import { SectionCard } from "@/components/common/section-card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { Audience, ExportViolation } from "@/server/audit-reports";
import { useReport } from "./report-context";
import { AUDIENCE_LABELS, AUDIENCE_ORDER, goToSection, ruleErrorsText, sectionAnchor, unapprovedExportBody, unapprovedTitle, violationRows, warningsText, whereText } from "./words";

export interface LastExport {
  refused: boolean;
  /** Output-rule errors that refused it */
  errors: number;
  /** <Time> of the attempt, rendered on the server */
  when: ReactNode;
  actor: string;
  failed: boolean;
  /** The file it produced, for a successful export */
  fileName: string | null;
}

/** A narrative section the export dialog names and links to. */
export interface SectionRef {
  id: string;
  title: string;
}

type Body =
  | { ok: true; fileName: string; html: string; warnings: ExportViolation[] }
  | { ok: false; violations: ExportViolation[]; warnings: ExportViolation[] }
  | { check: true; ok: boolean; violations: ExportViolation[]; warnings: ExportViolation[] };

type DialogState =
  | { mode: "checking" }
  | { mode: "unapproved"; sections: SectionRef[] }
  | { mode: "refused"; violations: ExportViolation[]; warnings: ExportViolation[]; checkOnly: boolean }
  | { mode: "passed-check"; warnings: ExportViolation[] }
  | { mode: "warned"; fileName: string; warnings: ExportViolation[] }
  | { mode: "error"; message: string };

function download(fileName: string, html: string) {
  // The file is saved, never opened in this app's origin.
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function callExport(alias: string, auditId: string, audience: Audience, checkOnly: boolean): Promise<Body | { error: string }> {
  const url = `/api/spaces/${encodeURIComponent(alias)}/audits/${encodeURIComponent(auditId)}/report/export?audience=${audience}${checkOnly ? "&check=1" : ""}`;
  const res = await fetch(url, { cache: "no-store" }).catch(() => null);
  if (!res) return { error: "The app didn't answer. Check your connection and try again." };
  const body = (await res.json().catch(() => null)) as (Body & { error?: string }) | null;
  if (!body) return { error: "The export didn't return a result. Try again." };
  if (body.error) return { error: body.error };
  return checkOnly ? { ...(body as { ok: boolean; violations: ExportViolation[]; warnings: ExportViolation[] }), check: true } : body;
}

function ViolationTable({ rows, onWhere }: { rows: ExportViolation[]; onWhere: (anchor: string) => void }) {
  return (
    <div className="max-h-[50vh] overflow-y-auto rounded-lg border">
      <Table>
        <TableHeader className="sticky top-0 bg-muted">
          <TableRow>
            <TableHead className="px-3 text-xs">Rule</TableHead>
            <TableHead className="px-3 text-xs">Where</TableHead>
            <TableHead className="px-3 text-xs">Found</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((v, i) => (
            <TableRow key={`${v.ruleId}:${v.sectionId}:${v.location}:${i}`} className="align-top">
              <TableCell className="w-[30%] px-3 py-2 whitespace-normal">
                {v.severity === "error" ? (
                  <span className="inline-flex items-center gap-1 text-destructive-fg">
                    <CircleX className="size-4" aria-hidden />
                    Error
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-warning-fg">
                    <TriangleAlert className="size-4" aria-hidden />
                    Warning
                  </span>
                )}
                <div>{v.description}</div>
                <details className="text-xs text-muted-foreground">
                  <summary className="inline-flex min-h-6 cursor-pointer items-center rounded-sm hover:text-foreground">Details</summary>
                  <p>
                    Rule ID <span className="font-mono">{v.ruleId}</span>
                  </p>
                </details>
              </TableCell>
              <TableCell className="w-[25%] px-3 py-2 whitespace-normal">
                {v.sectionId ? (
                  <a
                    href={`#${sectionAnchor(v.sectionId)}`}
                    className="inline-flex min-h-6 items-center underline underline-offset-4"
                    onClick={(e) => {
                      e.preventDefault();
                      onWhere(sectionAnchor(v.sectionId!));
                    }}
                  >
                    {whereText(v)}
                  </a>
                ) : (
                  <span>{whereText(v)}</span>
                )}
                {v.incident ? <div className="font-mono text-xs text-muted-foreground">{v.incident}</div> : null}
              </TableCell>
              <TableCell className="px-3 py-2 font-mono text-xs whitespace-normal [overflow-wrap:anywhere]">{v.excerpt}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * The "Export HTML" side card and its dialog (pages/audit-report.md): the
 * audience choice, "Check and export HTML", the last result, and the output
 * rules' findings when an export is refused. Viewers can export (audits.read).
 */
export function ExportCard({
  help,
  sections,
  last,
  lastOk,
  unapproved,
  excerptChars,
}: {
  /** Help text per audience ("6 sections. Leaves out Run metrics, which is internal.") */
  help: Record<Audience, string>;
  /** Sections each export includes */
  sections: Record<Audience, number>;
  /** The latest attempt per audience */
  last: Record<Audience, LastExport | null>;
  /** The latest export per audience that produced a file, for "Download again" */
  lastOk: Record<Audience, LastExport | null>;
  /** Narrative sections each export includes whose model text nobody approved; the dialog warns before a shareable export */
  unapproved: Record<Audience, SectionRef[]>;
  excerptChars: number;
}) {
  const { alias, auditId } = useReport();
  const router = useRouter();
  const [audience, setAudience] = useState<Audience>("shareable");
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DialogState>({ mode: "checking" });
  const [slow, setSlow] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const target = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The person saw the unapproved-text warning in this dialog and chose to export */
  const confirmed = useRef(false);
  const groupId = useId();
  const helpId = useId();

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const warnFirst = audience === "shareable" ? unapproved.shareable : [];

  const run = async (checkOnly: boolean) => {
    if (!checkOnly && warnFirst.length && !confirmed.current) return setState({ mode: "unapproved", sections: warnFirst });
    setState({ mode: "checking" });
    setSlow(false);
    if (timer.current) clearTimeout(timer.current);
    // Work that usually finishes in under 300 ms shows nothing.
    timer.current = setTimeout(() => setSlow(true), 300);
    const r = await callExport(alias, auditId, audience, checkOnly);
    if (timer.current) clearTimeout(timer.current);
    if ("error" in r) return setState({ mode: "error", message: r.error });
    if ("check" in r) {
      setState(r.ok ? { mode: "passed-check", warnings: r.warnings } : { mode: "refused", violations: r.violations, warnings: r.warnings, checkOnly: true });
      return;
    }
    router.refresh();
    if (!r.ok) return setState({ mode: "refused", violations: r.violations, warnings: r.warnings, checkOnly: false });
    download(r.fileName, r.html);
    if (r.warnings.length) return setState({ mode: "warned", fileName: r.fileName, warnings: r.warnings });
    setOpen(false);
    toast.success(`Exported ${r.fileName}`);
  };

  const openWith = (checkOnly: boolean) => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    target.current = null;
    confirmed.current = false;
    setOpen(true);
    void run(checkOnly);
  };

  const exportAnyway = () => {
    confirmed.current = true;
    void run(false);
  };

  const onWhere = (anchor: string) => {
    target.current = anchor;
    setOpen(false);
  };

  const l = last[audience];
  const ok = lastOk[audience];
  const label = AUDIENCE_LABELS[audience];
  const downloadAgain = (
    <Button variant="outline" size="sm" onClick={() => openWith(false)}>
      <Download aria-hidden />
      Download again
    </Button>
  );

  return (
    <SectionCard id="report-export-title" title="Export HTML">
      <div className="space-y-3 px-4 py-4 text-[13px]">
        <fieldset className="space-y-2" aria-describedby={helpId}>
          <legend id={groupId} className="mb-2 font-medium">
            Audience
          </legend>
          {AUDIENCE_ORDER.map((a) => (
              <label
                key={a}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5",
                  "has-[:checked]:border-foreground has-[:checked]:ring-1 has-[:checked]:ring-foreground",
                  "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                )}
              >
                <input type="radio" name={`${groupId}-audience`} value={a} checked={audience === a} onChange={() => setAudience(a)} className="mt-0.5 size-4 shrink-0 accent-primary" />
                <span>
                  <span className="block font-semibold">{AUDIENCE_LABELS[a]}</span>
                  <span className="block text-xs text-muted-foreground">{help[a]}</span>
                </span>
              </label>
            ))}
          <p id={helpId} className="text-xs text-muted-foreground">
            Hidden sections are left out of both.
          </p>
        </fieldset>
        <Button variant="outline" className="w-full" onClick={() => openWith(false)}>
          <Download aria-hidden />
          Check and export HTML
        </Button>
        <p className="text-xs text-muted-foreground">One file with inline styles and data, and no external requests. It must pass the output rules first.</p>
        {l ? (
          l.refused ? (
            <div className="flex items-start gap-2 text-[13px]">
              <CircleX className="mt-0.5 size-4 shrink-0 text-destructive-fg" aria-hidden />
              <div>
                Last {label.toLowerCase()} export refused {l.when}: {ruleErrorsText(l.errors)}.
                <br />
                <button type="button" className="inline-flex min-h-6 items-center underline underline-offset-4" onClick={() => openWith(true)}>
                  See what was found
                </button>
              </div>
            </div>
          ) : l.failed ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Last {label.toLowerCase()} export didn&apos;t finish {l.when}.{" "}
                {ok?.fileName ? (
                  <>
                    The one before made <span className="font-mono [overflow-wrap:anywhere]">{ok.fileName}</span> {ok.when}.
                  </>
                ) : (
                  "Try again."
                )}
              </p>
              {ok ? downloadAgain : null}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Last exported {l.when} by {l.actor} for the {label.toLowerCase()} audience
                {l.fileName ? (
                  <>
                    : <span className="font-mono [overflow-wrap:anywhere]">{l.fileName}</span>
                  </>
                ) : null}
                .
              </p>
              {downloadAgain}
              <p className="text-xs text-muted-foreground">Exports again with the report as it is now, checked against the output rules first.</p>
            </div>
          )
        ) : null}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="sm:max-w-3xl"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const anchor = target.current;
            const el = anchor ? document.getElementById(anchor) : null;
            if (el) {
              el.scrollIntoView({ block: "start" });
              el.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
            } else if (trigger.current?.isConnected) trigger.current.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Export HTML</DialogTitle>
            <DialogDescription>
              {label} audience, {sections[audience]} {sections[audience] === 1 ? "section" : "sections"}. The export is checked against the output rules before the file is built.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3" aria-live="polite">
            {state.mode === "checking" ? (
              slow ? (
                <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader className="size-4 motion-safe:animate-spin" aria-hidden />
                  Checking the report against the output rules
                </p>
              ) : null
            ) : null}
            {state.mode === "error" ? (
              <Callout tone="destructive" title="The export didn't run" afterAction>
                {state.message}
              </Callout>
            ) : null}
            {state.mode === "unapproved" ? (
              <Callout tone="warning" afterAction title={unapprovedTitle(state.sections.map((s) => s.title))}>
                <p>{unapprovedExportBody(state.sections.length)}</p>
                <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                  {state.sections.map((s) => (
                    <li key={s.id}>
                      <a
                        href={`#${sectionAnchor(s.id)}`}
                        className="inline-flex min-h-6 items-center underline underline-offset-4"
                        onClick={(e) => {
                          e.preventDefault();
                          onWhere(sectionAnchor(s.id));
                        }}
                      >
                        {goToSection(s.title)}
                      </a>
                    </li>
                  ))}
                </ul>
              </Callout>
            ) : null}
            {state.mode === "refused" ? (
              <>
                <Callout tone="destructive" afterAction title={`${state.checkOnly ? "The export is refused" : "Export refused"}: ${ruleErrorsText(state.violations.length)}`}>
                  Fix these in the report or the finding, then check again. Warnings don&apos;t block an export.
                </Callout>
                <ViolationTable rows={violationRows(state.violations, state.warnings)} onWhere={onWhere} />
              </>
            ) : null}
            {state.mode === "warned" ? (
              <>
                <Callout tone="success" afterAction title={`Exported with ${warningsText(state.warnings.length)}`}>
                  {state.fileName} is downloading. Warnings don&apos;t block an export, but check them before you share the file.
                </Callout>
                <ViolationTable rows={state.warnings} onWhere={onWhere} />
              </>
            ) : null}
            {state.mode === "passed-check" ? (
              <>
                <Callout tone="success" afterAction title="The export passes the output rules now">
                  {state.warnings.length ? `${warningsText(state.warnings.length)} remain. ` : ""}Check again to build and download the file.
                </Callout>
                {state.warnings.length ? <ViolationTable rows={state.warnings} onWhere={onWhere} /> : null}
              </>
            ) : null}
            {state.mode === "refused" || state.mode === "warned" || state.mode === "passed-check" ? (
              <p className="text-xs text-muted-foreground">Account IDs are masked here too. Each excerpt shows up to {excerptChars} characters on each side of the match.</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
            {state.mode === "unapproved" ? (
              <Button size="sm" onClick={exportAnyway}>
                <Download aria-hidden />
                Export anyway
              </Button>
            ) : state.mode !== "warned" ? (
              <Button size="sm" onClick={() => void run(false)} disabled={state.mode === "checking"}>
                <ShieldCheck aria-hidden />
                Check again
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
