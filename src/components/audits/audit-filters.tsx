"use client";

import { ChevronDown, ListFilter, Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { filterQuery } from "./list-params";

export interface FilterMenu {
  key: string;
  name: string;
  value: string;
  options: { value: string; label: string; hint?: string }[];
  icon?: boolean;
}

/**
 * A filter toolbar of radio menus ("State: Open") and a text filter, with the
 * state in the URL (MASTER "Filters"). `values` are the current URL values
 * (the text filter under "q"); keys not in `values`, such as "Show more"
 * counts, are dropped when a filter changes.
 */
export function AuditFilters({
  label,
  menus,
  values,
  defaults,
  qLabel,
  children,
}: {
  label: string;
  menus: FilterMenu[];
  values: Record<string, string>;
  defaults: Record<string, string>;
  qLabel: string;
  children?: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [, startTransition] = useTransition();
  const [text, setText] = useState(values.q ?? "");
  const last = useRef(values.q ?? "");

  const go = (patch: Record<string, string>) => startTransition(() => router.replace(`${pathname}${filterQuery({ ...values, q: last.current, ...patch }, defaults)}`, { scroll: false }));

  useEffect(() => {
    if (text === last.current) return;
    const t = setTimeout(() => {
      last.current = text.trim();
      startTransition(() => router.replace(`${pathname}${filterQuery({ ...values, q: text.trim() }, defaults)}`, { scroll: false }));
    }, 300);
    return () => clearTimeout(t);
  }, [text, pathname, router, values, defaults]);

  return (
    <div role="toolbar" aria-label={label} className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
      {children}
      {menus.map((m) => (
        <DropdownMenu key={m.key}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {m.icon ? <ListFilter aria-hidden /> : null}
              {m.name}: {m.options.find((o) => o.value === m.value)?.label ?? "All"}
              <ChevronDown aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-52">
            <DropdownMenuRadioGroup value={m.value} onValueChange={(v) => go({ [m.key]: v })}>
              {m.options.map((o) => (
                <DropdownMenuRadioItem key={o.value} value={o.value}>
                  {o.label}
                  {o.hint ? <span className="ml-auto pl-3 text-xs text-muted-foreground">{o.hint}</span> : null}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
      <InputGroup className="h-7 max-w-64 min-w-44 flex-1">
        <InputGroupAddon>
          <Search aria-hidden />
        </InputGroupAddon>
        <InputGroupInput type="search" aria-label={qLabel} placeholder={qLabel} value={text} onChange={(e) => setText(e.target.value)} />
      </InputGroup>
    </div>
  );
}
