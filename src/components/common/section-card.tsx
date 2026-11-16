import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** A Card with the spec's header bar: 48 px minimum, 16 px side padding, bottom border, h2 title and an optional right side. */
export function SectionCard({ id, title, aside, children, className }: { id: string; title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cn("gap-0 py-0", className)} aria-labelledby={id} role="region">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2">
        <h2 id={id} className="text-sm font-semibold">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </Card>
  );
}
