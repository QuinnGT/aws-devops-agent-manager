"use client";

import type { ComponentProps } from "react";
import { Checkbox as ShadcnCheckbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

/**
 * shadcn Checkbox with a 24 px target (WCAG 2.2 target size) around the 16 px
 * box. The unchecked border is --muted-foreground, which reaches 3:1 on the
 * background and card (the default --input border does not).
 */
export function Checkbox({ className, ...props }: ComponentProps<typeof ShadcnCheckbox>) {
  return (
    <ShadcnCheckbox
      className={cn(
        // The root is the 24 px target; ::before draws the 16 px box, and the check sits above it.
        "size-6 rounded-md border-0 bg-transparent after:hidden dark:bg-transparent",
        "before:absolute before:size-4 before:rounded-[4px] before:border before:border-muted-foreground before:bg-background before:transition-colors",
        "data-checked:border-0 data-checked:bg-transparent dark:data-checked:bg-transparent data-checked:before:border-primary data-checked:before:bg-primary",
        "aria-invalid:before:border-destructive [&>[data-slot=checkbox-indicator]]:relative",
        className,
      )}
      {...props}
    />
  );
}
