"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { MultiSelect } from "@/components/common/feed-filters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";

interface Option {
  value: string;
  label: string;
}

export interface AuditFilterValues {
  space: string[];
  action: string[];
  result: string[];
  actor: string;
  target: string;
  from: string;
  to: string;
}

type Key = keyof AuditFilterValues;

/** Debounced text filter: updates the URL 300 ms after the last keystroke. */
function useDebouncedParam(initial: string, push: (v: string) => void) {
  const [value, setValue] = useState(initial);
  const last = useRef(initial);
  useEffect(() => {
    if (value === last.current) return;
    const t = setTimeout(() => {
      last.current = value;
      push(value.trim());
    }, 300);
    return () => clearTimeout(t);
  }, [value, push]);
  return [value, setValue] as const;
}

/**
 * Audit log filter toolbar. Every filter lives in the URL, so links, Back and
 * the export buttons keep it; changing one drops "Show more" back to the
 * first page.
 */
export function AuditFilters({ value, spaces, actions, results }: { value: AuditFilterValues; spaces: Option[]; actions: Option[]; results: Option[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const [, startTransition] = useTransition();

  const apply = useCallback(
    (patch: Partial<Record<Key, string>>) => {
      const next = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      next.delete("show");
      next.delete("before");
      const qs = next.toString();
      startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
    },
    [router, pathname],
  );
  const pushActor = useCallback((v: string) => apply({ actor: v }), [apply]);
  const pushTarget = useCallback((v: string) => apply({ target: v }), [apply]);
  const [actor, setActor] = useDebouncedParam(value.actor, pushActor);
  const [target, setTarget] = useDebouncedParam(value.target, pushTarget);

  const any = value.space.length + value.action.length + value.result.length > 0 || value.actor || value.target || value.from || value.to;

  return (
    <div role="toolbar" aria-label="Filter events" className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
      {spaces.length > 1 ? <MultiSelect name="Space" options={spaces} selected={value.space} onChange={(v) => apply({ space: v.join(",") })} /> : null}
      <MultiSelect
        name="Action"
        options={actions}
        selected={value.action}
        onChange={(v) => apply({ action: v.join(",") })}
        contentClassName="w-auto [&_[role=menuitemcheckbox]]:font-mono [&_[role=menuitemcheckbox]]:text-xs"
      />
      <MultiSelect name="Result" options={results} selected={value.result} onChange={(v) => apply({ result: v.join(",") })} />
      <InputGroup className="h-7 max-w-56 min-w-40 flex-1">
        <InputGroupAddon>
          <Search aria-hidden />
        </InputGroupAddon>
        <InputGroupInput type="search" aria-label="Filter by actor" placeholder="Actor" value={actor} onChange={(e) => setActor(e.target.value)} />
      </InputGroup>
      <InputGroup className="h-7 max-w-56 min-w-40 flex-1">
        <InputGroupAddon>
          <Search aria-hidden />
        </InputGroupAddon>
        <InputGroupInput type="search" aria-label="Filter by target" placeholder="Target" value={target} onChange={(e) => setTarget(e.target.value)} />
      </InputGroup>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground" role="group" aria-label="Date range">
        <label htmlFor="audit-from">From</label>
        <Input id="audit-from" type="date" className="h-7 w-36 text-xs md:text-xs dark:scheme-dark" value={value.from} max={value.to || undefined} onChange={(e) => apply({ from: e.target.value })} />
        <label htmlFor="audit-to">to</label>
        <Input id="audit-to" type="date" className="h-7 w-36 text-xs md:text-xs dark:scheme-dark" value={value.to} min={value.from || undefined} onChange={(e) => apply({ to: e.target.value })} />
      </div>
      {any ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setActor("");
            setTarget("");
            startTransition(() => router.replace(pathname, { scroll: false }));
          }}
        >
          <X aria-hidden />
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
