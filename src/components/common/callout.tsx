import { CircleCheck, CircleX, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export type CalloutTone = "info" | "warning" | "destructive" | "success";

const TONE: Record<CalloutTone, { icon: LucideIcon; box: string; icon_: string }> = {
  info: { icon: Info, box: "border-info/40 bg-info/7", icon_: "text-info-fg" },
  warning: { icon: TriangleAlert, box: "border-warning/40 bg-warning/7", icon_: "text-warning-fg" },
  destructive: { icon: CircleX, box: "border-destructive/40 bg-destructive/7", icon_: "text-destructive-fg" },
  success: { icon: CircleCheck, box: "border-success/40 bg-success/7", icon_: "text-success-fg" },
};

/**
 * An attention message on shadcn Alert: icon in the tone's -fg color, 7% tint,
 * 40% border, one optional action. `role="status"` unless `afterAction` is
 * set (the callout appeared because of something the user just did), which
 * uses `role="alert"`. `details` (optional) is support text, such as the raw
 * error behind a plain sentence, in a muted "Details" disclosure.
 */
export function Callout({
  tone,
  title,
  children,
  action,
  afterAction = false,
  details,
  className,
}: {
  tone: CalloutTone;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  afterAction?: boolean;
  /** Raw text for support (an error's own message, an ID), shown collapsed under "Details" */
  details?: ReactNode;
  className?: string;
}) {
  const t = TONE[tone];
  const Icon = t.icon;
  return (
    <Alert
      role={afterAction ? "alert" : "status"}
      className={cn(
        "gap-y-1 px-3.5 py-2.5 text-[13px] text-foreground has-data-[slot=alert-action]:pr-3.5 sm:has-data-[slot=alert-action]:grid-cols-[auto_1fr_auto]",
        t.box,
        className,
      )}
    >
      <Icon className={cn(t.icon_)} aria-hidden />
      <AlertTitle className="font-semibold">{title}</AlertTitle>
      {children ? <AlertDescription className="col-start-2 text-[13px] text-foreground">{children}</AlertDescription> : null}
      {details ? (
        <details className="col-start-2 text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer underline-offset-4 hover:text-foreground hover:underline">Details</summary>
          <p className="mt-1 font-mono break-words whitespace-pre-wrap">{details}</p>
        </details>
      ) : null}
      {action ? (
        <AlertAction className="static col-start-2 mt-1 sm:col-start-3 sm:row-span-2 sm:row-start-1 sm:mt-0 sm:self-center">{action}</AlertAction>
      ) : null}
    </Alert>
  );
}
