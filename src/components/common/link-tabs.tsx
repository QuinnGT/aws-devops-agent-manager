import Link from "next/link";
import { cn } from "@/lib/utils";

export interface LinkTab {
  key: string;
  href: string;
  label: string;
  /** Optional count shown in a small pill ("Versions 24") */
  count?: number | string;
}

/**
 * Navigation tabs whose items are links to routes (asset page sections,
 * Plans and Drafts), styled like the shadcn Tabs line variant. The current
 * tab has aria-current="page". For in-page panels, use shadcn Tabs instead.
 */
export function LinkTabs({ items, current, label, className }: { items: readonly LinkTab[]; current: string; label: string; className?: string }) {
  return (
    <nav aria-label={label} className={cn("flex gap-1 overflow-x-auto border-b", className)}>
      {items.map((t) => {
        const active = t.key === current;
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-t-md px-2.5 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
              "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-foreground after:opacity-0",
              active && "font-semibold text-foreground after:opacity-100",
            )}
          >
            {t.label}
            {t.count !== undefined ? <span className="rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground tabular-nums">{t.count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
