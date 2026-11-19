"use client";

import { ChevronLeft, ChevronRight, ExternalLink, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { buttonVariants, Button } from "@/components/ui/button";
import { formatTime, UTC_ZONE, type ViewerZone } from "@/components/common/time-format";
import { markQuotes } from "./record-marks";
import { plural } from "./words";

export interface RecordData {
  n: number;
  total: number;
  recordId: string;
  recordType: string;
  createdAt: string;
  text: string;
  href: string;
}

export type RecordState =
  | { status: "idle" }
  | { status: "loading"; n: number }
  | { status: "ok"; data: RecordData }
  | { status: "missing"; n: number; total: number }
  | { status: "error"; n: number; message: string };

/** "message" becomes "Message", "investigation_summary_md" becomes "Investigation summary md". */
function typeWords(t: string): string {
  const s = t.replace(/[_-]+/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : t;
}

/**
 * The journal record a citation opened (pages/audit-item.md, "Journal
 * record"): the record's text as plain text in mono, with each quoted span
 * marked, and the neighbouring records. Journal text is untrusted and is only
 * ever rendered as text.
 */
export function RecordCard({
  state,
  fieldLabel,
  quotes,
  failedReason,
  failedQuote = null,
  checkedNote = null,
  onOpen,
  headingId,
  zone = UTC_ZONE,
}: {
  /** The viewer's time zone from the server, so the server and the browser render the same time */
  zone?: ViewerZone;
  state: RecordState;
  fieldLabel: string | null;
  quotes: string[];
  failedReason: string | null;
  /** The text the review quoted that the check didn't find, shown so a reviewer can compare */
  failedQuote?: string | null;
  /** "Checked by <name>: <note>" when a reviewer has checked this record's failed citation */
  checkedNote?: string | null;
  onOpen: (n: number) => void;
  headingId: string;
}) {
  const n = state.status === "ok" ? state.data.n : state.status === "idle" ? null : state.n;
  const total = state.status === "ok" ? state.data.total : state.status === "missing" ? state.total : null;
  const parts = state.status === "ok" ? markQuotes(state.data.text, quotes) : [];
  const marked = parts.some((p) => p.mark);
  return (
    <section aria-labelledby={headingId} className="rounded-xl border bg-card">
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-2">
        <h2 id={headingId} className="text-sm font-semibold">
          {n ? `Journal record R${n}` : "Journal record"}
        </h2>
        {state.status === "ok" ? (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>
              {typeWords(state.data.recordType)} · <time dateTime={state.data.createdAt}>{formatTime(state.data.createdAt, "datetime", zone)}</time>
            </span>
            <Link href={state.data.href} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Open in journal
              <ExternalLink aria-hidden />
            </Link>
          </div>
        ) : null}
      </div>
      <div className="px-4 py-3" aria-live="polite">
        {state.status === "idle" ? <p className="text-[13px] text-muted-foreground">Choose a citation to read its record here.</p> : null}
        {state.status === "loading" ? <p className="text-[13px] text-muted-foreground">Loading R{state.n}</p> : null}
        {state.status === "error" ? (
          <p role="alert" className="text-[13px] text-destructive-fg">
            {state.message}
          </p>
        ) : null}
        {state.status === "missing" ? (
          <p className="flex items-start gap-2 text-[13px]">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-fg" aria-hidden />R{state.n} isn&apos;t in this journal ({plural(state.total, "record")}), so it can&apos;t be shown. Check the finding against the other citations, or edit it.
          </p>
        ) : null}
        {state.status === "ok" ? (
          <>
            {failedReason ? (
              <div className="mb-2 space-y-1 text-[13px]">
                <p className="flex items-start gap-2 text-warning-fg">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {failedReason}. The record is shown without highlights.
                </p>
                {failedQuote ? (
                  <p className="pl-6 text-xs">
                    <span className="text-muted-foreground">The review quoted: </span>
                    <q className="font-mono [overflow-wrap:anywhere]">{failedQuote}</q>
                  </p>
                ) : null}
                {checkedNote ? <p className="pl-6 text-xs text-muted-foreground">{checkedNote}</p> : null}
              </div>
            ) : null}
            <pre className="max-h-[28rem] overflow-y-auto font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
              {parts.map((p, i) =>
                p.mark ? (
                  <mark key={i} className="rounded-[2px] bg-info/12 text-foreground underline decoration-info underline-offset-2">
                    {p.text}
                  </mark>
                ) : (
                  <span key={i}>{p.text}</span>
                ),
              )}
            </pre>
          </>
        ) : null}
      </div>
      {n ? (
        <div className="space-y-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
          <p>
            {fieldLabel ? `Opened from the ${fieldLabel.toLowerCase()} citation. ` : ""}
            {marked ? "Quoted text is highlighted. " : ""}Journal text is shown as plain text.
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={n <= 1} onClick={() => onOpen(n - 1)} className={cn(n <= 1 && "invisible")}>
              <ChevronLeft aria-hidden />R{n - 1}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={total !== null && n >= total} onClick={() => onOpen(n + 1)}>
              R{n + 1}
              <ChevronRight aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
