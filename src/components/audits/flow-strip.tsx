import { CircleCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { FlowStrip as FlowStripView, FlowStep } from "./flow";

/**
 * The audit's five steps in a strip (pages/audit-detail.md, "Flow strip"):
 * what is left at each, each a link to its tab or area, the current one marked.
 */
export function FlowStrip({ strip, hrefs, extra }: { strip: FlowStripView; hrefs: Record<FlowStep, string>; /** Under a step's text, for example the analyzers' progress while they run */ extra?: Partial<Record<FlowStep, ReactNode>> }) {
  return (
    <nav aria-label="Audit flow">
      <ol className="grid grid-cols-1 overflow-hidden rounded-xl border bg-card sm:grid-cols-3 xl:grid-cols-5">
        {strip.cells.map((c) => {
          const current = strip.current === c.step;
          return (
            <li key={c.step} className="-mr-px -mb-px border-r border-b">
              <Link
                href={hrefs[c.step]}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "block h-full space-y-0.5 px-3.5 py-2.5 outline-offset-[-2px] transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring",
                  current && "shadow-[inset_0_-2px_0_var(--foreground)]",
                )}
              >
                <span className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  {c.label}
                  {c.done ? (
                    <>
                      <CircleCheck className="size-3.5 text-success-fg" aria-hidden />
                      <span className="sr-only">(done)</span>
                    </>
                  ) : null}
                  {current ? <span className="sr-only">(current step)</span> : null}
                </span>
                <span className={cn("block text-[13px]", !current && !c.done && "text-muted-foreground")}>
                  {c.value.strong ? <b className="font-semibold">{c.value.strong}</b> : null}
                  {c.value.rest}
                </span>
                {c.detail ? <span className={cn("block text-xs", c.tone === "warning" ? "text-warning-fg" : "text-muted-foreground")}>{c.detail}</span> : null}
              </Link>
              {extra?.[c.step] ? <div className="px-3.5 pb-2.5">{extra[c.step]}</div> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
