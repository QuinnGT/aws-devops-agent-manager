"use client";

import { ChevronDown, EyeOff, Lock, Users } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { StatusBadge } from "@/components/common/status-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Audience } from "@/server/audit-reports";
import { AUDIENCE_LABELS, sectionAnchor } from "./words";

/** The audience badge: neutral, Users for shareable, Lock for internal. */
export function AudienceBadge({ audience }: { audience: Audience }) {
  return <StatusBadge tone="neutral" icon={audience === "shareable" ? Users : Lock} label={AUDIENCE_LABELS[audience]} />;
}

export interface SectionCardProps {
  sectionId: string;
  number: number;
  title: string;
  audience: Audience;
  hidden: boolean;
  /** The muted line under the header (kind, source, who and when) */
  meta?: ReactNode;
  /** Ghost buttons on the right of the header */
  actions?: ReactNode;
  /** A body that starts collapsed, with the toggle in the header ("Show 16 incidents") */
  collapsed?: { show: string; hide: string };
  children?: ReactNode;
}

/**
 * One report section (pages/audit-report.md, "Section card"): the section
 * number, h2 title, audience and Hidden badges, actions on the right, a meta
 * row, then the body. The card's id is the anchor the export dialog links to.
 */
export function ReportSectionCard({ sectionId, number, title, audience, hidden, meta, actions, collapsed, children }: SectionCardProps) {
  const headingId = useId();
  const bodyId = useId();
  const [open, setOpen] = useState(!collapsed);
  const body = collapsed ? (open ? children : null) : children;
  return (
    <Card id={sectionAnchor(sectionId)} role="region" aria-labelledby={headingId} className="scroll-mt-20 gap-0 overflow-hidden py-0">
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground tabular-nums">{number}</span>
          <h2 id={headingId} tabIndex={-1} className={cn("text-sm font-semibold outline-none", hidden && "text-muted-foreground")}>
            {title}
          </h2>
          <AudienceBadge audience={audience} />
          {hidden ? <StatusBadge tone="neutral" icon={EyeOff} label="Hidden" /> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {collapsed && !hidden ? (
            <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
              <ChevronDown aria-hidden className={cn("motion-safe:transition-transform motion-safe:duration-150", open && "rotate-180")} />
              {open ? collapsed.hide : collapsed.show}
            </Button>
          ) : null}
          {actions}
        </div>
      </div>
      {meta ? <div className={cn("flex flex-wrap gap-x-3 gap-y-0.5 px-4 py-2 text-xs text-muted-foreground", body ? "border-b" : null)}>{meta}</div> : null}
      <div id={bodyId}>{body}</div>
    </Card>
  );
}
