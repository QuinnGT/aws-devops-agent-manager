"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { FEED_ROW, FEED_SLOTS } from "./feed-layout";

/** A grouped feed row whose "Show all N" button expands the member rows inline. */
export function FeedGroupRow({ source, main, time, count, children }: { source: ReactNode; main: ReactNode; time: ReactNode; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className={FEED_ROW}>
        <div className={FEED_SLOTS.source}>{source}</div>
        <div className={FEED_SLOTS.main}>{main}</div>
        <div className={FEED_SLOTS.time}>{time}</div>
        <div className={FEED_SLOTS.actions}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm">
              {open ? "Show fewer" : `Show all ${count}`}
            </Button>
          </CollapsibleTrigger>
        </div>
      </div>
      <CollapsibleContent className="border-l-2 border-border bg-muted/40">{children}</CollapsibleContent>
    </Collapsible>
  );
}
