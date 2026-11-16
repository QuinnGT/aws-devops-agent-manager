"use client";

import { ChevronDown, ListFilter, Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ORIGIN_OPTIONS, type PlanListParams, planListQuery, STATUS_OPTIONS } from "./list-params";

/**
 * Filter toolbar of the plans list (pages/plans.md, "Filters"): Status and
 * Origin menus and a title filter. State lives in the URL; changing a filter
 * resets "Show more".
 */
export function PlanFilters({ value }: { value: PlanListParams }) {
  const router = useRouter();
  const pathname = usePathname();
  const [, startTransition] = useTransition();
  const [q, setQ] = useState(value.q);
  const lastPushed = useRef(value.q);

  const go = (patch: Partial<PlanListParams>) => {
    const next = { ...value, q: lastPushed.current, show: 0, ...patch };
    startTransition(() => router.replace(`${pathname}${planListQuery(next)}`, { scroll: false }));
  };

  // Title filter: update the URL 300 ms after the last keystroke.
  useEffect(() => {
    if (q === lastPushed.current) return;
    const t = setTimeout(() => {
      lastPushed.current = q.trim();
      startTransition(() => router.replace(`${pathname}${planListQuery({ ...value, q: q.trim(), show: 0 })}`, { scroll: false }));
    }, 300);
    return () => clearTimeout(t);
  }, [q, pathname, router, value]);

  const statusLabel = STATUS_OPTIONS.find((o) => o.value === value.status)?.label ?? "Open";
  const originLabel = ORIGIN_OPTIONS.find((o) => o.value === value.origin)?.label ?? "All";

  return (
    <div role="toolbar" aria-label="Filter plans" className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <ListFilter aria-hidden />
            Status: {statusLabel}
            <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56">
          <DropdownMenuRadioGroup value={value.status} onValueChange={(v) => go({ status: v as PlanListParams["status"] })}>
            {STATUS_OPTIONS.map((o) => (
              <DropdownMenuRadioItem key={o.value} value={o.value}>
                {o.label}
                <span className="ml-auto pl-3 text-xs text-muted-foreground">
                  {o.value === "open" ? "Checking to applying" : o.value === "closed" ? "Applied, failed, discarded" : null}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            Origin: {originLabel}
            <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-48">
          <DropdownMenuRadioGroup value={value.origin} onValueChange={(v) => go({ origin: v as PlanListParams["origin"] })}>
            {ORIGIN_OPTIONS.map((o) => (
              <DropdownMenuRadioItem key={o.value} value={o.value}>
                {o.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <InputGroup className="h-7 max-w-64 min-w-44 flex-1">
        <InputGroupAddon>
          <Search aria-hidden />
        </InputGroupAddon>
        <InputGroupInput type="search" aria-label="Filter by plan title" placeholder="Filter by plan title" value={q} onChange={(e) => setQ(e.target.value)} />
      </InputGroup>
    </div>
  );
}
