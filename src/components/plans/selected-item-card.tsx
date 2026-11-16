"use client";

import { useState } from "react";
import { FileDiffView } from "@/components/assets/diff-view";
import { useWide } from "@/components/assets/view-toggle";
import { ValidationList } from "@/components/common/validation-list";
import { Card } from "@/components/ui/card";
import type { SelectedItemView } from "@/server/plans/loaders";
import { Segmented } from "./segmented";
import { SizeMeterLine } from "./size-meter-line";
import { DiffCounts, MetadataChanges, UnifiedDiff } from "./unified-diff";
import { DIFF_NOT_READY, SYNCED_COMPARISON_NOTE } from "./words";

/**
 * The selected plan item (plan-review.md, "Selected item card"): name and
 * main file, +N −M, a Content or Metadata toggle, Unified or Split (at
 * 1024 px and up, MASTER "Diffs"), the size meter for instructions, and the
 * diff of live against planned. Before the check the
 * diff is empty because it hasn't been computed, so the card says that
 * instead of "No content change".
 */
export function SelectedItemCard({ item, notReady = DIFF_NOT_READY }: { item: SelectedItemView; /** Shown instead of the diff before the check has compared the item */ notReady?: string }) {
  const hasContent = item.contentDiff.length > 0;
  const [view, setView] = useState<"content" | "metadata">(hasContent || item.metadataDiff.length === 0 ? "content" : "metadata");
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const wide = useWide();
  const changedFiles = item.contentDiff.filter((f) => f.status !== "unchanged");
  const errors = item.validation.filter((v) => v.level === "error");
  return (
    <Card className="gap-0 py-0" role="region" aria-labelledby="selected-item-h">
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-3 border-b px-4 py-2">
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
          {wide && item.checked && view === "content" && changedFiles.length ? (
            <Segmented
              label="Layout"
              value={layout}
              onChange={setLayout}
              options={[
                { value: "unified", label: "Unified" },
                { value: "split", label: "Split" },
              ]}
            />
          ) : null}
        </div>
      </div>
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
                {wide && layout === "split" ? <FileDiffView file={f} layout="split" showHeader={false} /> : <UnifiedDiff file={f} />}
              </div>
            ))
          )}
        </>
      ) : (
        <MetadataChanges changes={item.metadataDiff} before={item.comparedWith === "synced" ? "Last synced" : "Live"} after="Planned" empty="No metadata change." />
      )}
      {errors.length ? <ValidationList results={item.validation} className="border-t" /> : null}
      {item.writes ? <p className="border-t px-4 py-2 text-xs text-muted-foreground">{item.writes}</p> : null}
    </Card>
  );
}
