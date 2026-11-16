import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** What will appear here and how to get it: a bold title, one or two sentences, and one action if the user can act. */
export function EmptyState({ title, children, action, className }: { title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-start gap-2 px-4 py-3.5 text-[13px] text-muted-foreground", className)}>
      <p className="font-semibold text-foreground">{title}</p>
      {children ? <div className="max-w-[72ch]">{children}</div> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
