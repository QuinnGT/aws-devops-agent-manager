"use client";

import { ChevronDown } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { FileShow } from "./views";

/**
 * "Needs a look <n>" or "All <n>", and the Type filter, for the agent-read
 * table. Both live in the URL (`?files=all`, `?type=skill`) so links and Back
 * keep them (MASTER "Filters").
 */
export function FileFilters({ show, look, all, type, types }: { show: FileShow; look: number; all: number; type: string | null; types: { value: string; label: string }[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const go = (key: "files" | "type", value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const q = next.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };
  const typeLabel = types.find((t) => t.value === type)?.label ?? "All";
  return (
    <div role="toolbar" aria-label="Filter files" className="flex flex-wrap items-center gap-2 px-4 py-2">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        value={show}
        onValueChange={(v) => (v === "look" || v === "all" ? go("files", v === "all" ? "all" : null) : undefined)}
        aria-label="Files to show"
      >
        <ToggleGroupItem value="look" className="tabular-nums data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
          Needs a look {look}
        </ToggleGroupItem>
        <ToggleGroupItem value="all" className="tabular-nums data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
          All {all}
        </ToggleGroupItem>
      </ToggleGroup>
      {types.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              Type: {typeLabel}
              <ChevronDown aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-40">
            <DropdownMenuRadioGroup value={type ?? ""} onValueChange={(v) => go("type", v || null)}>
              <DropdownMenuRadioItem value="">All</DropdownMenuRadioItem>
              {types.map((t) => (
                <DropdownMenuRadioItem key={t.value} value={t.value}>
                  {t.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
