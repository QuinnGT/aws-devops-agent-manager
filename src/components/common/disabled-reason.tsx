import { Lock } from "lucide-react";
import { Children, cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Renders its one child (a button) disabled with the reason next to it, linked
 * by aria-describedby. Every disabled control says why (MASTER "Principles").
 */
export function DisabledReason({ reason, children, className }: { reason: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  const child = Children.only(children);
  if (!isValidElement(child)) throw new Error("DisabledReason needs one element child");
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", className)}>
      {cloneElement(child as ReactElement<{ disabled?: boolean; "aria-describedby"?: string }>, { disabled: true, "aria-describedby": id })}
      <span id={id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Lock className="size-3.5 shrink-0" aria-hidden />
        {reason}
      </span>
    </div>
  );
}
