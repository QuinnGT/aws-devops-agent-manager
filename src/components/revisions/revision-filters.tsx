"use client";

import { ChevronDown, ListFilter, Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { revisionListQuery, STATE_FILTERS, type RevisionListParams, type StateFilter } from "./words";

/**
 * Filter toolbar of the revisions list (pages/revisions.md): a State menu
 * (Open by default) and a name filter. State lives in the URL.
 */
export function RevisionFilters({ value }: { value: RevisionListParams }) {
  const router = useRouter();
  const pathname = usePathname();
  const [, startTransition] = useTransition();
  const [q, setQ] = useState(value.q);
  const lastPushed = useRef(value.q);

  useEffect(() => {
    if (q === lastPushed.current) return;
    const t = setTimeout(() => {
      lastPushed.current = q.trim();
      startTransition(() => router.replace(`${pathname}${revisionListQuery({ ...value, q: q.trim() })}`, { scroll: false }));
    }, 300);
    return () => clearTimeout(t);
  }, [q, pathname, router, value]);

  const label = STATE_FILTERS.find((o) => o.value === value.state)?.label ?? "Open";
  return (
    <div role="toolbar" aria-label="Filter revisions" className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <ListFilter aria-hidden />
            State: {label}
            <ChevronDown aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56">
          <DropdownMenuRadioGroup
            value={value.state}
            onValueChange={(v) => startTransition(() => router.replace(`${pathname}${revisionListQuery({ ...value, q: lastPushed.current, state: v as StateFilter })}`, { scroll: false }))}
          >
            {STATE_FILTERS.map((o) => (
              <DropdownMenuRadioItem key={o.value} value={o.value}>
                {o.label}
                {o.hint ? <span className="ml-auto pl-3 text-xs text-muted-foreground">{o.hint}</span> : null}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <InputGroup className="h-7 max-w-64 min-w-44 flex-1">
        <InputGroupAddon>
          <Search aria-hidden />
        </InputGroupAddon>
        <InputGroupInput type="search" aria-label="Filter by revision name" placeholder="Filter by revision name" value={q} onChange={(e) => setQ(e.target.value)} />
      </InputGroup>
    </div>
  );
}
