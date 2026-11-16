"use client";

import { Check, ChevronDown, CircleCheck, Keyboard, SquarePen, TriangleAlert, Undo2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { forwardRef, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { acceptAllAction, checkCitationAction, findingAction } from "@/app/(app)/spaces/[alias]/audits/actions";
import { Checkbox } from "@/components/common/checkbox";
import { StatusBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { cardRows, changedValues, citationsByField, isCitationList, quotesFor, type CardField, type CitationRef } from "./finding-view";
import { RecordCard, type RecordData, type RecordState } from "./record-card";
import { isTextTarget, moveFocus, SHORTCUT_KEYS, shortcutFor, SINGLE_KEYS_STORAGE, type ShortcutAction } from "./shortcuts";
import { citationChipReason, EDITED_BADGE, FINDING_STATE_BADGE, plural } from "./words";

export interface CardFinding {
  id: string;
  kind: string;
  /** "Diagnosis", "Fix 2 of 3" */
  position: string;
  title: string;
  state: "proposed" | "accepted" | "rejected";
  edited: boolean;
  from: string;
  hidden: string[];
  fields: CardField[];
  citations: CitationRef[];
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAtText: string | null;
  /** Accept, edit, reject and reopen are allowed (role, audit state, current review) */
  canAct: boolean;
  canEdit: boolean;
  /** "I checked the record" is offered on failed citations (role, audit state, current review) */
  canCheck?: boolean;
}

export interface EvidenceDoc {
  kind: string;
  label: string;
  preview: ReactNode;
  full: ReactNode | null;
  footer: ReactNode;
  uncertain: boolean;
}

/** What "Partly uncertain" means and where it comes from (the review's `ground_truth_uncertain`). */
export const UNCERTAIN_HELP =
  "The review marked this ground truth as partly uncertain (ground_truth_uncertain in its output): the confirmed root cause leaves something open, often an \"Open question\" in the document. Judge the findings that depend on that part with care.";

export interface ReviewWorkspaceProps {
  alias: string;
  auditId: string;
  itemId: string;
  incident: string;
  totalRecords: number | null;
  groundTruth: EvidenceDoc[];
  finalAnswer: { text: string; record: number | null } | null;
  findings: CardFinding[];
  initial: { citation: CitationRef | null; fieldLabel: string | null; data: RecordData | { missing: true; total: number } | null };
  /** Shortcuts and bulk accept are offered (findings.review, audit in review, current review) */
  reviewable: boolean;
  counts: { accepted: number; proposed: number; rejected: number; total: number };
  callout: ReactNode;
}

function useSingleKeys(): [boolean, (on: boolean) => void] {
  const subscribe = useCallback((cb: () => void) => {
    window.addEventListener("storage", cb);
    window.addEventListener("dam-single-keys", cb);
    return () => {
      window.removeEventListener("storage", cb);
      window.removeEventListener("dam-single-keys", cb);
    };
  }, []);
  const on = useSyncExternalStore(
    subscribe,
    () => window.localStorage.getItem(SINGLE_KEYS_STORAGE) !== "off",
    () => true,
  );
  const set = (v: boolean) => {
    window.localStorage.setItem(SINGLE_KEYS_STORAGE, v ? "on" : "off");
    window.dispatchEvent(new Event("dam-single-keys"));
  };
  return [on, set];
}

function useWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia("(min-width: 1024px)");
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia("(min-width: 1024px)").matches,
    () => true,
  );
}

const Kbd = ({ k, on }: { k: string; on: boolean }) => (on ? <kbd className="ml-1 rounded border bg-background px-1 font-mono text-xs text-muted-foreground">{k}</kbd> : null);

/**
 * The incident review, option 1 split view (pages/audit-item.md, MASTER
 * "Page index"): evidence on the left (confirmed root cause, the
 * agent's final answer, the cited journal record), every finding card on the
 * right, with option 2's single-key shortcuts on the focused card.
 */
export function ReviewWorkspace(props: ReviewWorkspaceProps) {
  const { alias, auditId, itemId, findings, reviewable } = props;
  const router = useRouter();
  const [singleKeys, setSingleKeys] = useSingleKeys();
  const wide = useWide();
  const [gtKind, setGtKind] = useState(props.groundTruth[0]?.kind ?? "");
  const [fullDoc, setFullDoc] = useState(false);
  const [focusIdx, setFocusIdx] = useState(-1);
  const [editing, setEditing] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sheetOpen, setSheetOpen] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLElement | null)[]>([]);
  const ids = useId();

  // ------------------------------------------------ the record card
  const initialState: RecordState = !props.initial.citation
    ? { status: "idle" }
    : props.initial.data && "missing" in props.initial.data
      ? { status: "missing", n: props.initial.citation.record, total: props.initial.data.total }
      : props.initial.data
        ? { status: "ok", data: props.initial.data }
        : { status: "error", n: props.initial.citation.record, message: "The journal of this investigation is not in the cache." };
  const [record, setRecord] = useState<RecordState>(initialState);
  const [opened, setOpened] = useState<{ citation: CitationRef | null; fieldLabel: string | null }>({ citation: props.initial.citation, fieldLabel: props.initial.fieldLabel });
  const allCitations = useMemo(() => findings.flatMap((f) => f.citations), [findings]);

  const openRecord = useCallback(
    async (n: number, from: { citation: CitationRef | null; fieldLabel: string | null } = { citation: null, fieldLabel: null }) => {
      setOpened(from);
      if (!wide) setSheetOpen(true);
      setRecord({ status: "loading", n });
      try {
        const res = await fetch(`/api/spaces/${encodeURIComponent(alias)}/audits/${auditId}/items/${itemId}/records/${n}`, { cache: "no-store" });
        const body = (await res.json()) as (RecordData & { missing?: undefined }) | { missing: true; total: number } | { error: string };
        if (!res.ok || "error" in body) return setRecord({ status: "error", n, message: "error" in body ? body.error : "The record could not be loaded." });
        if ("missing" in body && body.missing) return setRecord({ status: "missing", n, total: body.total });
        setRecord({ status: "ok", data: body as RecordData });
      } catch {
        setRecord({ status: "error", n, message: "The record could not be loaded. Try again." });
      }
    },
    [alias, auditId, itemId, wide],
  );

  const openN = record.status === "ok" ? record.data.n : record.status === "idle" ? null : record.n;
  const failedForOpen = openN ? (allCitations.find((c) => c.record === openN && !c.ok && !c.checked) ?? allCitations.find((c) => c.record === openN && !c.ok)) : undefined;
  const recordCard = (where: "inline" | "sheet") => (
    <RecordCard
      headingId={`${ids}-rec-${where}`}
      state={record}
      fieldLabel={opened.citation && opened.citation.record === openN ? opened.fieldLabel : null}
      quotes={openN && !failedForOpen ? quotesFor(allCitations, openN) : []}
      failedReason={failedForOpen && failedForOpen.problem === "quote-not-found" ? citationChipReason({ ...failedForOpen, checked: null }, props.totalRecords) : null}
      failedQuote={failedForOpen && failedForOpen.problem === "quote-not-found" ? failedForOpen.quote : null}
      checkedNote={failedForOpen?.checked ? citationChipReason(failedForOpen, props.totalRecords) : null}
      onOpen={(n) => void openRecord(n)}
    />
  );

  // ------------------------------------------------ finding actions
  const act = (f: CardFinding, input: Parameters<typeof findingAction>[2], done?: string) =>
    start(async () => {
      const r = await findingAction(alias, f.id, input);
      if (!r.ok) return setErrors((e) => ({ ...e, [f.id]: r.message }));
      setErrors((e) => {
        const next = { ...e };
        delete next[f.id];
        return next;
      });
      setEditing(null);
      setRejecting(null);
      if (done) toast.success(done);
      router.refresh();
    });

  const check = async (f: CardFinding, record: number, note: string): Promise<string | null> => {
    const r = await checkCitationAction(alias, f.id, { record, note });
    if (!r.ok) return r.message;
    toast.success(`Saved your check of R${record}`);
    router.refresh();
    return null;
  };

  const eligible = findings.filter((f) => f.state === "proposed" && f.citations.every((c) => c.ok || c.checked)).length;
  const flagged = findings.filter((f) => f.state === "proposed" && f.citations.some((c) => !c.ok && !c.checked)).length;
  const acceptAll = () =>
    start(async () => {
      const r = await acceptAllAction(alias, auditId, itemId);
      if (!r.ok) {
        setErrors((e) => ({ ...e, bulk: r.message }));
        return;
      }
      toast.success(`Accepted ${plural(r.accepted, "finding")} in ${props.incident}`);
      router.refresh();
    });

  // ------------------------------------------------ keyboard
  const focusCard = (i: number) => {
    const el = cardRefs.current[i];
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const action: ShortcutAction | null = shortcutFor(
      { key: e.key, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, repeat: e.repeat, inTextField: isTextTarget(target), inReviewArea: !!area.current?.contains(target) },
      singleKeys && reviewable,
    );
    if (!action) return;
    const idx = focusIdx;
    const f = idx >= 0 ? findings[idx] : undefined;
    if (action === "next" || action === "prev") {
      e.preventDefault();
      focusCard(moveFocus(findings.map((x) => ({ id: x.id, proposed: x.state === "proposed" })), idx, action));
      return;
    }
    if (!f) return;
    if (action === "open") {
      const c = f.citations[0];
      if (c) {
        e.preventDefault();
        void openRecord(c.record, { citation: c, fieldLabel: f.fields.find((x) => x.key === c.field.split(/[.[]/)[0])?.label ?? null });
      }
      return;
    }
    if (!f.canAct) return;
    if (action === "accept" && f.state === "proposed") {
      e.preventDefault();
      act(f, { action: "accept" }, "Accepted");
    } else if (action === "edit" && f.canEdit && f.state !== "rejected") {
      e.preventDefault();
      setEditing(f.id);
    } else if (action === "reject" && f.state !== "rejected") {
      e.preventDefault();
      setRejecting(f.id);
    }
  };

  const doc = props.groundTruth.find((g) => g.kind === gtKind) ?? props.groundTruth[0];

  return (
    <div ref={area} onKeyDown={onKeyDown} className="space-y-4">
      {props.callout}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        {/* Evidence */}
        <div className="min-w-0 space-y-4">
          {doc ? (
            <section aria-labelledby={`${ids}-gt`} className="rounded-xl border bg-card">
              <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
                <h2 id={`${ids}-gt`} className="text-sm font-semibold">
                  {doc.label}
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  {doc.uncertain ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" aria-describedby={`${ids}-gt-uncertain`}>
                          <StatusBadge tone="warning" icon={TriangleAlert} label="Partly uncertain" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-sm">
                        {UNCERTAIN_HELP}
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                  {props.groundTruth.length > 1 ? (
                    <div role="group" aria-label="Ground truth document" className="inline-flex overflow-hidden rounded-lg border">
                      {props.groundTruth.map((g) => (
                        <button
                          key={g.kind}
                          type="button"
                          aria-pressed={g.kind === doc.kind}
                          onClick={() => {
                            setGtKind(g.kind);
                            setFullDoc(false);
                          }}
                          className={cn("h-7 border-r px-2.5 text-xs last:border-r-0", g.kind === doc.kind ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
                        >
                          {g.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
              {doc.uncertain ? (
                <p id={`${ids}-gt-uncertain`} className="flex items-start gap-1.5 border-b bg-warning/7 px-4 py-2 text-xs">
                  <TriangleAlert className="mt-px size-3.5 shrink-0 text-warning-fg" aria-hidden />
                  <span>{UNCERTAIN_HELP}</span>
                </p>
              ) : null}
              <div className="px-4 py-3 text-[13px]">{fullDoc && doc.full ? doc.full : doc.preview}</div>
              <div className="space-y-1 border-t px-4 py-2 text-xs text-muted-foreground">
                {doc.full ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setFullDoc((v) => !v)} aria-expanded={fullDoc}>
                    <ChevronDown className={cn("transition-transform", fullDoc && "rotate-180")} aria-hidden />
                    {fullDoc ? "Show less" : "Show the full document"}
                  </Button>
                ) : null}
                <p>{doc.footer}</p>
              </div>
            </section>
          ) : null}
          {props.finalAnswer ? (
            <section aria-labelledby={`${ids}-fa`} className="rounded-xl border bg-card">
              <div className="flex min-h-12 items-center justify-between gap-2 border-b px-4 py-2">
                <h2 id={`${ids}-fa`} className="text-sm font-semibold">
                  Agent&apos;s final answer
                </h2>
                {props.finalAnswer.record ? <Chip n={props.finalAnswer.record} pressed={openN === props.finalAnswer.record} onClick={() => void openRecord(props.finalAnswer!.record!, { citation: null, fieldLabel: "scored summary" })} /> : null}
              </div>
              <p className="max-w-[72ch] px-4 py-3 text-[13px] whitespace-pre-wrap [overflow-wrap:anywhere]">{props.finalAnswer.text}</p>
            </section>
          ) : null}
          {recordCard("inline")}
          {reviewable ? (
            <section aria-labelledby={`${ids}-kb`} className="rounded-xl border bg-card">
              <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
                <h2 id={`${ids}-kb`} className="flex items-center gap-1.5 text-sm font-semibold">
                  <Keyboard className="size-4" aria-hidden />
                  Keyboard
                </h2>
                <label className="flex min-h-6 items-center gap-2 text-[13px]">
                  <Switch checked={singleKeys} onCheckedChange={setSingleKeys} />
                  Single keys {singleKeys ? "on" : "off"}
                </label>
              </div>
              <div className="space-y-2 px-4 py-3 text-[13px]">
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  {SHORTCUT_KEYS.map((s) => (
                    <div key={s.key} className="contents">
                      <dt>
                        <kbd className="rounded border bg-background px-1.5 font-mono text-xs">{s.key}</kbd>
                      </dt>
                      <dd>{s.label}</dd>
                    </div>
                  ))}
                </dl>
                <p className="text-xs text-muted-foreground">The keys work on the focused finding card, while focus is in the review area and not in a text field.</p>
              </div>
            </section>
          ) : null}
        </div>

        {/* Findings */}
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">
              Findings{" "}
              <span className="font-normal text-muted-foreground">
                {props.counts.total}: {[props.counts.accepted ? `${props.counts.accepted} accepted` : null, props.counts.proposed ? `${props.counts.proposed} proposed` : null, props.counts.rejected ? `${props.counts.rejected} rejected` : null].filter(Boolean).join(", ") || "none"}
              </span>
            </h2>
            {reviewable && eligible > 0 ? (
              <Button variant="outline" size="sm" onClick={acceptAll} disabled={busy}>
                <Check aria-hidden />
                {flagged ? `Accept the ${eligible} without problems` : `Accept ${eligible}`}
              </Button>
            ) : null}
            {errors.bulk ? (
              <p role="alert" className="w-full text-right text-xs text-destructive-fg">
                {errors.bulk}
              </p>
            ) : null}
          </div>
          {findings.map((f, i) => (
            <FindingCard
              key={f.id}
              ref={(el) => {
                cardRefs.current[i] = el;
              }}
              f={f}
              totalRecords={props.totalRecords}
              openN={openN}
              busy={busy}
              singleKeys={singleKeys && reviewable}
              editing={editing === f.id}
              rejecting={rejecting === f.id}
              error={errors[f.id] ?? null}
              onFocus={() => setFocusIdx(i)}
              onOpenCitation={(c, label) => void openRecord(c.record, { citation: c, fieldLabel: label })}
              onAccept={() => act(f, { action: "accept" }, "Accepted")}
              onEdit={() => setEditing(f.id)}
              onCancelEdit={() => setEditing(null)}
              onSaveEdit={(values) => act(f, { action: "accept", values }, "Saved and accepted")}
              onReject={(note) => act(f, { action: "reject", note: note || undefined }, "Rejected")}
              onRejectOpen={(o) => setRejecting(o ? f.id : null)}
              onReopen={() => act(f, { action: "reopen" })}
              onCheck={(record, note) => check(f, record, note)}
            />
          ))}
        </div>
      </div>
      <Sheet open={!wide && sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Journal record</SheetTitle>
            <SheetDescription>The record a citation points at, as plain text.</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">{recordCard("sheet")}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Chip({ n, pressed, onClick, failed, checked, reason }: { n: number; pressed: boolean; onClick: () => void; failed?: boolean; checked?: boolean; reason?: string | null }) {
  const id = useId();
  return (
    <span className="inline-flex max-w-full items-start gap-1.5">
      <button
        type="button"
        aria-pressed={pressed}
        aria-describedby={reason ? id : undefined}
        aria-label={`Open record R${n}`}
        onClick={onClick}
        className={cn(
          "inline-flex h-6 min-w-6 shrink-0 items-center gap-1 rounded-md border px-1.5 font-mono text-xs tabular-nums transition-colors",
          failed && !checked ? "border-warning/45 bg-warning/12 text-warning-fg" : "bg-background hover:bg-muted",
          pressed && (!failed || checked) && "border-primary bg-primary text-primary-foreground hover:bg-primary",
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

function FieldValue({ field, primary }: { field: CardField; primary: string | null }) {
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

const FindingCard = forwardRef<
  HTMLElement,
  {
    f: CardFinding;
    totalRecords: number | null;
    openN: number | null;
    busy: boolean;
    singleKeys: boolean;
    editing: boolean;
    rejecting: boolean;
    error: string | null;
    onFocus: () => void;
    onOpenCitation: (c: CitationRef, fieldLabel: string) => void;
    onAccept: () => void;
    onEdit: () => void;
    onCancelEdit: () => void;
    onSaveEdit: (values: Record<string, unknown>) => void;
    onReject: (note: string) => void;
    onRejectOpen: (open: boolean) => void;
    onReopen: () => void;
    onCheck: (record: number, note: string) => Promise<string | null>;
  }
>(function FindingCard(p, ref) {
  const { f } = p;
  const rows = cardRows(f.fields, f.hidden);
  const shown = rows.flatMap((r) => [r.field.key, ...(r.detail ? [r.detail.key] : [])]);
  const byField = citationsByField(f.citations, f.from, shown);
  const failedCount = new Set(f.citations.filter((c) => !c.ok && !c.checked).map((c) => `${c.record}`)).size;
  const checkedCount = new Set(f.citations.filter((c) => !c.ok && c.checked).map((c) => `${c.record}`)).size;
  // The citation whose "I checked the record" form is open: the row it was opened from, and the record.
  const [checking, setChecking] = useState<{ row: string; record: number } | null>(null);
  const primary = f.fields.find((x) => x.choices && !x.multiple && /primary/.test(x.key))?.value;
  const headingId = `finding-${f.id}-title`;

  const chips = (cs: CitationRef[] | undefined, label: string) =>
    cs?.length ? (
      <>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          {cs.map((c) => (
            <span key={`${c.record}-${c.field}`} className="inline-flex max-w-full flex-wrap items-start gap-x-1.5">
              <Chip n={c.record} pressed={p.openN === c.record} failed={!c.ok} checked={!!c.checked} reason={citationChipReason(c, p.totalRecords)} onClick={() => p.onOpenCitation(c, label)} />
              {!c.ok && !c.checked && f.canCheck && !(checking?.row === label && checking.record === c.record) ? (
                <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-xs" onClick={() => setChecking({ row: label, record: c.record })}>
                  I checked the record
                </Button>
              ) : null}
            </span>
          ))}
        </span>
        {checking?.row === label && cs.some((c) => c.record === checking.record && !c.ok && !c.checked) ? (
          <span className="mt-1.5 block">
            <CheckForm
              record={checking.record}
              busy={p.busy}
              onCancel={() => setChecking(null)}
              onSave={async (note) => {
                const err = await p.onCheck(checking.record, note);
                if (!err) setChecking(null);
                return err;
              }}
            />
          </span>
        ) : null}
      </>
    ) : null;

  return (
    <article
      ref={ref}
      id={`finding-${f.id}`}
      tabIndex={-1}
      onFocus={p.onFocus}
      aria-labelledby={headingId}
      className={cn("scroll-mt-20 rounded-xl border bg-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", failedCount && "border-warning/45")}
    >
      <div className="space-y-2 px-4 pt-3 pb-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge tone="neutral" label={f.position} />
          <StatusBadge {...FINDING_STATE_BADGE[f.state]} />
          {f.edited ? <StatusBadge {...EDITED_BADGE} /> : null}
          {failedCount ? <StatusBadge tone="warning" icon={TriangleAlert} label={`${plural(failedCount, "citation")} failed`} /> : null}
          {checkedCount ? <StatusBadge tone="neutral" icon={CircleCheck} label={`${plural(checkedCount, "failed citation")} checked`} /> : null}
          {f.state !== "proposed" && f.reviewedBy ? (
            <span className="ml-auto text-xs text-muted-foreground">
              {f.reviewedBy}
              {f.reviewedAtText ? `, ${f.reviewedAtText}` : ""}
            </span>
          ) : null}
        </div>
        <h3 id={headingId} className="text-sm font-semibold [overflow-wrap:anywhere]">
          {f.title}
        </h3>
        {p.editing ? (
          <EditForm f={f} busy={p.busy} onCancel={p.onCancelEdit} onSave={p.onSaveEdit} />
        ) : (
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-[13px] sm:grid-cols-[10rem_1fr]">
            {rows.map((r) => (
              <div key={r.field.key} className="contents">
                <dt className="text-muted-foreground">{r.field.label}</dt>
                <dd className="min-w-0 [overflow-wrap:anywhere]">
                  <FieldValue field={r.field} primary={typeof primary === "string" && r.field.multiple ? primary : null} />
                  {r.detail && r.detail.value ? <span className="mt-0.5 block whitespace-pre-wrap">{String(r.detail.value)}</span> : null}
                  {(() => {
                    const cs = [...(byField.get(r.field.key) ?? []), ...(r.detail ? (byField.get(r.detail.key) ?? []) : [])];
                    if (!cs.length && isCitationList(r.field)) return <span className="text-muted-foreground">No records cited</span>;
                    return chips(cs, r.field.label);
                  })()}
                </dd>
              </div>
            ))}
            {byField.get("")?.length ? (
              <div className="contents">
                <dt className="text-muted-foreground">Other citations</dt>
                <dd>{chips(byField.get(""), "other")}</dd>
              </div>
            ) : null}
            {f.reviewNote ? (
              <div className="contents">
                <dt className="text-muted-foreground">Review note</dt>
                <dd className="whitespace-pre-wrap">{f.reviewNote}</dd>
              </div>
            ) : null}
          </dl>
        )}
        {p.error ? (
          <p role="alert" className="text-xs text-destructive-fg">
            {p.error}
          </p>
        ) : null}
      </div>
      {f.canAct && !p.editing && p.rejecting ? (
        <RejectForm busy={p.busy} onCancel={() => p.onRejectOpen(false)} onReject={p.onReject} />
      ) : null}
      {f.canAct && !p.editing && !p.rejecting ? (
        <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2.5">
          {f.state === "proposed" ? (
            <>
              <Button size="sm" onClick={p.onAccept} disabled={p.busy}>
                <Check aria-hidden />
                Accept
                <Kbd k="A" on={p.singleKeys} />
              </Button>
              {f.canEdit ? (
                <Button size="sm" variant="outline" onClick={p.onEdit} disabled={p.busy}>
                  <SquarePen aria-hidden />
                  Edit
                  <Kbd k="E" on={p.singleKeys} />
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" disabled={p.busy} onClick={() => p.onRejectOpen(true)}>
                <X aria-hidden />
                Reject
                <Kbd k="R" on={p.singleKeys} />
              </Button>
              {failedCount ? <span className="ml-auto text-xs text-muted-foreground">Accepting keeps the flag in the record.</span> : null}
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={p.onReopen} disabled={p.busy}>
              <Undo2 aria-hidden />
              Change decision
            </Button>
          )}
        </div>
      ) : null}
    </article>
  );
});

/**
 * Reject with an optional note, in the card's footer under the evidence
 * (pages/audit-detail.md, "Rejecting"), so it never covers the citations it
 * is about. The note is stored as the finding's review note.
 */
function RejectForm({ busy, onCancel, onReject }: { busy: boolean; onCancel: () => void; onReject: (note: string) => void }) {
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
function CheckForm({ record, busy, onCancel, onSave }: { record: number; busy: boolean; onCancel: () => void; onSave: (note: string) => Promise<string | null> }) {
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

function EditForm({ f, busy, onCancel, onSave }: { f: CardFinding; busy: boolean; onCancel: () => void; onSave: (values: Record<string, unknown>) => void }) {
  const editable = f.fields.filter((x) => x.editable);
  const current = Object.fromEntries(f.fields.map((x) => [x.key, x.value]));
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
