"use client";

import { Check, ChevronDown, CircleCheck, Keyboard, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { forwardRef, useCallback, useId, useMemo, useRef, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { acceptAllAction, checkCitationAction, findingAction } from "@/app/(app)/spaces/[alias]/audits/actions";
import { StatusBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { NextStep } from "@/server/audits/next-step";
import type { RevisionChoice } from "./revision-choice";
import { CheckForm, DecisionButtons, EditForm, RejectForm } from "./finding-decision";
import { CitationChip, FieldValue } from "./finding-fields";
import { NextStepPanel } from "./next-step-panel";
import { cardRows, citationsByField, isCitationList, quotesFor, type CardField, type CitationRef } from "./finding-view";
import { RecordCard, type RecordData, type RecordState } from "./record-card";
import { isTextTarget, moveFocus, SHORTCUT_KEYS, shortcutFor, type ShortcutAction } from "./shortcuts";
import type { ViewerZone } from "@/components/common/time-format";
import { useSingleKeys } from "./use-single-keys";
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
  /** What happens next with this finding (src/server/audits/next-step.ts) */
  next: NextStep;
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
  /** The viewer's time zone, for times rendered in the browser */
  zone?: ViewerZone;
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
  /** The open revisions "Add to revision…" offers, and the revision name rule */
  revisions: { options: RevisionChoice[]; nameRule: { pattern: string; hint: string; maxLength: number } };
  counts: { accepted: number; proposed: number; rejected: number; total: number };
  callout: ReactNode;
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
      zone={props.zone}
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
                {props.finalAnswer.record ? <CitationChip n={props.finalAnswer.record} pressed={openN === props.finalAnswer.record} onClick={() => void openRecord(props.finalAnswer!.record!, { citation: null, fieldLabel: "scored summary" })} /> : null}
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
              alias={alias}
              revisions={props.revisions}
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
    alias: string;
    revisions: ReviewWorkspaceProps["revisions"];
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
              <CitationChip n={c.record} pressed={p.openN === c.record} failed={!c.ok} checked={!!c.checked} reason={citationChipReason(c, p.totalRecords)} onClick={() => p.onOpenCitation(c, label)} />
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
        </div>
        <h3 id={headingId} className="text-sm font-semibold [overflow-wrap:anywhere]">
          {f.title}
        </h3>
        {p.editing ? (
          <EditForm fields={f.fields} busy={p.busy} onCancel={p.onCancelEdit} onSave={p.onSaveEdit} />
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
      {!p.editing ? (
        <div className="px-4 pb-3">
          <NextStepPanel alias={p.alias} step={f.next} finding={{ id: f.id, title: f.title }} options={p.revisions.options} nameRule={p.revisions.nameRule} />
        </div>
      ) : null}
      {f.canAct && !p.editing && p.rejecting ? (
        <RejectForm busy={p.busy} onCancel={() => p.onRejectOpen(false)} onReject={p.onReject} />
      ) : null}
      {!p.editing && !p.rejecting && (f.state === "proposed" ? f.canAct : true) ? (
        <div className="border-t px-4 py-2.5">
          <DecisionButtons
            state={f.state}
            canAct={f.canAct}
            canEdit={f.canEdit && f.state !== "rejected"}
            busy={p.busy}
            keys={p.singleKeys}
            decidedBy={f.reviewedBy ? `${f.reviewedBy}${f.reviewedAtText ? `, ${f.reviewedAtText}` : ""}` : null}
            flagged={failedCount > 0}
            label={f.title}
            onAccept={p.onAccept}
            onEdit={p.onEdit}
            onReject={() => p.onRejectOpen(true)}
            onReopen={p.onReopen}
          />
        </div>
      ) : null}
    </article>
  );
});
