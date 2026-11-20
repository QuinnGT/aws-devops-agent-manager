"use client";

import { Check, CircleCheck, GitBranch, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { checkCitationAction, findingAction } from "@/app/(app)/spaces/[alias]/audits/actions";
import { StatusBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { NextStep } from "@/server/audits/next-step";
import { AddToRevisionDialog } from "./add-to-revision-dialog";
import type { RevisionChoice } from "./revision-choice";
import { AcceptIncidentButton } from "./finding-buttons";
import { CheckForm, DecisionButtons, EditForm, RejectForm } from "./finding-decision";
import { CitationChip, FieldValue } from "./finding-fields";
import { cardRows, evidenceRows, isCitationList, quotesFor, type CardField, type CitationRef } from "./finding-view";
import { NextStepPanel } from "./next-step-panel";
import { RecordCard, type RecordData, type RecordState } from "./record-card";
import { reveal } from "./reveal";
import { isTextTarget, moveFocus, SHORTCUT_KEYS, shortcutFor, type ShortcutAction } from "./shortcuts";
import type { ViewerZone } from "@/components/common/time-format";
import { useSingleKeys } from "./use-single-keys";
import { citationChipReason, citationResult, EDITED_BADGE, evidenceSummary, FINDING_STATE_BADGE, plural } from "./words";

/** One row of the list: a finding with its kind, owner or failure mode, state and title. */
export interface ListRow {
  id: string;
  /** The Findings tab's address with this finding selected */
  href: string;
  kindLabel: string;
  /** The owner of a fix, or the failure mode of a diagnosis */
  tag: string | null;
  state: "proposed" | "accepted" | "rejected";
  edited: boolean;
  /** The stored title, cut at 300 characters; the list shows two lines of it */
  title: string;
  /** A citation failed the check and nobody checked it */
  flagged: boolean;
}

export interface ListGroup {
  itemId: string;
  incident: string;
  /** The incident page */
  itemHref: string;
  /** Proposed findings of the incident and how many of them a failed citation keeps out of bulk accept */
  proposed: number;
  flagged: number;
  rows: ListRow[];
}

/** The selected finding, whole. */
export interface DetailData {
  id: string;
  itemId: string;
  incident: string;
  itemHref: string;
  /** "Fix 1 of 3" */
  position: string;
  /** Owner of a fix: "Owner: Customer memory or runbook content"; null for a finding with none */
  ownerLine: string | null;
  /** None of the text cut off */
  title: string;
  state: "proposed" | "accepted" | "rejected";
  edited: boolean;
  hidden: string[];
  fields: CardField[];
  citations: CitationRef[];
  totalRecords: number | null;
  reviewNote: string | null;
  decidedBy: string | null;
  canAct: boolean;
  canEdit: boolean;
  canCheck: boolean;
  next: NextStep;
}

export interface FindingsWorkspaceProps {
  /** The viewer's time zone, for times rendered in the browser */
  zone?: ViewerZone;
  alias: string;
  auditId: string;
  groups: ListGroup[];
  /** Every row of the list in order, for J and K */
  order: { id: string; href: string; proposed: boolean }[];
  selectedId: string | null;
  /** Where to pin the selection when the address has none, so a decision doesn't move it to another finding */
  pinHref: string | null;
  detail: DetailData | null;
  /** The selected finding is shown although the filters leave it out */
  hiddenByFilters: boolean;
  /** "Add the 2 accepted package fixes to a revision…": null without revisions.build or when there are none */
  bulkRevision: { id: string; title: string }[] | null;
  revisions: { options: RevisionChoice[]; nameRule: { pattern: string; hint: string; maxLength: number } };
  /** Shown at the bottom of the list */
  footer: ReactNode;
  /** The list, filtered to nothing */
  empty: ReactNode;
  /** Bulk accept per incident, shown when the viewer can decide */
  canDecide: boolean;
  className?: string;
}

type Mode = { id: string | null; kind: "view" | "edit" | "reject" };

/** What opened the record: the evidence row it sits under, and the field it came from. */
type Opened = { citation: CitationRef | null; fieldLabel: string | null };

/** The record viewer's state for one finding. `seq` changes on every open, so the same record opened twice is scrolled into view twice. */
type OpenRecord = { id: string; state: RecordState; opened: Opened; seq: number };

/** The key of an evidence row: one per record and quote. */
const rowKey = (c: { record: number; quote: string | null }) => `${c.record}-${c.quote ?? ""}`;

/** Height of a group header in the list, which sticks to its top edge. */
const STICKY_HEADER = 36;

const NEXT_NOTE = "Keys work while focus is in the findings, and not in a text field.";

/**
 * The Findings tab as a list and a detail side by side, each scrolling on its
 * own (pages/audit-detail.md, "Findings tab"). The selection is in the
 * address (`?finding=`). The detail shows the whole finding, its evidence,
 * the decision buttons and what happens next. Single-key shortcuts as on the
 * incident page: A accept, E edit, R reject, J and K next and previous, O open
 * the first cited record.
 */
export function FindingsWorkspace(p: FindingsWorkspaceProps) {
  const router = useRouter();
  const [singleKeys, setSingleKeys] = useSingleKeys();
  const [busy, start] = useTransition();
  const area = useRef<HTMLDivElement>(null);
  const ids = useId();
  const d = p.detail;

  // State that belongs to one finding resets when another is selected: kept with the ID it was made for.
  const [mode, setMode] = useState<Mode>({ id: null, kind: "view" });
  const [err, setErr] = useState<{ id: string; message: string } | null>(null);
  const [record, setRecord] = useState<OpenRecord | null>(null);
  const opens = useRef(0);
  const [checking, setChecking] = useState<{ id: string; record: number } | null>(null);
  const kind = mode.id === d?.id ? mode.kind : "view";
  const error = err && err.id === d?.id ? err.message : null;
  const rec = record && record.id === d?.id ? record : null;
  const checkingRecord = checking && checking.id === d?.id ? checking.record : null;

  // Keep the selected row in view inside the list. The page itself doesn't move.
  useEffect(() => {
    const row = p.selectedId ? document.getElementById(`finding-row-${p.selectedId}`) : null;
    const box = row?.closest<HTMLElement>("[data-list-scroll]");
    if (!row || !box) return;
    const r = row.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    // The group header sticks to the top of the list.
    const top = b.top + STICKY_HEADER;
    if (r.top < top) box.scrollTop -= top - r.top;
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom;
  }, [p.selectedId]);

  const settle = useCallback(() => {
    if (p.pinHref) router.replace(p.pinHref, { scroll: false });
    else router.refresh();
  }, [p.pinHref, router]);

  const act = (input: Parameters<typeof findingAction>[2], done?: string) => {
    if (!d) return;
    start(async () => {
      const r = await findingAction(p.alias, d.id, input);
      if (!r.ok) return setErr({ id: d.id, message: r.message });
      setErr(null);
      setMode({ id: d.id, kind: "view" });
      if (done) toast.success(done);
      settle();
    });
  };

  const openRecord = useCallback(
    async (n: number, from: Opened) => {
      if (!d) return;
      const forId = d.id;
      const seq = ++opens.current;
      setRecord({ id: forId, state: { status: "loading", n }, opened: from, seq });
      let state: RecordState;
      try {
        const res = await fetch(`/api/spaces/${encodeURIComponent(p.alias)}/audits/${p.auditId}/items/${d.itemId}/records/${n}`, { cache: "no-store" });
        const body = (await res.json()) as (RecordData & { missing?: undefined }) | { missing: true; total: number } | { error: string };
        if (!res.ok || "error" in body) state = { status: "error", n, message: "error" in body ? body.error : "The record could not be loaded." };
        else if ("missing" in body && body.missing) state = { status: "missing", n, total: body.total };
        else state = { status: "ok", data: body as RecordData };
      } catch {
        state = { status: "error", n, message: "The record could not be loaded. Try again." };
      }
      setRecord({ id: forId, state, opened: from, seq });
    },
    [d, p.alias, p.auditId],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const action: ShortcutAction | null = shortcutFor(
      { key: e.key, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, repeat: e.repeat, inTextField: isTextTarget(target), inReviewArea: !!area.current?.contains(target) },
      singleKeys,
    );
    if (!action) return;
    if (action === "next" || action === "prev") {
      e.preventDefault();
      const at = p.order.findIndex((o) => o.id === p.selectedId);
      const to = moveFocus(p.order, at, action);
      const row = p.order[to];
      if (row && row.id !== p.selectedId) router.push(row.href, { scroll: false });
      return;
    }
    if (!d) return;
    if (action === "open") {
      // The first citation that failed and nobody checked, else the first one.
      const rows = evidenceRows(d.citations);
      const c = rows.find((x) => !x.ok && !x.checked) ?? rows[0];
      if (c) {
        e.preventDefault();
        void openRecord(c.record, { citation: c, fieldLabel: null });
      }
      return;
    }
    if (!d.canAct) return;
    if (action === "accept" && d.state === "proposed") {
      e.preventDefault();
      act({ action: "accept" }, "Accepted");
    } else if (action === "edit" && d.canEdit && d.state !== "rejected") {
      e.preventDefault();
      setMode({ id: d.id, kind: "edit" });
    } else if (action === "reject" && d.state !== "rejected") {
      e.preventDefault();
      setMode({ id: d.id, kind: "reject" });
    }
  };

  return (
    <div
      ref={area}
      onKeyDown={onKeyDown}
      className={cn("grid gap-4 lg:h-[calc(100dvh-88px)] lg:min-h-[32rem] lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]", p.className)}
    >
      <ListPane {...p} />
      {d ? (
        <DetailPane
          key={d.id}
          p={p}
          d={d}
          kind={kind}
          error={error}
          busy={busy}
          singleKeys={singleKeys}
          setSingleKeys={setSingleKeys}
          rec={rec}
          checkingRecord={checkingRecord}
          ids={ids}
          onMode={(k) => setMode({ id: d.id, kind: k })}
          onAct={act}
          onOpenRecord={openRecord}
          onCloseRecord={() => setRecord(null)}
          onCheckOpen={(r) => setChecking({ id: d.id, record: r })}
          onCheckClose={() => setChecking(null)}
          onChecked={async (r, note) => {
            const res = await checkCitationAction(p.alias, d.id, { record: r, note });
            if (!res.ok) return res.message;
            toast.success(`Saved your check of R${r}`);
            setChecking(null);
            settle();
            return null;
          }}
        />
      ) : (
        <Card className="justify-center py-0 lg:min-h-0">
          <p className="px-4 py-3 text-center text-[13px] text-muted-foreground">Choose a finding to read it in full.</p>
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the list

function ListPane(p: FindingsWorkspaceProps) {
  const total = p.groups.reduce((n, g) => n + g.rows.length, 0);
  return (
    <Card className="gap-0 overflow-hidden py-0 max-lg:max-h-[60vh] lg:min-h-0" role="region" aria-label="Findings list">
      <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <h2 className="text-sm font-semibold">
          Findings <span className="text-xs font-normal text-muted-foreground tabular-nums">{total}</span>
        </h2>
        {p.bulkRevision ? (
          <AddToRevisionDialog
            alias={p.alias}
            findings={p.bulkRevision}
            acceptFirst={false}
            options={p.revisions.options}
            nameRule={p.revisions.nameRule}
            trigger={(open, disabled) => (
              <Button type="button" variant="outline" size="sm" onClick={open} disabled={disabled}>
                <GitBranch aria-hidden />
                Add the {p.bulkRevision!.length} accepted package {p.bulkRevision!.length === 1 ? "fix" : "fixes"} to a revision…
              </Button>
            )}
          />
        ) : null}
      </div>
      {p.hiddenByFilters ? <p className="shrink-0 border-b bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">The selected finding doesn&apos;t match the filters. It stays in the list until you pick another.</p> : null}
      <div data-list-scroll className="relative min-h-0 flex-1 overflow-y-auto">
        {p.groups.length === 0 ? p.empty : null}
        {p.groups.map((g) => (
          <section key={g.itemId} aria-label={g.incident}>
            <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b bg-muted px-4 py-1.5">
              <p className="text-xs text-muted-foreground">
                <Link href={g.itemHref} className="inline-flex min-h-6 items-center rounded-sm font-mono font-semibold text-foreground underline-offset-4 hover:underline">
                  {g.incident}
                </Link>
                <span className="ml-2">
                  {plural(g.rows.length, "finding")}
                  {g.proposed ? `, ${g.proposed} proposed` : ""}
                  {g.flagged ? `, ${g.flagged} with a failed citation` : ""}
                </span>
              </p>
              {p.canDecide ? <AcceptIncidentButton alias={p.alias} auditId={p.auditId} itemId={g.itemId} incident={g.incident} eligible={g.proposed - g.flagged} flagged={g.flagged} compact /> : null}
            </div>
            <ul>
              {g.rows.map((r) => {
                const selected = r.id === p.selectedId;
                return (
                  <li key={r.id} className="border-b">
                    <Link
                      id={`finding-row-${r.id}`}
                      href={r.href}
                      scroll={false}
                      aria-current={selected ? "true" : undefined}
                      className={cn(
                        "block space-y-1 px-4 py-2.5 outline-offset-[-2px] hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring",
                        selected && "bg-foreground/5 shadow-[inset_3px_0_0_var(--foreground)] hover:bg-foreground/5",
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                          {r.kindLabel}
                          {r.tag ? ` · ${r.tag}` : ""}
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          {r.flagged ? <TriangleAlert className="size-3.5 text-warning-fg" aria-label="A citation failed the check" /> : null}
                          {r.edited ? <StatusBadge {...EDITED_BADGE} /> : null}
                          <StatusBadge {...FINDING_STATE_BADGE[r.state]} />
                        </span>
                      </span>
                      <span className="line-clamp-2 text-[13px] [overflow-wrap:anywhere]">{r.title}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      <div className="shrink-0 border-t px-4 py-2 text-xs text-muted-foreground">{p.footer}</div>
    </Card>
  );
}

// ------------------------------------------------------------------ the detail

interface DetailProps {
  p: FindingsWorkspaceProps;
  d: DetailData;
  kind: Mode["kind"];
  error: string | null;
  busy: boolean;
  singleKeys: boolean;
  setSingleKeys: (on: boolean) => void;
  rec: OpenRecord | null;
  checkingRecord: number | null;
  ids: string;
  onMode: (k: Mode["kind"]) => void;
  onAct: (input: Parameters<typeof findingAction>[2], done?: string) => void;
  onOpenRecord: (n: number, from: Opened) => Promise<void>;
  onCloseRecord: () => void;
  onCheckOpen: (record: number) => void;
  onCheckClose: () => void;
  onChecked: (record: number, note: string) => Promise<string | null>;
}

function DetailPane({ p, d, kind, error, busy, singleKeys, setSingleKeys, rec, checkingRecord, ids, onMode, onAct, onOpenRecord, onCloseRecord, onCheckOpen, onCheckClose, onChecked }: DetailProps) {
  // A field that is a list of citations (a fix's evidence) is the Evidence section below, not a row.
  const rows = useMemo(() => cardRows(d.fields, d.hidden).filter((r) => !isCitationList(r.field)), [d.fields, d.hidden]);
  const evidence = useMemo(() => evidenceRows(d.citations), [d.citations]);
  const summary = evidenceSummary(evidence);
  const failedOpen = evidence.filter((c) => !c.ok && !c.checked).length;
  const primary = d.fields.find((x) => x.choices && !x.multiple && /primary/.test(x.key))?.value;
  const openN = rec ? (rec.state.status === "ok" ? rec.state.data.n : rec.state.status === "idle" ? null : rec.state.n) : null;
  const failedForOpen = openN ? (d.citations.find((c) => c.record === openN && !c.ok && !c.checked) ?? d.citations.find((c) => c.record === openN && !c.ok)) : undefined;
  const headingId = `${ids}-title`;

  // The record opens under the evidence row that was clicked, and stays there while its neighbours are read.
  const open = rec && rec.state.status !== "idle" ? rec : null;
  const anchor = open ? evidence.findIndex((c) => (open.opened.citation ? rowKey(c) === rowKey(open.opened.citation) : c.record === openN)) : -1;
  const recordBox = useRef<HTMLDivElement>(null);
  const seq = rec?.seq;
  const status = rec?.state.status;
  // Bring the record into view on every open, and again when its text arrives and the card grows.
  useEffect(() => {
    if (seq !== undefined) reveal(recordBox.current);
  }, [seq, status]);

  const recordCard = open ? (
    <div ref={recordBox} className="scroll-mt-2 pt-1">
      <RecordCard
        headingId={`${ids}-record`}
        zone={p.zone}
        state={open.state}
        fieldLabel={open.opened.fieldLabel}
        quotes={openN && !failedForOpen ? quotesFor(d.citations, openN) : []}
        failedReason={failedForOpen && failedForOpen.problem === "quote-not-found" ? citationChipReason({ ...failedForOpen, checked: null }, d.totalRecords) : null}
        failedQuote={failedForOpen && failedForOpen.problem === "quote-not-found" ? failedForOpen.quote : null}
        checkedNote={failedForOpen?.checked ? citationChipReason(failedForOpen, d.totalRecords) : null}
        onOpen={(n) => void onOpenRecord(n, open.opened)}
        onClose={() => {
          onCloseRecord();
          if (anchor >= 0) document.getElementById(`${ids}-chip-${anchor}`)?.focus();
        }}
      />
    </div>
  ) : null;

  return (
    <Card className="gap-0 overflow-hidden py-0 max-lg:max-h-[85vh] lg:min-h-0" role="region" aria-labelledby={headingId}>
      <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-4 py-2">
        <p className="min-w-0 text-[13px] text-muted-foreground [overflow-wrap:anywhere]">
          <span className="font-medium text-foreground">{d.position}</span> for{" "}
          <Link href={d.itemHref} className="rounded-sm font-mono text-foreground underline underline-offset-4 hover:no-underline">
            {d.incident}
          </Link>
          {d.ownerLine ? ` · ${d.ownerLine}` : ""}
        </p>
        {kind === "view" ? (
          <DecisionButtons
            state={d.state}
            canAct={d.canAct}
            canEdit={d.canEdit && d.state !== "rejected"}
            busy={busy}
            keys={singleKeys && d.canAct}
            decidedBy={d.decidedBy}
            flagged={failedOpen > 0}
            label={d.title}
            onAccept={() => onAct({ action: "accept" }, "Accepted")}
            onEdit={() => onMode("edit")}
            onReject={() => onMode("reject")}
            onReopen={() => onAct({ action: "reopen" })}
          />
        ) : null}
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge {...FINDING_STATE_BADGE[d.state]} />
          {d.edited ? <StatusBadge {...EDITED_BADGE} /> : null}
          {failedOpen ? <StatusBadge tone="warning" icon={TriangleAlert} label={`${plural(failedOpen, "citation")} failed`} /> : null}
        </div>
        <h2 id={headingId} className="max-w-[80ch] text-base leading-snug font-semibold [overflow-wrap:anywhere]">
          {d.title}
        </h2>
        {error ? (
          <p role="alert" className="text-[13px] text-destructive-fg">
            {error}
          </p>
        ) : null}
        {kind === "edit" ? (
          <EditForm fields={d.fields} busy={busy} onCancel={() => onMode("view")} onSave={(values) => onAct({ action: "accept", values }, "Saved and accepted")} />
        ) : (
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2.5 text-[13px] sm:grid-cols-[10rem_minmax(0,1fr)]">
            {rows.map((r) => (
              <div key={r.field.key} className="contents">
                <dt className="text-muted-foreground">{r.field.label}</dt>
                <dd className="min-w-0 max-w-[80ch] [overflow-wrap:anywhere]">
                  <FieldValue field={r.field} primary={typeof primary === "string" && r.field.multiple ? primary : null} />
                  {r.detail && r.detail.value ? <span className="mt-0.5 block whitespace-pre-wrap">{String(r.detail.value)}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {kind === "reject" ? (
          <div className="-mx-4 border-y">
            <RejectForm busy={busy} onCancel={() => onMode("view")} onReject={(note) => onAct({ action: "reject", note: note || undefined }, "Rejected")} />
          </div>
        ) : null}

        <section aria-labelledby={`${ids}-evidence`} className="space-y-2">
          <h3 id={`${ids}-evidence`} className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
            Evidence
            <span className={cn("rounded-full border px-2 py-px text-xs font-normal", summary.tone === "success" ? "border-success/45 text-success-fg" : summary.tone === "warning" ? "border-warning/45 text-warning-fg" : "text-muted-foreground")}>
              {summary.tone === "success" ? <Check className="mr-1 inline size-3" aria-hidden /> : summary.tone === "warning" ? <TriangleAlert className="mr-1 inline size-3" aria-hidden /> : null}
              {summary.label}
            </span>
          </h3>
          {evidence.length ? (
            <>
              <p className="max-w-[80ch] text-xs text-muted-foreground">
                R{evidence[0]!.record} is record {evidence[0]!.record} of this investigation&apos;s journal. Press a record number to read it here, under its row.
              </p>
              <ul className="space-y-2.5">
                {evidence.map((c, i) => {
                  const res = citationResult(c, d.totalRecords);
                  const key = rowKey(c);
                  return (
                    <li key={key} className="space-y-1">
                      <div className="flex items-start gap-2">
                        <CitationChip
                          id={`${ids}-chip-${i}`}
                          n={c.record}
                          pressed={openN === c.record}
                          failed={!c.ok}
                          checked={!!c.checked}
                          onClick={() => void onOpenRecord(c.record, { citation: c, fieldLabel: null })}
                        />
                        {c.quote ? <blockquote className="min-w-0 border-l-2 border-info pl-2.5 text-[13px] text-muted-foreground [overflow-wrap:anywhere]">&ldquo;{c.quote}&rdquo;</blockquote> : <span className="text-[13px] text-muted-foreground">No text quoted</span>}
                      </div>
                      <p className={cn("flex flex-wrap items-start gap-x-1.5 gap-y-1 pl-1 text-xs", res.tone === "success" ? "text-success-fg" : "text-warning-fg")}>
                        {res.tone === "success" ? <CircleCheck className="mt-px size-3.5 shrink-0" aria-hidden /> : <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />}
                        <span className="min-w-0 [overflow-wrap:anywhere]">{res.text}</span>
                        {!c.ok && !c.checked && d.canCheck && checkingRecord !== c.record ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="-my-0.5 h-7 text-xs"
                            onClick={() => {
                              onCheckOpen(c.record);
                              // The note says what the reviewer found in the record, so the record is shown next to it.
                              if (openN !== c.record) void onOpenRecord(c.record, { citation: c, fieldLabel: null });
                            }}
                          >
                            <Check aria-hidden />I checked the record
                          </Button>
                        ) : null}
                      </p>
                      {checkingRecord === c.record && !c.ok && !c.checked ? <CheckForm record={c.record} busy={busy} onCancel={onCheckClose} onSave={(note) => onChecked(c.record, note)} /> : null}
                      {i === anchor ? recordCard : null}
                    </li>
                  );
                })}
              </ul>
              {anchor < 0 ? recordCard : null}
            </>
          ) : (
            <p className="text-[13px] text-muted-foreground">This finding cites no journal records.</p>
          )}
        </section>

        <NextStepPanel alias={p.alias} step={d.next} finding={{ id: d.id, title: d.title }} options={p.revisions.options} nameRule={p.revisions.nameRule} />

        <div className="space-y-1.5 border-t pt-3 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p>
              Keyboard:{" "}
              {SHORTCUT_KEYS.map((s, i) => (
                <span key={s.key}>
                  {i > 0 ? " · " : ""}
                  <kbd className="rounded border bg-background px-1 font-mono">{s.key}</kbd> {s.action === "next" ? "next proposed" : s.action === "prev" ? "previous" : s.action === "open" ? "open a record" : s.action}
                </span>
              ))}
            </p>
            <label className="flex min-h-6 items-center gap-2 text-[13px] text-foreground">
              <Switch checked={singleKeys} onCheckedChange={setSingleKeys} />
              Single keys {singleKeys ? "on" : "off"}
            </label>
          </div>
          <p>{NEXT_NOTE}</p>
        </div>
      </div>
    </Card>
  );
}
