import type { ReactNode } from "react";
import { SectionCard } from "@/components/common/section-card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FormMessage } from "./field";
import type { FormState } from "./form-state";

/** A settings section: SectionCard with an optional description line above its body. */
export function SettingsCard({
  id,
  title,
  aside,
  description,
  children,
  className,
}: {
  id: string;
  title: ReactNode;
  aside?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <SectionCard id={id} title={title} aside={aside} className={cn("scroll-mt-16", className)}>
      {description ? <p className="max-w-[72ch] px-4 pt-3 text-[13px] text-muted-foreground">{description}</p> : null}
      {children}
    </SectionCard>
  );
}

/** The bottom of a section's form: the rejected-save callout, then the section's one Save button. */
export function SaveBar({ state, pending, label, pendingLabel = "Saving…" }: { state: FormState; pending: boolean; label: string; pendingLabel?: string }) {
  return (
    <div className="space-y-3 border-t px-4 py-3">
      <FormMessage state={state} />
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? pendingLabel : label}
      </Button>
    </div>
  );
}
