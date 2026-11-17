"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { FileDiffView } from "@/components/assets/diff-view";
import { useWide } from "@/components/assets/view-toggle";
import { ValidationList } from "@/components/common/validation-list";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { SelectedItemView } from "@/server/plans/loaders";
import { Segmented } from "./segmented";
import { SizeMeterLine } from "./size-meter-line";
import { DiffCounts, MetadataChanges, UnifiedDiff } from "./unified-diff";
import { DIFF_NOT_READY, SYNCED_COMPARISON_NOTE } from "./words";

/** Where the item sits in the changes list, for "2 of 67" and Previous and Next (links, and the j and k keys). */
export interface ItemNav {
  position: number;
  total: number;
  prevHref: string | null;
  nextHref: string | null;
}

const navButton = buttonVariants({ variant: "outline", size: "icon-sm" });

/**
 * The selected plan item (plan-review.md, "Selected item card"): name and
 * main file, +N −M, a Content or Metadata toggle, Words, Lines or Split
 * (Split at 1024 px and up, MASTER "Diffs"), Previous and Next, the size
 * meter for instructions, and the diff of live against planned. The body
 * scrolls on its own, so the card can fill the page's review area. Before
 * the check the diff is empty because it hasn't been computed, so the card
 * says that instead of "No content change".
 */
export function SelectedItemCard({ item, notReady = DIFF_NOT_READY, nav, className }: { item: SelectedItemView; /** Shown instead of the diff before the check has compared the item */ notReady?: string; nav?: ItemNav; className?: string }) {
  const router = useRouter();
  const hasContent = item.contentDiff.length > 0;
  const firstView = (i: SelectedItemView) => (i.contentDiff.length > 0 || i.metadataDiff.length === 0 ? "content" : "metadata");
  const [view, setView] = useState<"content" | "metadata">(firstView(item));
  // The layout carries over from item to item; Content or Metadata starts again for each (adjusted during render).
  const [layout, setLayout] = useState<"words" | "lines" | "split">("words");
  const [shownId, setShownId] = useState(item.id);
  if (shownId !== item.id) {
    setShownId(item.id);
    setView(firstView(item));
  }
  const wide = useWide();
  const shownLayout = layout === "split" && !wide ? "words" : layout;
  const prev = nav?.prevHref ?? null;
  const next = nav?.nextHref ?? null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='dialog'], [role='alertdialog']")) return;
      const href = e.key === "j" ? next : e.key === "k" ? prev : null;
      if (!href) return;
      e.preventDefault();
      router.push(href, { scroll: false });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [prev, next, router]);
  const changedFiles = item.contentDiff.filter((f) => f.status !== "unchanged");
  const errors = item.validation.filter((v) => v.level === "error");
  return (
    <Card className={cn("gap-0 overflow-hidden py-0", className)} role="region" aria-labelledby="selected-item-h">
      <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
        <h2 id="selected-item-h" className="text-sm font-semibold break-all">
          {item.name}
          {item.mainFile ? <span className="font-normal text-muted-foreground"> · </span> : null}
          {item.mainFile ? <span className="font-mono text-[13px]">{item.mainFile}</span> : null}
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          {item.added || item.removed ? <DiffCounts added={item.added} removed={item.removed} /> : null}
          <Segmented
            label="Compare"
            value={view}
            onChange={setView}
            options={[
              { value: "content", label: "Content" },
              { value: "metadata", label: "Metadata" },
            ]}
          />
          {item.checked && view === "content" && changedFiles.length ? (
            <Segmented
              label="Layout"
              value={shownLayout}
              onChange={setLayout}
              options={[
                { value: "words", label: "Words", ariaLabel: "Words: changed words marked inside each line" },
                { value: "lines", label: "Lines", ariaLabel: "Lines: removed and added lines" },
                ...(wide ? [{ value: "split" as const, label: "Split", ariaLabel: "Split: live and planned side by side" }] : []),
              ]}
            />
          ) : null}
          {nav && nav.total > 1 ? (
            <span className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground tabular-nums" title="Keys: k for previous, j for next">
                {nav.position} of {nav.total}
              </span>
              <NavLink href={prev} label="Previous change (k)" className={navButton}>
                <ChevronLeft aria-hidden />
              </NavLink>
              <NavLink href={next} label="Next change (j)" className={navButton}>
                <ChevronRight aria-hidden />
              </NavLink>
            </span>
          ) : null}
        </div>
      </div>
      {/* relative: the diff's sr-only labels are absolutely positioned and would otherwise stretch the page */}
      <div key={item.id} className="relative min-h-0 flex-1 overflow-y-auto">
      {item.conflict ? <p className="border-b bg-warning/7 px-4 py-2 text-[13px]">{item.conflict.message}</p> : null}
      {item.note ? <p className="border-b px-4 py-2 text-[13px] text-muted-foreground">{item.note}</p> : null}
      {item.checked && item.comparedWith === "synced" ? <p className="border-b px-4 py-2 text-xs text-muted-foreground">{SYNCED_COMPARISON_NOTE}</p> : null}
      {!item.checked ? (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">{notReady}</p>
      ) : view === "content" ? (
        <>
          {item.sizeMeter ? <SizeMeterLine meter={item.sizeMeter} label="Size after this change" /> : null}
          {changedFiles.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted-foreground">{hasContent ? "No content change." : "No content change. Only the metadata changes."}</p>
          ) : (
            changedFiles.map((f) => (
              <div key={f.path} className="border-b last:border-b-0">
                {changedFiles.length > 1 || f.path !== item.mainFile ? (
                  <div className="flex items-center justify-between gap-2 bg-muted/40 px-4 py-1.5 text-xs">
                    <span className="font-mono">{f.path}</span>
                    <DiffCounts added={f.added} removed={f.removed} />
                  </div>
                ) : null}
                {shownLayout === "split" ? <FileDiffView file={f} layout="split" showHeader={false} /> : <UnifiedDiff file={f} words={shownLayout === "words"} />}
              </div>
            ))
          )}
        </>
      ) : (
        <MetadataChanges changes={item.metadataDiff} before={item.comparedWith === "synced" ? "Last synced" : "Live"} after="Planned" empty="No metadata change." />
      )}
      {errors.length ? <ValidationList results={item.validation} className="border-t" /> : null}
      {item.writes ? <p className="border-t px-4 py-2 text-xs text-muted-foreground">{item.writes}</p> : null}
      </div>
    </Card>
  );
}

/** Previous or Next: a link, or a disabled-looking span at either end of the list. */
function NavLink({ href, label, className, children }: { href: string | null; label: string; className: string; children: ReactNode }) {
  if (!href) {
    return (
      <span role="link" aria-disabled="true" aria-label={label} className={cn(className, "pointer-events-none opacity-50")}>
        {children}
      </span>
    );
  }
  return (
    <Link href={href} scroll={false} aria-label={label} title={label} className={className}>
      {children}
    </Link>
  );
}
