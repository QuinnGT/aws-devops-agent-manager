"use client";

import type { ReactNode } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

/**
 * A joined single-choice ToggleGroup (Content or Metadata, Mine or Everyone,
 * file paths), with the chosen item filled in primary.
 * One value is always chosen.
 */
export function Segmented<V extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: V;
  onChange: (v: V) => void;
  options: readonly { value: V; label: ReactNode; ariaLabel?: string }[];
  label: string;
  className?: string;
}) {
  return (
    <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={value} onValueChange={(v) => v && onChange(v as V)} aria-label={label} className={cn("max-w-full flex-wrap", className)}>
      {options.map((o) => (
        <ToggleGroupItem
          key={o.value}
          value={o.value}
          aria-label={o.ariaLabel}
          className="h-7 text-[13px] font-normal data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
        >
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
