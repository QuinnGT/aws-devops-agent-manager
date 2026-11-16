"use client";

import { Calendar, ChevronDown, ListFilter, Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { createdLabel } from "./filters";

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterMenuSpec {
  /** URL search param, written as a comma-separated list */
  param: string;
  name: string;
  options: FilterOption[];
  selected: string[];
}

function summary(name: string, selected: readonly string[], options: readonly FilterOption[]): string {
  if (selected.length === 0) return `${name}: All`;
  if (selected.length === 1) return `${name}: ${options.find((o) => o.value === selected[0])?.label ?? selected[0]}`;
  return `${name}: ${selected.length} selected`;
}

function MultiSelect({ spec, first, onChange }: { spec: FilterMenuSpec; first: boolean; onChange: (v: string[]) => void }) {
  const { name, options, selected } = spec;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          {first ? <ListFilter aria-hidden /> : null}
          {summary(name, selected, options)}
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        <DropdownMenuItem disabled={selected.length === 0} onSelect={() => onChange([])}>
          Show all
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {options.length === 0 ? <DropdownMenuItem disabled>No values cached yet</DropdownMenuItem> : null}
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

function DateRange({ from, to, onApply }: { from: string | null; to: string | null; onApply: (from: string, to: string) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(from ?? "");
  const [t, setT] = useState(to ?? "");
  const id = useId();
  const invalid = f && t && f > t;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setF(from ?? "");
          setT(to ?? "");
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Calendar aria-hidden />
          {createdLabel(from, to)}
          <ChevronDown aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (invalid) return;
            onApply(f, t);
            setOpen(false);
          }}
        >
          <p className="text-xs text-muted-foreground">Days are in your time zone. Leave a field empty for no limit.</p>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor={`${id}-from`}>From</Label>
              <Input id={`${id}-from`} type="date" value={f} onChange={(e) => setF(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-to`}>To</Label>
              <Input id={`${id}-to`} type="date" value={t} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-err` : undefined} onChange={(e) => setT(e.target.value)} />
            </div>
          </div>
          {invalid ? (
            <p id={`${id}-err`} role="alert" className="text-xs text-destructive-fg">
              Choose a To day on or after the From day.
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onApply("", "");
                setOpen(false);
              }}
            >
              Any time
            </Button>
            <Button type="submit" size="sm">
              Apply
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Filter toolbar for the journals and analysis lists: checkbox menus, an
 * optional created range and a text filter. State lives in the URL; any change
 * goes back to page 1 and leaves other params alone.
 */
export function FilterToolbar({
  label,
  menus,
  dates,
  search,
}: {
  label: string;
  menus: FilterMenuSpec[];
  dates?: { from: string | null; to: string | null };
  search: { value: string; label: string };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const [q, setQ] = useState(search.value);
  const lastPushed = useRef(search.value);

  const go = (next: URLSearchParams) => {
    next.delete("page");
    const qs = next.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  };
  const apply = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    go(next);
  };

  // Text filter: update the URL 300 ms after the last keystroke.
  useEffect(() => {
    if (q === lastPushed.current) return;
    const t = setTimeout(() => {
      lastPushed.current = q;
      const next = new URLSearchParams(window.location.search);
      if (q.trim()) next.set("q", q.trim());
      else next.delete("q");
      go(next);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const filtered = menus.some((m) => m.selected.length) || !!dates?.from || !!dates?.to || !!search.value;

  return (
    <div role="toolbar" aria-label={label} className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
      {menus.map((m, i) => (
        <MultiSelect key={m.param} spec={m} first={i === 0} onChange={(v) => apply({ [m.param]: v.join(",") })} />
      ))}
      {dates ? <DateRange from={dates.from} to={dates.to} onApply={(from, to) => apply({ from, to })} /> : null}
      <InputGroup className="h-7 max-w-80 min-w-56 flex-1">
        <InputGroupAddon>
          <Search aria-hidden />
        </InputGroupAddon>
        <InputGroupInput type="search" aria-label={search.label} placeholder={search.label} value={q} onChange={(e) => setQ(e.target.value)} />
      </InputGroup>
      {filtered ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const next = new URLSearchParams(params.toString());
            for (const m of menus) next.delete(m.param);
            for (const k of ["from", "to", "q"]) next.delete(k);
            lastPushed.current = "";
            setQ("");
            go(next);
          }}
        >
          <X aria-hidden />
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
