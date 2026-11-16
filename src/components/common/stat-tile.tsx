import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** A status number with a 12 px label, 22 px value, 12 px detail and an optional small action. */
export function StatTile({
  icon,
  label,
  value,
  detail,
  action,
  className,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("gap-0.5 px-3.5 py-3", className)}>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5">
        <span aria-hidden className="contents">
          {icon}
        </span>
        {label}
      </p>
      <div className="flex items-center gap-2 text-[22px] leading-tight font-semibold tracking-tight tabular-nums [&_svg]:size-4.5">{value}</div>
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
      {action ? <div className="mt-1.5">{action}</div> : null}
    </Card>
  );
}
