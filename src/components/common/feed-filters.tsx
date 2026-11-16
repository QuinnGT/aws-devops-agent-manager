"use client";

import { Calendar, ChevronDown, ListFilter, Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { FEED_RANGES, type FeedFilterState, type FeedRange } from "./feed-params";

interface Option {
  value: string;
  label: string;
}

function summary(name: string, selected: readonly string[], options: readonly Option[]): string {
  if (selected.length === 0) return `${name}: All`;
  if (selected.length === 1) return `${name}: ${options.find((o) => o.value === selected[0])?.label ?? selected[0]}`;
  return `${name}: ${selected.length} selected`;
}

/** A "Name: All" checkbox menu for a filter toolbar. Also used by the audit log filters. */
export function MultiSelect({
  name,
  icon,
  options,
  selected,
  onChange,
  contentClassName,
}: {
  name: string;
  icon?: ReactNode;
  options: readonly Option[];
  selected: string[];
  onChange: (v: string[]) => void;
  /** Extra classes for the menu, for example a wider one for long option labels */
  contentClassName?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          {icon}
          {summary(name, selected, options)}
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={cn("min-w-48", contentClassName)}>
        <DropdownMenuItem disabled={selected.length === 0} onSelect={() => onChange([])}>
          Show all
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.value}
            checked={selected.includes(o.value)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(on) => onChange(on ? [...selected, o.value] : selected.filter((s) => s !== o.value))}
          >
            {o.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const NO_PARAMS: readonly string[] = [];

/**
 * Filter toolbar for ChangeFeed: Source and Type checkbox menus, a date range
 * and a name filter. State lives in the URL (feed-params.ts), so links and
 * Back keep it; other search params are left alone.
 */
export function FeedFilters({
  value,
  sources,
  types,
  resetParams = NO_PARAMS,
}: {
  value: FeedFilterState;
  sources: readonly Option[];
  types: readonly Option[];
  /** Params removed whenever a filter changes, such as History's `page` */
  resetParams?: readonly string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const [q, setQ] = useState(value.q);
  const lastPushed = useRef(value.q);

  const apply = (patch: Partial<Record<"source" | "type" | "range" | "q", string>>) => {
    const next = new URLSearchParams(params.toString());
    for (const k of resetParams) next.delete(k);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const qs = next.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  };

  // Name filter: update the URL 300 ms after the last keystroke.
  useEffect(() => {
    if (q === lastPushed.current) return;
    const t = setTimeout(() => {
      lastPushed.current = q;
      const next = new URLSearchParams(window.location.search);
      for (const k of resetParams) next.delete(k);
      if (q.trim()) next.set("q", q.trim());
      else next.delete("q");
      const qs = next.toString();
      startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
    }, 300);
    return () => clearTimeout(t);
  }, [q, pathname, router, resetParams]);

  const rangeLabel = FEED_RANGES.find((r) => r.value === value.range)?.label ?? "All time";

  return (
    <div role="toolbar" aria-label="Filter changes" className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
      <MultiSelect name="Source" icon={<ListFilter aria-hidden />} options={sources} selected={value.sources} onChange={(v) => apply({ source: v.join(",") })} />
      <MultiSelect name="Type" options={types} selected={value.types} onChange={(v) => apply({ type: v.join(",") })} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <Calendar aria-hidden />
            {rangeLabel}
            <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup value={value.range} onValueChange={(v) => apply({ range: v as FeedRange })}>
            {FEED_RANGES.map((r) => (
              <DropdownMenuRadioItem key={r.value} value={r.value}>
                {r.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <InputGroup className="h-7 max-w-64 min-w-44 flex-1">
        <InputGroupAddon>
          <Search aria-hidden />
        </InputGroupAddon>
        <InputGroupInput type="search" aria-label="Filter by asset name" placeholder="Filter by asset name" value={q} onChange={(e) => setQ(e.target.value)} />
      </InputGroup>
    </div>
  );
}
