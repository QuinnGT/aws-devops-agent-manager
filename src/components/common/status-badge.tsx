import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { StatusTone } from "./status-words";

/** 12% tint, 45% border and -fg text per tone; neutral is a plain outline. Literal classes so Tailwind finds them. */
const TONE: Record<StatusTone, string> = {
  neutral: "border-border bg-transparent text-muted-foreground",
  info: "border-info/45 bg-info/12 text-info-fg",
  success: "border-success/45 bg-success/12 text-success-fg",
  warning: "border-warning/45 bg-warning/12 text-warning-fg",
  destructive: "border-destructive/45 bg-destructive/12 text-destructive-fg",
};

/**
 * A status word with its icon on shadcn Badge (plan states, validation,
 * connection). Use the presets in ./status-words: `<StatusBadge {...STATUS.applied} />`.
 */
export function StatusBadge({ tone, icon: Icon, label, className }: { tone: StatusTone; icon?: LucideIcon; label: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn("h-[22px] gap-1 px-2 font-medium", TONE[tone], className)}>
      {Icon ? <Icon aria-hidden /> : null}
      {label}
    </Badge>
  );
}
